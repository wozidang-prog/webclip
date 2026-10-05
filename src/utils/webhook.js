/**
 * webhook 通知：抓取完成后把结果 POST 出去。
 *
 * 为什么需要按格式区分：各平台报文长得完全不一样 ——
 *   json     （默认）完整 JSON，另带一个 text 摘要字段，适合自建/ n8n / Home Assistant
 *   text     {"text": "..."}           —— Slack、多数自建端点
 *   slack    {"text": "..."}           —— 同 text
 *   synology {"text": "..."}           —— 群晖 Chat（DSM 的 Chat 套件，incoming webhook）
 *   feishu   {"msgtype":"text","content":{"text":"..."}}   —— 飞书自定义机器人
 *   dingtalk {"msgtype":"text","text":{"content":"..."}}   —— 钉钉（企业微信同构）
 *   wecom    {"msgtype":"text","text":{"content":"..."}}   —— 企业微信
 *
 * 注意：群晖 Chat 的 incoming webhook **只能发文本**（不能通过它上传文件），
 * 所以消息里带的是每个媒体的下载直链 —— 手机上点一下就能看/存。
 */
import https from 'node:https';
import http from 'node:http';
import { config } from '../config.js';
import { logger } from './logger.js';

const log = logger.child({ mod: 'webhook' });

/**
 * 各平台**单条**消息的字数上限（保守取值）。
 * 群晖 Chat 实测约 2000 字（1990 过、2043 就被回 {"code":410,"errors":"msg too long"}），
 * 所以这里留出余量取 1900；超过就自动分条发送（不再截断内容）。
 */
const FORMAT_TEXT_LIMIT = {
  synology: 1900,
  wecom: 2000,
  feishu: 3000,
  dingtalk: 3000,
  slack: 3000,
  text: 3000,
  json: 3000,
};

/** 单条消息的字数上限（WEBHOOK_MAX_CHARS 可覆盖） */
export function webhookTextLimit(format = config.webhook.format) {
  const override = Number(config.webhook.maxChars);
  if (Number.isFinite(override) && override > 0) return override;
  return FORMAT_TEXT_LIMIT[format] || 3000;
}

/**
 * 按行把长消息切成多条，每条不超过上限；**不切断行**（下载链接必须完整）。
 * 多条时每段开头加「（i/N）」标记，方便在聊天里按顺序看。
 */
