#!/usr/bin/env node
/**
 * 部署自检（命令行版，与 Web UI 里的「一键自检」等价）。
 * 适合在 NAS/CI 上验证一套部署是否正常，不需要浏览器。
 *
 *   node scripts/selfcheck.mjs http://192.168.1.10:3000
 *   node scripts/selfcheck.mjs http://localhost:3000 --token <API_TOKEN>
 *   node scripts/selfcheck.mjs https://clip.example.com --token x --target https://example.com/a --engine browser
 *   node scripts/selfcheck.mjs http://localhost:3000 --token x --json    # 输出机器可读结果
 *
 * 检查项：健康检查 → 鉴权拦截 → 统计接口 → 广告规则 → 真实抓取 → Markdown 直链 → 图床直链 → 清理数据
 */
import process from 'node:process';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const [key, inline] = token.slice(2).split('=');
    if (inline !== undefined) args[key] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
      args[key] = argv[i + 1];
      i += 1;
    } else args[key] = true;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h || !args._.length) {
  console.log(`用法: node scripts/selfcheck.mjs <服务地址> [选项]

选项:
  --token <API_TOKEN>    服务端设置了 API_TOKEN 时必填
  --target <url>         抓取检查用的网址（默认 https://example.com）
  --engine <browser|fetch>  抓取引擎（默认 fetch，快；需验证无头浏览器请用 browser）
  --skip-convert         跳过真实抓取（只检查服务与鉴权）
  --json                 输出 JSON 结果
`);
  process.exit(args._.length ? 0 : 1);
}

const BASE = String(args._[0]).replace(/\/+$/, '');
const TOKEN = typeof args.token === 'string' ? args.token : '';
const TARGET = typeof args.target === 'string' ? args.target : 'https://example.com';
const ENGINE = args.engine === 'browser' ? 'browser' : 'fetch';
const SKIP_CONVERT = Boolean(args.skipConvert);
const AS_JSON = Boolean(args.json);

const authHeaders = () => (TOKEN ? { 'x-api-token': TOKEN } : {});
const sameOrigin = (url) => String(url || '').replace(/^https?:\/\/[^/]+/, BASE);

const rows = [];
function record(name, status, detail, ms) {
  rows.push({ name, status, detail, ms });
  if (!AS_JSON) {
    const icon = status === 'ok' ? '✔' : status === 'warn' ? '!' : '✖';
    console.log(`${icon} ${name.padEnd(14, ' ')} ${detail}${ms !== undefined ? `  (${ms}ms)` : ''}`);
  }
}

