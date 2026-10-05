/**
 * 从页面内嵌数据里捞媒体地址。
 *
 * 为什么需要它：越来越多页面（微信"图片消息"、Next.js/Nuxt 站点、各类 SPA）
 * 把正文和配图放在 <script> 里的 JSON/JS 数据中，由前端 JS 渲染，
 * 甚至只在轮播滑动时才懒加载。此时：
 *   · 静态 HTML 里根本没有 <img>（fetch 引擎什么都看不到）
 *   · 浏览器引擎里也只有可视区域那一两张（swiper 只加载当前页）
 * 虽然图片本身完全能下载，但它们**从未进入流水线**。
 *
 * 这里用纯文本（不依赖 JS 执行）把数据里的媒体地址挖出来兜底，
 * 由调用方决定要不要把它们补进正文。
 */
import { canonicalizeUrl } from '../utils/text.js';
import { isBlockedUrl, isUiAssetUrl } from '../adblock/rules.js';

/** 扩展名就能看出来的媒体 */
const MEDIA_EXT_RE = /\.(jpe?g|png|gif|webp|avif|bmp|svg|tiff?|heic|mp4|m4v|webm|mov|mkv|m3u8|mpd|mp3|m4a|aac|ogg|oga|flac|opus)(\?|#|$)/i;
const VIDEO_EXT_RE = /\.(mp4|m4v|webm|mov|mkv|m3u8|mpd)(\?|#|$)/i;
const AUDIO_EXT_RE = /\.(mp3|m4a|aac|ogg|oga|flac|opus)(\?|#|$)/i;

/**
 * 没有扩展名但明显是图片 CDN 的地址（微信 / 头条 / 阿里 / B 站 / 知乎 …）
 * 这些站点的图片地址常常长成 .../xxx?wx_fmt=jpeg 或 ~tplv-xxx.jpeg
 */
const IMAGE_CDN_HINT_RE = /(wx_fmt=|qpic\.cn|~tplv-|imageView2|imageMogr2|x-oss-process=image|!watermark|mmbiz_|sinaimg\.cn|pstatp\.com|toutiaoimg\.com|hdslb\.com|zhimg\.com|alicdn\.com|cloudinary|imgix\.net|\/img\d*\/|image\/|photo\/|picture_page)/i;

/** 头像/图标/二维码这类噪音（出现在 URL 或数据键名里就跳过） */
const NOISE_RE = /(avatar|head_?img|headimg|icon|logo|qrcode|qr_?code|emoji|sprite|badge|favicon|placeholder|blank\.gif|spacer|1x1)/i;

/**
 * 站点的代码/UI 资源目录：里面几乎不可能是正文配图，
 * 却常出现图标、音效、占位图（例如 res.wx.qq.com/mmbizappmsg/.../js/images/pic_like.png）。
 */
const UI_ASSET_PATH_RE = /\/(js|css|fonts?|htmledition|webpack|chunks?)\//i;

function decodeJsEscapes(text) {
  return text
    .replace(/\\u003c/gi, '<')
    .replace(/\\u003e/gi, '>')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u002f/gi, '/')
    .replace(/\\x3c/gi, '<')
    .replace(/\\x3e/gi, '>')
    .replace(/\\x26/gi, '&')
    .replace(/\\x2f/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'");
}

/** 取出所有 script 内容（只保留够长的，短的通常是配置片段） */
export function extractScriptBodies(html) {
  const bodies = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html))) {
    const body = match[1];
    if (body && body.length > 40) bodies.push(decodeJsEscapes(body));
  }
  return bodies;
}

function kindOf(url) {
  if (VIDEO_EXT_RE.test(url)) return 'video';
  if (AUDIO_EXT_RE.test(url)) return 'audio';
  return 'image';
}

function resolveUrl(raw, baseUrl) {
  const value = raw.trim();
  try {
    if (/^\/\//.test(value)) return new URL(`https:${value}`).toString();
    if (/^https?:\/\//i.test(value)) return new URL(value).toString();
    if (value.startsWith('/') && baseUrl) return new URL(value, baseUrl).toString();
  } catch {
    return null;
  }
  return null;
}

function looksLikeMedia(raw, contextKey = '') {
  if (!raw || raw.length < 12) return false;
  if (/^(data:|blob:|javascript:|about:|mailto:)/i.test(raw)) return false;
  if (!/^(https?:)?\/\//i.test(raw) && !raw.startsWith('/')) return false;
  if (NOISE_RE.test(raw) || NOISE_RE.test(contextKey)) return false;
  // 站点自身的 UI 资源（播放器动画、图标）不是内容
  if (isUiAssetUrl(raw)) return false;

  // 纯域名（例如页面里 dns-prefetch 的 "https://mmbiz.qpic.cn/"）不是媒体
  try {
    const parsed = new URL(/^\/\//.test(raw) ? `https:${raw}` : raw, 'https://placeholder.invalid');
    const path = parsed.pathname || '';
    if (path.length <= 1) return false;
    if (UI_ASSET_PATH_RE.test(path) && !/\.(jpe?g|png|gif|webp|avif)$/i.test(path)) return false;
  } catch {
    return false;
  }

  return MEDIA_EXT_RE.test(raw) || IMAGE_CDN_HINT_RE.test(raw);
}

/**
 * @returns {Array<{url: string, kind: 'image'|'video'|'audio', key: string}>}
 */
export function collectEmbeddedMediaUrls(html, { baseUrl = '', limit = 60, skipUrls = new Set() } = {}) {
  const results = new Map();
  const bodies = extractScriptBodies(html);

  for (const body of bodies) {
    const re = /["']([^"'\s\\]{12,800})["']/g;
    let match;
    while ((match = re.exec(body))) {
      const raw = match[1];
      // 取紧邻的键名做噪音判断，例如 round_head_img: 'http://...'
      const contextKey = (body.slice(Math.max(0, match.index - 60), match.index).match(/([A-Za-z_][A-Za-z0-9_]{1,30})\s*[:=]\s*$/) || [])[1] || '';
      if (!looksLikeMedia(raw, contextKey)) continue;

      const url = resolveUrl(raw, baseUrl);
      if (!url) continue;
      if (isBlockedUrl(url, { resourceType: 'image' })) continue;

      const key = canonicalizeUrl(url);
      if (skipUrls.has(key) || results.has(key)) continue;
      results.set(key, { url, kind: kindOf(url), key: contextKey });
      if (results.size >= limit) return [...results.values()];
    }
  }

  return [...results.values()];
}