export function splitWebhookText(text, limit) {
  const source = String(text || '');
  const lines = source.split('\n');
  const markerReserve = 16; // 给「（12/34）」这类标记留的余量
  const budget = Math.max(200, limit - markerReserve);
  const chunks = [];
  let current = [];
  let currentLength = 0;

  for (const line of lines) {
    const lineLength = line.length + 1;
    if (lineLength > budget) {
      // 单行就超长（比如带中文的下载直链）：硬截断，至少别让整条发不出去
      if (current.length) {
        chunks.push(current);
        current = [];
        currentLength = 0;
      }
      chunks.push([`${line.slice(0, budget - 1)}…`]);
      continue;
    }
    if (current.length && currentLength + lineLength > budget) {
      chunks.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(line);
    currentLength += lineLength;
  }
  if (current.length) chunks.push(current);
  if (chunks.length <= 1) return { parts: [source], limit };
  return {
    parts: chunks.map((chunk, index) => `（${index + 1}/${chunks.length}）\n${chunk.join('\n')}`),
    limit,
  };
}

/**
 * POST 一个 JSON。
 * 默认走 fetch（校验证书）；`WEBHOOK_TLS_VERIFY=false` 时改用 node:https 并关掉证书校验 ——
 * 群晖/NAS 常挂自签名证书，fetch 在那种地址上只会报 UNABLE_TO_VERIFY_LEAF_SIGNATURE。
 */
function postJson(url, { contentType, body }, { headers = {}, timeoutMs = 10000, tlsVerify = true } = {}) {
  const payload = body;
  if (tlsVerify || !/^https:/i.test(url)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, {
      method: 'POST',
      headers: { 'content-type': contentType, ...headers },
      body: payload,
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
  }

  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = https.request(
      {
        host: target.hostname,
        port: target.port || 443,
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        rejectUnauthorized: false,
        timeout: timeoutMs,
        headers: {
          'content-type': contentType,
          'content-length': Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            text: async () => Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('webhook 请求超时')));
    req.write(payload);
    req.end();
  });
}

/** 消息里最多列多少个下载地址（太长会被聊天平台截断） */
const MAX_LINK_LINES = 30;
/** 组装阶段的总长度上限：真正的平台限制由 splitWebhookText 分条处理，这里只防病态输入 */
const MAX_TEXT_CHARS = 8000;

/** 把一次抓取结果整理成"消息 + 结构化数据" */
export function buildWebhookPayload(result, { event = 'convert.finished' } = {}) {
  const media = Array.isArray(result?.media) ? result.media : [];
  const videos = media.filter((m) => m.kind === 'video');
  const images = media.filter((m) => m.kind === 'image');
  const audios = media.filter((m) => m.kind === 'audio');
  const totalBytes = media.reduce((sum, m) => sum + (m.bytes || 0), 0);
  const sourceUrl = result?.finalUrl || result?.url || '';

  const lines = [
    `【WebClip】${result?.title || '(无标题)'}`,
    `来源：${sourceUrl}`,
    `媒体：共 ${media.length} 个（视频 ${videos.length} / 图片 ${images.length}` +
      (audios.length ? ` / 音频 ${audios.length}` : '') +
      `），合计 ${(totalBytes / 1048576).toFixed(1)}MB`,
  ];
  if (result?.mediaOnly) lines.push(`保存目录：${result.mediaOnly.dir}`);

  // 下载地址：直接给出可点的本地图床直链
  // 用纯 URL（不用 markdown 链接语法）—— 群晖 Chat / 飞书 / Slack 都会自动识别成链接，
  // 万一某个平台不渲染 markdown，也不会把 [xx](url) 这种原文暴露给用户。
  if (media.length) {
    lines.push('下载地址：');
    for (const [index, item] of media.slice(0, MAX_LINK_LINES).entries()) {
      const size = `${((item.bytes || 0) / 1048576).toFixed(2)}MB`;
      const label = item.kind === 'video' ? '视频' : item.kind === 'audio' ? '音频' : '图片';
      const href = item.localUrl || '';
      lines.push(href ? `${index + 1}. ${label} ${size} ${href}` : `${index + 1}. ${label} ${size} ${item.file || ''}`);
    }
    if (media.length > MAX_LINK_LINES) lines.push(`… 其余 ${media.length - MAX_LINK_LINES} 个见 JSON 详情`);
  }

  if (result?.warnings?.length) lines.push(`提示：${result.warnings.slice(0, 3).join('；')}`);
  // PUBLIC_BASE_URL 还是 localhost 时，手机点开链接会失败 —— 明确提醒一句
  if (/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(config.publicBaseUrl)) {
    lines.push('提示：PUBLIC_BASE_URL 还是 localhost，手机/其它设备点不开上面的地址，请在服务端改成域名或 IP:端口');
  }

  let text = lines.join('\n');
  if (text.length > MAX_TEXT_CHARS) text = `${text.slice(0, MAX_TEXT_CHARS - 20)}\n…（消息过长已截断）`;

  return {
    text,
    data: {
      event,
      title: result?.title || '',
      url: sourceUrl,
      engine: result?.engine || '',
      mediaOnly: Boolean(result?.mediaOnly),
      count: media.length,
      videos: videos.length,
      images: images.length,
      audios: audios.length,
      bytes: totalBytes,
      dir: result?.mediaOnly?.dir || '',
      files: media.map((m) => ({
        kind: m.kind,
        file: m.file || '',
        bytes: m.bytes || 0,
        localUrl: m.localUrl || '',
        localPath: m.localPath || '',
        sourceUrl: m.sourceUrl || '',
      })),
      warnings: result?.warnings || [],
      at: new Date().toISOString(),
    },
  };
}

/** 按配置的报文格式组装 body 对象 */
export function formatWebhookBody(payload, format = config.webhook.format) {
  const { text, data } = payload;
  switch (format) {
    case 'feishu':
      return { msgtype: 'text', content: { text } };
    case 'dingtalk':
    case 'wecom':
      return { msgtype: 'text', text: { content: text } };
    case 'text':
    case 'slack':
    case 'synology':
      return { text };
    case 'json':
    default:
      return { text, ...data };
  }
}

/**
 * 组装真正要发出去的 HTTP 请求（正文 + Content-Type）。
 *
 * 群晖 Chat 是个例外：它的传入 webhook（`entry.cgi?api=SYNO.Chat.External&method=incoming`）
 * **不收 JSON 正文**，要的是表单编码、把 JSON 塞在 `payload` 字段里：
 *   payload={"text":"..."}
 * 直接发 `{"text":"..."}` 会被回 `{"code":407,"errors":"payload: url and text are both empty"}`（实测）。
 */
export function buildWebhookRequest(payload, format = config.webhook.format) {
  const body = formatWebhookBody(payload, format);
  if (format === 'synology') {
    return {
      contentType: 'application/x-www-form-urlencoded; charset=utf-8',
      body: `payload=${encodeURIComponent(JSON.stringify(body))}`,
    };
  }
  return { contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) };
}

