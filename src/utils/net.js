import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from '../config.js';
import { badRequest, upstream, timeout as timeoutError } from './errors.js';

/* ------------------------------------------------------------------ *
 * SSRF 防护：拒绝指向内网/回环/保留地址的目标
 * ------------------------------------------------------------------ */

/**
 * 媒体目录按网站分类时用的目录名：页面域名去掉开头的 www.（www.douyin.com → douyin.com）。
 * 取不到或地址非法就返回空串，调用方退回不分类的旧结构。
 */
export function siteKeyFromUrl(rawUrl) {
  try {
    const host = String(new URL(String(rawUrl || '')).hostname || '')
      .toLowerCase()
      .replace(/^www\./, '');
    if (!host) return '';
    // 域名本身就是字母数字加 . -；IPv6 的 [] 与 : 一并换成 -，顺手截断防超长
    const safe = host.replace(/[^a-z0-9.-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '');
    return safe.slice(0, 80);
  } catch {
    return '';
  }
}

const IPV4_BLOCKED = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function ipv4ToInt(ip) {
  const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

export function isPrivateIPv4(ip) {
  const value = ipv4ToInt(ip);
  if (value === null) return false;
  return IPV4_BLOCKED.some(([base, bits]) => {
    const baseInt = ipv4ToInt(base);
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (baseInt & mask);
  });
}

export function isPrivateIP(ip) {
  if (!ip) return true;
  const version = net.isIP(ip);
  if (version === 4) return isPrivateIPv4(ip);
  if (version === 6) {
    const lower = ip.toLowerCase().split('%')[0];
    if (lower === '::' || lower === '::1') return true;
    // IPv4-mapped / IPv4-compatible
    const mapped = lower.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIPv4(mapped[1]);
    if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // fc00::/7
    if (/^fe[89ab][0-9a-f]:/.test(lower)) return true; // fe80::/10
    if (/^ff[0-9a-f]{2}:/.test(lower)) return true; // ff00::/8
    return false;
  }
  return true; // 无法识别的地址一律拒绝
}

const dnsCache = new Map(); // host -> { at, addresses }
const DNS_TTL_MS = 60_000;

export async function resolveHost(hostname) {
  const cached = dnsCache.get(hostname);
  if (cached && Date.now() - cached.at < DNS_TTL_MS) return cached.addresses;
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  const addresses = records.map((r) => r.address);
  dnsCache.set(hostname, { at: Date.now(), addresses });
  if (dnsCache.size > 2000) dnsCache.clear();
  return addresses;
}

export function parseTargetUrl(raw, { base } = {}) {
  if (typeof raw !== 'string' || !raw.trim()) throw badRequest('缺少 url 参数');
  let url;
  try {
    url = base ? new URL(raw.trim(), base) : new URL(raw.trim());
  } catch {
    throw badRequest(`无效的 URL: ${raw}`);
  }
  const protocol = url.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') {
    if (!(protocol === 'file:' && config.security.allowFileProtocol)) {
      throw badRequest(`不支持的协议: ${protocol}（仅允许 http/https）`);
    }
  }
  if (url.username || url.password) {
    throw badRequest('URL 中不允许包含用户名/密码');
  }
  return url;
}

/**
 * 校验 URL 是否允许访问（协议 + 内网地址检查）。
 * 返回 { url, addresses }。
 */
export async function assertUrlAllowed(rawUrl, { base } = {}) {
  const url = parseTargetUrl(rawUrl, { base });
  if (config.security.allowPrivateNetwork) return { url, addresses: [] };

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(hostname)) {
    if (isPrivateIP(hostname)) {
      throw badRequest(`禁止访问内网地址: ${hostname}（如需允许请设置 ALLOW_PRIVATE_NETWORK=true）`);
    }
    return { url, addresses: [hostname] };
  }

  const lowered = hostname.toLowerCase();
  if (lowered === 'localhost' || lowered.endsWith('.localhost') || lowered.endsWith('.local')) {
    throw badRequest(`禁止访问内网地址: ${hostname}（如需允许请设置 ALLOW_PRIVATE_NETWORK=true）`);
  }

  let addresses = [];
  try {
    addresses = await resolveHost(hostname);
  } catch (err) {
    throw upstream(`域名解析失败: ${hostname}`, { cause: err.message });
  }
  const bad = addresses.find((ip) => isPrivateIP(ip));
  if (bad) {
    throw badRequest(`域名 ${hostname} 解析到内网地址 ${bad}，已拒绝`);
  }
  return { url, addresses };
}