async function call(path, options = {}, timeoutMs = 180000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('超时')), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(`${BASE}${path}`, { ...options, signal: controller.signal });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 非 JSON 响应（例如 text/markdown） */
    }
    return { res, text, json, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

const fail = (name, detail, ms) => record(name, 'fail', detail, ms);

if (!AS_JSON) console.log(`自检目标: ${BASE}${TOKEN ? '（带 API Token）' : ''}\n`);

/* 1. 健康检查 */
try {
  const { res, json, ms } = await call('/healthz', {}, 15000);
  if (!res.ok) fail('健康检查', `HTTP ${res.status}`, ms);
  else
    record(
      '健康检查',
      'ok',
      `v${json?.version} · 已运行 ${json?.uptimeSec}s · 浏览器${json?.browser?.connected ? '已就绪' : '未启动（首次抓取时自动启动）'}`,
      ms,
    );
} catch (err) {
  fail('健康检查', `无法连接 ${BASE}：${err.message}`);
}

/* 2. 鉴权拦截（无 Token 必须 401） */
if (TOKEN) {
  try {
    const { res, ms } = await call('/api/stats', {}, 15000);
    record('鉴权拦截', res.status === 401 ? 'ok' : 'warn', res.status === 401 ? '无 Token 请求被正确拒绝（401）' : `无 Token 也返回了 HTTP ${res.status}，接口可能未设 API_TOKEN`, ms);
  } catch (err) {
    record('鉴权拦截', 'warn', `跳过：${err.message}`);
  }
}

/* 3. 统计接口 */
let tokenRequired = false;
try {
  const { res, json, text, ms } = await call('/api/stats', { headers: authHeaders() }, 20000);
  if (res.status === 401) {
    fail('统计接口', TOKEN ? 'HTTP 401：Token 不正确' : 'HTTP 401：服务端设置了 API_TOKEN，请用 --token 传入', ms);
  } else if (!res.ok) {
    fail('统计接口', `HTTP ${res.status} ${text.slice(0, 120)}`, ms);
  } else {
    tokenRequired = Boolean(json?.data?.config?.apiTokenRequired);
    const media = json?.data?.media || {};
    const articles = json?.data?.articles || {};
    record('统计接口', 'ok', `图床 ${media.files ?? '?'} 个文件 / ${Math.round((media.bytes || 0) / 1024)}KB · 文章 ${articles.total ?? '?'} 篇`, ms);
    record(
      '接口鉴权',
      tokenRequired ? 'ok' : 'warn',
      tokenRequired ? '已设置 API_TOKEN' : '未设置 API_TOKEN：任何人都能调用接口，公网暴露请务必设置',
    );
  }
} catch (err) {
  fail('统计接口', `请求失败：${err.message}`);
}

/* 4. 广告规则 */
try {
  const { res, json, ms } = await call('/api/rules', { headers: authHeaders() }, 15000);
  if (!res.ok) record('广告规则', 'warn', `HTTP ${res.status}`, ms);
  else
    record(
      '广告规则',
      json?.data?.disabled ? 'warn' : 'ok',
      json?.data?.disabled ? '规则被 ADBLOCK_DISABLE=1 关闭' : `${json.data.hostPatterns} 条域名规则 · ${json.data.removeSelectors} 条 DOM 规则`,
      ms,
    );
} catch (err) {
  record('广告规则', 'warn', `跳过：${err.message}`);
}

/* 5~7. 真实抓取 → Markdown 直链 → 图床直链 */
let articleId = '';
if (SKIP_CONVERT) {
  record('抓取转换', 'warn', '已用 --skip-convert 跳过');
} else {
  try {
    const { res, json, text, ms } = await call(
      '/api/convert',
      {
        method: 'POST',
        headers: { ...authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ url: TARGET, engine: ENGINE, imageMode: 'local', store: true, returnMarkdown: true, maxMediaFiles: 3 }),
      },
      300000,
    );
    if (!res.ok) {
      fail('抓取转换', `HTTP ${res.status}：${json?.error?.message || text.slice(0, 160)}`, ms);
    } else {
      const data = json?.data || {};
      articleId = data.id || '';
      const media = data.stats?.media || {};
      record(
        '抓取转换',
        data.markdown ? 'ok' : 'warn',
        `${String(data.title || '').slice(0, 30)} · ${data.stats?.words ?? '?'} 字 · 媒体 ${data.media?.length ?? 0}（下载 ${media.saved ?? 0}/缓存 ${media.reusedFromCache ?? 0}/失败 ${media.failed ?? 0}）· 拦截广告请求 ${data.stats?.adsBlocked ?? 0}`,
        ms,
      );
      for (const warning of data.warnings || []) record('抓取告警', 'warn', warning);
      for (const failure of (data.mediaFailures || []).slice(0, 3)) {
        record('媒体失败', 'warn', `${failure.reason} · ${String(failure.url).slice(0, 70)}`);
      }

      if (data.markdownUrl) {
        const md = await call(sameOrigin(data.markdownUrl).replace(BASE, ''), { headers: authHeaders() }, 30000);
        record(
          'Markdown 直链',
          md.res.ok ? 'ok' : 'fail',
          md.res.ok ? `${md.res.headers.get('content-type')} · ${md.text.length}B` : `HTTP ${md.res.status}`,
          md.ms,
        );
      }

      const firstMedia = (data.media || [])[0];
      if (firstMedia) {
        const mediaRes = await call(sameOrigin(firstMedia.localUrl).replace(BASE, ''), {}, 60000);
        record(
          '图床直链',
          mediaRes.res.ok ? 'ok' : 'fail',
          mediaRes.res.ok
            ? `${firstMedia.kind} · ${mediaRes.res.headers.get('content-type')} · 免 Token 可访问`
            : `HTTP ${mediaRes.res.status}`,
          mediaRes.ms,
        );
      } else {
        record('图床直链', 'warn', '该页面没有媒体，跳过（换一个含图/视频的网址可验证）');
      }
    }
  } catch (err) {
    fail('抓取转换', `请求失败：${err.message}`);
  }
}

/* 8. 清理自检数据 */
if (articleId) {
  try {
    const del = await call(`/api/articles/${encodeURIComponent(articleId)}`, { method: 'DELETE', headers: authHeaders() }, 20000);
    record('清理数据', del.res.ok ? 'ok' : 'warn', del.res.ok ? '已删除自检产生的文章（图床文件保留）' : `HTTP ${del.res.status}`, del.ms);
  } catch (err) {
    record('清理数据', 'warn', `跳过：${err.message}`);
  }
}

const failed = rows.filter((r) => r.status === 'fail');
const warned = rows.filter((r) => r.status === 'warn');

if (AS_JSON) {
  console.log(JSON.stringify({ base: BASE, target: TARGET, engine: ENGINE, passed: rows.length - failed.length - warned.length, warned: warned.length, failed: failed.length, rows }, null, 2));
} else {
  console.log(
    `\n${failed.length ? `✖ 自检未通过：${failed.length} 项失败` : '✔ 自检通过'}（${rows.length - failed.length - warned.length} 项正常${warned.length ? ` / ${warned.length} 项警告` : ''}）`,
  );
}
process.exit(failed.length ? 1 : 0);
