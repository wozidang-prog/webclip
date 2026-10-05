/**
 * 小红书自建解析器客户端（对应 XHS-Downloader 的 HTTP API）。
 *
 * 为什么要有这一层：
 *   小红书网页端的正文/媒体都在签名接口后面，靠页面数据解析（sites/index.js 那条路）
 *   既受登录态影响、又随改版失效。用户自建的解析器（如 JoeanAmier/XHS-Downloader）
 *   一次请求就能拿到**标题、正文、作者、图片/视频直链**，所以配了 XIAOHONGSHU_API 时优先走它，
 *   解析不出来再退回页面解析。
 *
 * 接口契约（对自建实例实测得到，FastAPI + Pydantic）：
 *   POST {XIAOHONGSHU_API}
 *   content-type: application/json
 *   {"url": "<规范笔记地址>", "cookie"?: "<登录 Cookie>", "download": false}
 *   → 200 {"message":"获取小红书作品数据成功","params":{…},"data":{…}}
 *   GET  → 405 Method Not Allowed（只收 POST）
 *   缺 url → 422 Unprocessable Entity
 *   认不出链接 → 200 + {"message":"提取小红书作品链接失败","data":null}
 *   作品不存在 → 200 + {"message":"获取小红书作品数据失败","data":{}}（注意 data 是**空对象**，不能用真假判断）
 *
 * data 里的字段（中文键）：
 *   作品ID / 作品标题 / 作品描述 / 作品类型（图文｜视频）/ 作者昵称 / 作者ID / 作品链接 /
 *   发布时间 / 时间戳 / 点赞数量 / 收藏数量 / 评论数量 / 分享数量 / 下载地址（图片或视频直链数组）
 *
 * ⚠️ 两个实测坑：
 *   1. 解析器**不认 xhslink.com / xhslink.cn 分享短链**（会回「提取小红书作品链接失败」），
 *      必须先展开短链；而且网页端短链会跳到登录页，真正的笔记地址藏在 location 的
 *      redirectPath 参数里（带着必需的 xsec_token）。这就是 resolveXhsNoteUrl 的作用。
 *   2. 视频笔记里「下载地址」放的是视频直链，别当成图片存。
 */

import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';

const log = logger.child({ mod: 'xhs-api' });

/** 分享短链域名：解析器不认，需要先展开成 xiaohongshu.com 的规范地址 */
const SHORT_HOSTS = ['xhslink.com', 'xhslink.cn'];