/**
 * 把常见失败翻译成"下一步该干什么"。
 * 这些坑在 NAS 部署里几乎都会踩一遍（DNS、自签名证书、端口、token、自动封锁），
 * 直接把处理方式带回给调用方，省得对着一句 fetch failed 猜。
 */
export function explainWebhookFailure({ error = '', status = 0, response = '' } = {}) {
  const text = `${error} ${response}`;
  if (/ENOTFOUND|EAI_AGAIN/i.test(text)) {
    return '容器里解析不了这个域名（DNS 失败）：给 compose 的 service 加 extra_hosts: ["<域名>:<NAS 局域网 IP>"]，或加 dns: ["223.5.5.5","1.1.1.1"]；也可以把 webhook 地址直接换成 NAS 的局域网 IP';
  }
  if (/DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_[A-Z_]+/i.test(text)) {
    return '对方用的是自签名证书：把 WEBHOOK_TLS_VERIFY 设为 false（只影响 webhook 这一个请求）';
  }
  if (/ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ECONNRESET/i.test(text)) {
    return '连不上该主机/端口：群晖的 webapi 走 443 或 80（5001 常被反代或 Web Station 占着，会把 /webapi/ 挡成 404）';
  }
  if (/autoblock|"code"\s*:\s*105/i.test(text)) {
    return 'NAS 把来源 IP 自动封锁了：DSM → 控制面板 → 安全性 → 自动封锁，解封该 IP（或加入允许名单）';
  }
  if (/invalid token|"code"\s*:\s*404\b/i.test(text)) {
    return 'token 无效：回 Chat「频道 → 集成 → 传入 Webhook」重新复制整条地址（必要时重置）';
  }
  if (/url and text are both empty/i.test(text)) {
    return '对方没解析到文本内容：确认 WEBHOOK_FORMAT=synology（群晖 Chat 传入 webhook 的报文是 {"text":"…"}）';
  }
  if (status === 404 && /<html/i.test(response)) {
    return '这个端口没把 /webapi/ 路由到 DSM：换成能访问 DSM 的地址（如 443/80），或让反代放行 /webapi/';
  }
  return '';
}

/**
 * 发送通知。**不会抛错**：webhook 失败不该让整次抓取失败。
 * 消息超过平台上限时自动分成多条发送（每段带「（i/N）」标记），并在限流时重试。
 * @returns {Promise<{ok: boolean, parts?: number, statuses?: number[], error?: string, skipped?: string}>}
 */