/** 给浏览器/子资源使用的轻量校验（不做 DNS，命中即拒绝字面内网地址） */
export function isUrlObviouslyBlocked(rawUrl) {
  if (config.security.allowPrivateNetwork) return false;
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return true;
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIP(hostname)) return isPrivateIP(hostname);
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  return false;
}

/* ------------------------------------------------------------------ *
 * 带大小/超时限制的下载
 * ------------------------------------------------------------------ */

/** 合并多个 AbortSignal */
export function anySignal(signals) {
  const controller = new AbortController();
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

export function withTimeout(ms, message = '操作超时') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(message)), ms);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
    controller,
  };
}

/**
 * 下载一个资源到内存（带重定向校验、大小上限、超时）。
 * 返回 { buffer, mime, finalUrl, status, headers }
 */
export async function downloadBuffer(rawUrl, options = {}) {
  const {
    headers = {},
    maxBytes = config.storage.maxFileBytes,
    timeoutMs = config.fetch.timeoutMs,
    signal,
    method = 'GET',
    maxRedirects = config.fetch.maxRedirects,
  } = options;

  let current = rawUrl;
  const timer = withTimeout(timeoutMs, `下载超时: ${rawUrl}`);

  try {
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      await assertUrlAllowed(current);
      const res = await fetch(current, {
        method,
        redirect: 'manual',
        signal: anySignal([timer.signal, signal]),
        headers: {
          'user-agent': config.fetch.userAgent,
          accept: '*/*',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
          ...headers,
        },
      });

      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        const next = new URL(res.headers.get('location'), current).toString();
        try {
          await res.body?.cancel();
        } catch {
          /* ignore */
        }
        current = next;
        continue;
      }

      if (!res.ok) {
        try {
          await res.body?.cancel();
        } catch {
          /* ignore */
        }
        const err = upstream(`下载失败 HTTP ${res.status}: ${current}`);
        err.status = res.status === 404 ? 404 : 502;
        throw err;
      }

      const declared = Number.parseInt(res.headers.get('content-length') || '', 10);
      if (Number.isFinite(declared) && declared > maxBytes) {
        try {
          await res.body?.cancel();
        } catch {
          /* ignore */
        }
        const err = upstream(`文件过大（${declared} > ${maxBytes} 字节），已跳过: ${current}`);
        err.code = 'too_large';
        throw err;
      }

      const chunks = [];
      let received = 0;
      const reader = res.body?.getReader();
      if (!reader) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.byteLength > maxBytes) {
          const err = upstream(`文件过大，已跳过: ${current}`);
          err.code = 'too_large';
          throw err;
        }
        return {
          buffer: buf,
          mime: res.headers.get('content-type') || '',
          finalUrl: current,
          status: res.status,
          headers: res.headers,
        };
      }
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > maxBytes) {
          await reader.cancel().catch(() => {});
          const err = upstream(`文件过大（> ${maxBytes} 字节），已跳过: ${current}`);
          err.code = 'too_large';
          throw err;
        }
        chunks.push(Buffer.from(value));
      }

      return {
        buffer: Buffer.concat(chunks, received),
        mime: res.headers.get('content-type') || '',
        finalUrl: current,
        status: res.status,
        headers: res.headers,
      };
    }
    throw upstream(`重定向次数超过 ${maxRedirects}: ${rawUrl}`);
  } catch (err) {
    if (err?.name === 'AbortError' || /超时/.test(err?.message || '')) {
      throw timeoutError(`下载超时: ${rawUrl}`);
    }
    throw err;
  } finally {
    timer.clear();
  }
}

export function isHtmlContentType(mime = '') {
  return /text\/html|application\/xhtml\+xml/i.test(mime);
}