/** 小红书自家图片 CDN / 图片处理参数：用来把「图片」和「视频」分开 */
const IMAGE_HINT_RE = /(ci\.xiaohongshu\.com|sns-img|imageView2|\/image\b|\.(jpe?g|png|webp|gif|avif|heic)(\?|#|$))/i;

/** 视频直链特征：sns-video-*.xhscdn.com、/stream/、.mp4 … */
const VIDEO_HINT_RE = /(\.(mp4|m4v|mov|webm|mkv)(\?|#|$)|sns-video|\/stream\/|video\/tos|xhscdn\.com\/[^?]*video)/i;

/** 解析器地址（配置为空 = 不启用） */
export function xhsApiUrl() {
  return String(config.xiaohongshuApi || '').trim();
}

export function xhsApiEnabled() {
  return Boolean(xhsApiUrl());
}

/** 从一段分享文案里挑出小红书链接（分享内容常是「文字 + 链接 + 文字」） */
export function extractXhsLink(text) {
  const found = String(text || '').match(/https?:\/\/[^\s"'<>）)】]+/gi) || [];
  return found.find((u) => /(xiaohongshu\.com|xhslink\.(?:com|cn))/i.test(u)) || '';
}

/** 从笔记地址里抠出笔记 ID（/explore/<id>、/discovery/item/<id> 两种都认） */
export function noteIdOf(url) {
  const m = String(url || '').match(/\/(?:explore|discovery\/item|item)\/([0-9a-f]{16,})/i);
  return m ? m[1] : '';
}

/** 取 URL 上的 xsec_token（新版小红书网页访问笔记必需，短链解开后才有） */
function xsecTokenOf(url) {
  try {
    return new URL(String(url)).searchParams.get('xsec_token') || '';
  } catch {
    return '';
  }
}

/**
 * 从一个跳转目标里取出真正的笔记地址。
 * 网页端短链会跳到 `https://www.xiaohongshu.com/login?redirectPath=<编码后的笔记地址>`，
 * 所以优先读 redirectPath，其次才看它本身是不是笔记页。
 */
export function noteUrlFromLocation(location) {
  if (!location) return '';
  let target = '';
  try {
    const u = new URL(location);
    target = u.searchParams.get('redirectPath') || '';
    if (!target) {
      if (/xiaohongshu\.com$/i.test(u.hostname.replace(/^www\./i, '')) && noteIdOf(location)) return location;
      return '';
    }
  } catch {
    return '';
  }
  try {
    const decoded = decodeURIComponent(target);
    return noteIdOf(decoded) ? decoded : '';
  } catch {
    return noteIdOf(target) ? target : '';
  }
}

/**
 * 把用户给的链接整理成解析器能吃的「规范笔记地址」。
 * - 已经是规范地址：原样返回
 * - 分享短链：展开一次拿到带 xsec_token 的笔记地址
 * - 登录页地址（含 redirectPath）：把里面的笔记地址取出来
 * - 给的是整段分享文案：先抠出链接
 * 任何一步失败都返回原始链接（让解析器自己再试一次），绝不抛错。
 */
export async function resolveXhsNoteUrl(rawUrl, { timeoutMs = 15_000 } = {}) {
  const input = String(rawUrl || '').trim();
  const url = extractXhsLink(input) || input;
  const passthrough = { url, expanded: false, noteId: noteIdOf(url), xsecToken: xsecTokenOf(url) };

  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return passthrough;
  }

  /**
   * 情况一：拿到的是「小红书自己的登录页 / 跳转页」。
   * 抓取流程传进来的往往是重定向后的最终地址，短链早就在浏览器/HTTP 层跳成了
   * https://www.xiaohongshu.com/login?redirectPath=<编码后的笔记地址>，
   * 这时真正的笔记地址就藏在 redirectPath 里（带着必需的 xsec_token）。
   */
  if (host === 'xiaohongshu.com' || host.endsWith('.xiaohongshu.com')) {
    const fromRedirect = noteUrlFromLocation(url);
    if (fromRedirect && fromRedirect !== url) {
      log.debug('从登录/跳转页里取出笔记地址', { noteId: noteIdOf(fromRedirect) });
      return { url: fromRedirect, expanded: true, noteId: noteIdOf(fromRedirect), xsecToken: xsecTokenOf(fromRedirect) };
    }
    return passthrough;
  }

  if (!SHORT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return passthrough;

  try {
    // 手动跟一次 302：XHS 会跳登录页，真正的笔记地址在 redirectPath 里
    const res = await fetch(url, {
      redirect: 'manual',
      headers: { 'user-agent': config.fetch.userAgent, accept: 'text/html,*/*' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const target =
      noteUrlFromLocation(res.headers.get('location') || '') ||
      noteUrlFromLocation(res.url || '') ||
      '';
    if (target) {
      log.debug('分享短链已展开', { noteId: noteIdOf(target), hasToken: Boolean(xsecTokenOf(target)) });
      return { url: target, expanded: true, noteId: noteIdOf(target), xsecToken: xsecTokenOf(target) };
    }
    log.warn('分享短链展开后没找到笔记地址，交给解析器直接尝试', { host });
  } catch (err) {
    log.warn('分享短链展开失败，交给解析器直接尝试', { err: err.message });
  }
  return passthrough;
}

/** data 里有没有真东西（空对象/空数组都算没有） */
export function hasXhsNoteContent(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  if (data['作品ID'] || data['作品标题'] || data['作品描述']) return true;
  const list = data['下载地址'];
  return Array.isArray(list) ? list.length > 0 : Boolean(list);
}

/** 请求失败时给出「能直接照做」的提示（容器里最常见的三类原因） */
export function explainXhsApiFailure(code, base) {
  let host = base;
  try {
    host = new URL(base).host;
  } catch {
    /* 地址本身不合法时就把原样贴出来 */
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return (
      `解析不到 ${host}。两种常见原因：① 容器 DNS 指到了 NAS 自己（127.0.0.1）→ 加 dns 或 extra_hosts；` +
      `② 域名只有 IPv6 记录（AAAA）而默认 Docker 网络没有 IPv6 → 直接用局域网 IPv4（如 http://192.168.x.x:5556/xhs/detail），` +
      `或用 extra_hosts: ["${host.split(':')[0]}:192.168.x.x"] 把域名指到局域网 IP`
    );
  }
  if (['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) {
    return `连不上 ${host}：确认解析器在跑、端口可达。注意**只有 IPv6 记录的 DDNS 域名在默认 Docker 网络里连不通**（容器默认没有 IPv6），这种情况改用局域网 IPv4，例如 http://192.168.x.x:5556/xhs/detail`;
  }
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO/i.test(String(code))) {
    return `${host} 的 HTTPS 证书不被信任：改用 http，或给解析器配上受信任的证书`;
  }
  return '';
}

/**
 * 调解析器拿作品数据。
 * @returns {Promise<{ok:boolean, data?:object, reason?:string, message?:string, status?:number, hint?:string}>}
 */
export async function fetchXhsNote(rawUrl, { cookie, apiUrl, timeoutMs = config.xiaohongshuApiTimeoutMs } = {}) {
  const base = String(apiUrl || '').trim() || xhsApiUrl();
  if (!base) return { ok: false, reason: 'not_configured' };

  const body = { url: rawUrl, download: false };
  // 需要登录态的作品（或被风控）才用得上 Cookie；解析器自己也存有一份，传过去只是兜底
  const jar = cookie ?? config.cookies.xiaohongshu;
  if (jar) body.cookie = jar;

  let res;
  try {
    res = await fetch(base, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': config.fetch.userAgent,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    /**
     * undici 把真实原因藏在 err.cause 里（ENOTFOUND / ECONNREFUSED / 证书错误…）。
     * 只报一句 "fetch failed" 没法排查——实测容器里最常见的就是
     * "DDNS 域名只有 IPv6 记录、而默认 Docker 网络没有 IPv6"。
     */
    const code = err.cause?.code || err.code || err.name || 'request_failed';
    const hint = explainXhsApiFailure(code, base);
    if (hint) log.warn('自建解析器请求失败', { code, hint });
    return { ok: false, reason: 'request_failed', message: `${code}: ${err.message}`, hint };
  }

  const text = await res.text().catch(() => '');
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'bad_json', status: res.status, message: text.slice(0, 200) };
  }

  const data = Array.isArray(json?.data) ? json.data[0] : json.data;
  if (!res.ok || !hasXhsNoteContent(data)) {
    return {
      ok: false,
      reason: res.ok ? 'parse_failed' : `http_${res.status}`,
      status: res.status,
      message: String(json?.message || text.slice(0, 200) || ''),
    };
  }
  return { ok: true, data, status: res.status, message: String(json.message || '') };
}

/** 从作品数据里找封面（字段名各版本略有差异） */
function coverOfNote(data) {
  for (const key of ['视频封面', '封面', '封面地址', '封面链接']) {
    const value = data?.[key];
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) return value;
    if (Array.isArray(value) && typeof value[0] === 'string' && /^https?:\/\//i.test(value[0])) return value[0];
  }
  return '';
}

/**
 * 作品数据 → 通用媒体条目。
 * 图文：下载地址全是图片；视频：下载地址是视频直链（封面单独一个字段，不算独立文件）。
 */
export function xhsNoteToMedia(data, { limit = 40 } = {}) {
  const raw = data?.['下载地址'];
  const list = (Array.isArray(raw) ? raw : raw ? [raw] : []).map((u) => String(u || '').trim()).filter(Boolean);
  const isVideo = String(data?.['作品类型'] || '').includes('视频');
  const cover = coverOfNote(data);

  const items = [];
  const seen = new Set();
  const push = (kind, url, poster = '') => {
    if (items.length >= limit) return;
    const key = url.split('#')[0];
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ kind, url, cover: poster && poster !== url ? poster : '' });
  };

  if (isVideo) {
    const videos = list.filter((u) => VIDEO_HINT_RE.test(u));
    const others = list.filter((u) => !VIDEO_HINT_RE.test(u));
    if (videos.length) {
      for (const url of videos) push('video', url, cover);
      // 视频笔记里剩下的都是封面/预览图，不当独立文件存
    } else if (list.length) {
      // 解析器没给明显的视频后缀时，第一条按视频处理（实测视频作品就是第一条直链）
      push('video', list[0], cover);
      for (const url of others.slice(1)) if (IMAGE_HINT_RE.test(url)) push('image', url);
    }
  } else {
    for (const url of list) push(IMAGE_HINT_RE.test(url) || !VIDEO_HINT_RE.test(url) ? 'image' : 'video', url, cover);
  }

  return {
    items,
    /** 解析器原样给的标题（可能为空 —— 用于判断标题是不是退化成日期了） */
    rawTitle: String(data?.['作品标题'] || '').trim(),
    title: String(data?.['作品标题'] || '').trim() || xhsDateTitle(data),
    caption: String(data?.['作品描述'] || '').trim(),
    author: String(data?.['作者昵称'] || '').trim(),
    noteId: String(data?.['作品ID'] || '').trim(),
    published: xhsPublishedAt(data),
    kind: isVideo ? 'video' : 'image',
    source: 'xhs_api',
  };
}

/**
 * 解析器给的发布时间（实测格式 `2026-09-16_03:07:37`）。认不出来就返回空串。
 * 也兼容 `2026-09-16 03:07:37` / ISO 的 `T` 分隔写法。
 */
export function xhsPublishedAt(data) {
  const raw = String(data?.['发布时间'] || '').trim();
  const m = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[ _T]+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return '';
  const [, y, mo, d, h, mi, s = '00'] = m;
  const pad = (v) => String(v).padStart(2, '0');
  return `${y}-${pad(mo)}-${pad(d)} ${pad(h)}:${pad(Number(mi))}:${pad(Number(s))}`;
}

/**
 * 没有作品标题时用「日期」当标题（用户要求）。
 *
 * 优先用作品自己的发布时间而不是"今天"：重抓同一条笔记时标题不会变，
 * 标题稳定才能命中"网址记录 / 正文指纹"，也就不会重复下载、重复归档。
 * 带上到分钟的时间是为了避免同一天多条无标题笔记挤进同一个目录互相覆盖。
 */
export function xhsDateTitle(data, now = new Date()) {
  const published = xhsPublishedAt(data);
  if (published) return published.slice(0, 16); // 2026-09-16 03:07
  const pad = (v) => String(v).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/**
 * 完整流程：整理链接 → 请求解析器 → 映射成媒体条目。
 * 失败时返回带 reason 的空结果（调用方据此决定要不要退回页面解析）。
 */
export async function collectViaXhsApi(rawUrl, { limit = 40, cookie, apiUrl } = {}) {
  const note = await resolveXhsNoteUrl(rawUrl);
  const res = await fetchXhsNote(note.url, { cookie, apiUrl });
  if (!res.ok) {
    /**
     * 小红书现在要求链接带 `xsec_token`，否则解析器只会回「获取小红书作品数据失败」。
     * 实测：`/discovery/item/<id>` 这类**没有 token 的地址**必然失败；
     * 用 App「分享 → 复制链接」得到的 xhslink 短链则会自动展开补上 token。
     */
    const hint = res.hint || (!hasXsecToken(note.url) ? MISSING_TOKEN_HINT : '');
    if (hint === MISSING_TOKEN_HINT) log.warn('链接缺少 xsec_token', { noteUrl: note.url.slice(0, 120) });
    log.warn('自建解析器没解析出内容', { reason: res.reason, message: res.message, expanded: note.expanded });
    return { items: [], reason: res.reason, message: res.message, hint, noteUrl: note.url };
  }
  const mapped = xhsNoteToMedia(res.data, { limit });
  log.info('自建解析器解析成功', {
    noteId: mapped.noteId,
    kind: mapped.kind,
    media: mapped.items.length,
    expanded: note.expanded,
  });
  return { ...mapped, noteUrl: note.url, reason: '' };
}

/** 链接里是否带小红书必需的 xsec_token */
export function hasXsecToken(url) {
  try {
    return Boolean(new URL(url).searchParams.get('xsec_token'));
  } catch {
    return /[?&]xsec_token=[^&#]+/i.test(String(url));
  }
}

/** 缺 token 时的可操作提示（实测：没有 token 的笔记地址必然解析失败） */
export const MISSING_TOKEN_HINT =
  '链接里没有 xsec_token，小红书要求带它才能取到作品数据。请用小红书 App 的「分享 → 复制链接」' +
  '（得到 xhslink.cn 短链，程序会自动展开补上 token），或直接用浏览器地址栏里带 xsec_token 的完整地址再试。';

/** HTML 转义（解析器给的是纯文本，塞进 HTML 前必须转义） */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 只用解析器的数据造一篇「页面」，后续流程（正文抽取 → 媒体本地化 → Markdown）原样复用。
 *
 * 为什么值得这么做：网页端未登录或被风控时只会返回「安全限制」这类页面 —— 抓它不但
 * 拿不到内容，还容易把验证/封禁引到抓取机上；既然配了解析器，就该彻底不碰网页。
 *
 * @returns {Promise<{html:string,title:string,caption:string,author:string,items:Array,noteUrl:string,noteId:string}|null>}
 *          解析器没给出内容时返回 null（调用方退回正常抓取）。
 */
export async function buildXhsParserHtml(rawUrl, { limit = 40, cookie, apiUrl } = {}) {
  const parsed = await collectViaXhsApi(rawUrl, { limit, cookie, apiUrl });
  if (!parsed.items.length) return null;

  const paragraphs = parsed.caption
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join('');

  // 媒体直接写进正文：图片按 <img>、视频按 <video controls>，跟着正文顺序落到图床
  const media = parsed.items
    .map((item) =>
      item.kind === 'video'
        ? `<video src="${escapeHtml(item.url)}"${item.cover ? ` poster="${escapeHtml(item.cover)}"` : ''} controls></video>`
        : `<img src="${escapeHtml(item.url)}" alt="${escapeHtml(parsed.title || '图片')}">`,
    )
    .join('');

  const html =
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    (parsed.published ? `<meta property="article:published_time" content="${escapeHtml(parsed.published)}">` : '') +
    `<title>${escapeHtml(parsed.title)}</title></head><body><article>` +
    (parsed.title ? `<h1>${escapeHtml(parsed.title)}</h1>` : '') +
    paragraphs +
    media +
    '</article></body></html>';

  log.info('用解析器数据生成页面（不抓网页）', {
    noteId: parsed.noteId,
    kind: parsed.kind,
    media: parsed.items.length,
    /** 标题可能来自发布时间（无标题笔记） */
    titleFromDate: !String(parsed.rawTitle || '').trim(),
  });

  return {
    html,
    title: parsed.title,
    rawTitle: parsed.rawTitle || '',
    published: parsed.published || '',
    caption: parsed.caption,
    author: parsed.author,
    items: parsed.items,
    noteUrl: parsed.noteUrl,
    noteId: parsed.noteId,
  };
}