export async function sendWebhook(result, { event, url = config.webhook.url, format = config.webhook.format } = {}) {
  if (!url) return { ok: false, skipped: '未配置 WEBHOOK_URL' };

  const payload = buildWebhookPayload(result, { event });
  const limit = webhookTextLimit(format);
  const { parts } = splitWebhookText(payload.text || '', limit);
  const statuses = [];
  const errors = [];
  let lastResponse = '';

  for (const [index, partText] of parts.entries()) {
    // 后面的分片不再重复整份结构化数据，只带个分片信息
    const partPayload = {
      text: partText,
      data: index === 0 ? payload.data : { event: payload.data.event, part: index + 1, parts: parts.length },
    };
    const request = buildWebhookRequest(partPayload, format);
    if (index > 0) await new Promise((r) => setTimeout(r, Math.max(0, config.webhook.partDelayMs)));

    let attempt = 0;
    for (;;) {
      let res;
      try {
        res = await postJson(url, request, {
          headers: config.webhook.headers,
          timeoutMs: config.webhook.timeoutMs,
          tlsVerify: config.webhook.tlsVerify,
        });
      } catch (err) {
        const error = `${err.message}${err.cause?.code ? ` (${err.cause.code})` : ''}`;
        const hint = explainWebhookFailure({ error });
        log.warn('webhook 发送失败', { err: err.message, part: index + 1, hint });
        return { ok: false, parts: parts.length, sent: index, statuses, status: statuses.at(-1) ?? 0, url, format, hint, error };
      }

      const text = ((await res.text().catch(() => '')) || '').replace(/\s+/g, ' ');
      statuses.push(res.status);
      lastResponse = text;

      // 群晖的限流：等一会儿重试这一条
      const tooFast = /create post too fast|"code"\s*:\s*411/i.test(text);
      if (tooFast && attempt < 3) {
        attempt += 1;
        const wait = Math.max(2000, config.webhook.partDelayMs * attempt * 2);
        log.warn('webhook 被限流，稍后重试', { part: index + 1, attempt, wait });
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }

      const failed = !res.ok || /"success"\s*:\s*false/i.test(text);
      if (failed) {
        const hint = explainWebhookFailure({ status: res.status, response: text.slice(0, 300) });
        log.warn('webhook 返回失败', { status: res.status, response: text.slice(0, 200), part: index + 1, hint });
        errors.push(text.slice(0, 200));
        return {
          ok: false,
          parts: parts.length,
          sent: index,
          statuses,
          status: statuses.at(-1) ?? 0,
          url,
          format,
          response: text.slice(0, 300),
          hint,
          error: errors[0],
        };
      }
      break;
    }
  }

  log.info('webhook 已发送', { status: statuses.at(-1), parts: parts.length, url: url.slice(0, 80) });
  return { ok: true, parts: parts.length, statuses, status: statuses.at(-1), url, format, response: lastResponse.slice(0, 200) };
}

/**
 * 自检：往指定地址发一条测试消息（不抓取任何东西），用来排查"webhook 到底通不通"。
 * 报文里带一份样例媒体清单，能顺便看出消息长什么样。
 */
export async function sendWebhookTest({ url = config.webhook.url, format = config.webhook.format, text = '' } = {}) {
  if (!url) return { ok: false, skipped: '未配置 WEBHOOK_URL' };
  const sample = {
    title: 'WebClip 测试消息',
    finalUrl: 'https://example.com/demo',
    engine: 'test',
    mediaOnly: { dir: config.mediaOnly.dir, local: true },
    media: [
      {
        kind: 'video',
        file: 'example.com/示例/01.mp4',
        bytes: 20 * 1048576,
        localUrl: `${config.publicBaseUrl}/media-only/example.com/%E7%A4%BA%E4%BE%8B/01.mp4`,
        localPath: `${config.mediaOnly.dir}/example.com/示例/01.mp4`,
      },
      {
        kind: 'image',
        file: 'example.com/示例/02.jpg',
        bytes: 300 * 1024,
        localUrl: `${config.publicBaseUrl}/media-only/example.com/%E7%A4%BA%E4%BE%8B/02.jpg`,
        localPath: `${config.mediaOnly.dir}/example.com/示例/02.jpg`,
      },
    ],
    warnings: [],
  };
  const result = await sendWebhook(sample, { event: 'webhook.test', url, format });
  return { ...result, text: text || buildWebhookPayload(sample, { event: 'webhook.test' }).text };
}
