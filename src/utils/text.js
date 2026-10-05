import crypto from 'node:crypto';
import path from 'node:path';

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function shortHash(input, len = 16) {
  return crypto.createHash('sha1').update(String(input)).digest('hex').slice(0, len);
}

export function newId() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * 把标题变成适合做文件名/目录名的 slug（保留中文等 Unicode 字母）。
 * 采用白名单：只保留 字母/数字/空白/._- ，其余一律变空格再收敛为 '-'，
 * 保证结果一定能通过 ArticleStore 的 id 校验。
 */
export function slugify(input, { maxLength = 60, fallback = 'untitled' } = {}) {
  const cleaned = String(input ?? '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s._-]+/gu, ' ')
    .replace(/[\s\u00a0]+/g, '-')
    .replace(/_+/g, '_')
    .replace(/-+/g, '-')
    // 连续的点既难看、也会撞上"路径穿越"检查（标题结尾的 "......" 很常见）
    .replace(/\.{2,}/g, '.')
    .replace(/^[-._\s]+/, '')
    .replace(/[-._\s]+$/, '');
  const truncated = cleaned.slice(0, maxLength).replace(/[-._\s]+$/, '');
  return truncated || fallback;
}

const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
  'image/tiff': '.tiff',
  'image/heic': '.heic',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/ogg': '.ogv',
  'video/quicktime': '.mov',
  'video/x-matroska': '.mkv',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/webm': '.weba',
  'audio/flac': '.flac',
  'application/pdf': '.pdf',
  'image/gif;': '.gif',
};

const SAFE_EXT_RE = /^\.(jpe?g|png|gif|webp|avif|svgz?|bmp|ico|tiff?|heic|mp4|webm|ogv|mov|mkv|m4v|mp3|m4a|ogg|oga|wav|flac|opus|pdf|zip|json|txt)$/i;

export function extensionFromMime(mime = '') {
  const clean = String(mime).split(';')[0].trim().toLowerCase();
  if (EXT_BY_MIME[clean]) return EXT_BY_MIME[clean];
  if (clean.startsWith('image/')) {
    const sub = clean.slice('image/'.length).replace(/[^a-z0-9]/g, '');
    return sub ? `.${sub}` : '.img';
  }
  if (clean.startsWith('video/')) {
    const sub = clean.slice('video/'.length).replace(/[^a-z0-9]/g, '');
    return sub ? `.${sub}` : '.mp4';
  }
  if (clean.startsWith('audio/')) {
    const sub = clean.slice('audio/'.length).replace(/[^a-z0-9]/g, '');
    return sub ? `.${sub}` : '.mp3';
  }
  return '';
}

export function extensionFromUrl(rawUrl) {
  try {
    const { pathname } = new URL(rawUrl);
    const ext = path.extname(pathname);
    return SAFE_EXT_RE.test(ext) ? ext.toLowerCase() : '';
  } catch {
    return '';
  }
}

export function pickExtension({ mime, url } = {}) {
  return extensionFromMime(mime) || extensionFromUrl(url) || '.bin';
}

/** 去掉 URL 中明显的缩放/追踪参数，用于媒体去重与命名 */
const TRACKING_PARAMS = /^(utm_|ga_|fbclid|gclid|spm|from|ref|referrer|share_|_hs|wt_|mc_|igshid|yclid|msclkid)/i;

export function canonicalizeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.hash = '';
    /**
     * 只做"删除追踪参数"，**不能**用 searchParams 往返重写整个查询串：
     * CDN 的图片处理指令常常不是标准 key=value —— 小红书是 `?imageView2/format/png`。
     * 一旦走 searchParams 就会被编码成 `?imageView2%2Fformat%2Fpng=`，CDN 认不出来，
     * 于是原样返回上传时的原始文件（实测：本该是 PNG/JPG 的图变成了 HEIC，很多看图软件打不开）。
     * 这个函数的返回值同时被当成"下载地址"用，所以必须原样保留其余参数。
     */
    if (url.search) {
      const kept = url.search
        .slice(1)
        .split('&')
        .filter((pair) => {
          const name = pair.split('=')[0];
          if (!name) return false;
          let decoded = name;
          try {
            decoded = decodeURIComponent(name);
          } catch {
            /* 解不开就按原文判断 */
          }
          return !TRACKING_PARAMS.test(decoded);
        });
      url.search = kept.length ? `?${kept.join('&')}` : '';
    }
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) {
      url.port = '';
    }
    return url.toString();
  } catch {
    return String(rawUrl);
  }
}

export function isHttpUrl(value) {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export function isDataUrl(value) {
  return /^data:/i.test(String(value || ''));
}

export function isInlinePlaceholder(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return true;
  if (v.startsWith('data:')) {
    // 常见的 1x1 占位图
    return v.length < 400 || /base64,(r0lgod|ivborw)/.test(v);
  }
  if (v.startsWith('about:') || v === '#' || v.startsWith('javascript:')) return true;
  if (v.startsWith('blob:')) return true;
  return false;
}

export function humanBytes(bytes) {
  const n = Number(bytes) || 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)}${units[i]}`;
}

export function truncate(text, len = 300) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length <= len ? s : `${s.slice(0, len - 1)}…`;
}

/** 解析 srcset，返回候选中“最大”的那个 URL */
export function pickLargestFromSrcset(srcset) {
  if (!srcset || typeof srcset !== 'string') return null;
  const candidates = [];
  for (const part of srcset.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const bits = trimmed.split(/\s+/);
    const url = bits[0];
    if (!url) continue;
    let weight = 1;
    if (bits[1]) {
      const m = bits[1].match(/^([\d.]+)([wx])$/);
      if (m) weight = Number.parseFloat(m[1]) * (m[2] === 'x' ? 1000 : 1);
    }
    candidates.push({ url, weight });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.weight - a.weight);
  return candidates[0].url;
}
