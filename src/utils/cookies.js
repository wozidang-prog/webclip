/**
 * 按站点取配置好的 Cookie。
 *
 * 用途：抖音、小红书这类"不登录基本看不了"的站点，把 Cookie 配在 .env 里，
 * 抓取时自动带上，不用每次请求都手动传 cookies 参数。
 * 优先级：请求参数 cookies > 这里的站点配置；两处都没有就是空串（不注入）。
 *
 * 匹配规则：先看内置的站点域名，再看 SITE_COOKIES 里的自定义域名；
 * 域名比较按"等于或子域"处理（www.douyin.com、v.douyin.com 都算 douyin.com）。
 */
import { config } from '../config.js';

/** 内置站点：域名后缀 → config.cookies 里的键 */
const BUILTIN_SITES = [
  { domain: 'douyin.com', key: 'douyin' },
  { domain: 'iesdouyin.com', key: 'douyin' },
  { domain: 'xiaohongshu.com', key: 'xiaohongshu' },
  { domain: 'xhslink.com', key: 'xiaohongshu' },
  // 小红书还有 .cn 的短链域名（https://xhslink.cn/o/xxxx），别漏
  { domain: 'xhslink.cn', key: 'xiaohongshu' },
];

/** 规范化域名：小写、去掉开头的点和 www. */
function normalizeDomain(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^\./, '')
    .replace(/^www\./, '');
}

function hostOf(rawUrl) {
  try {
    return normalizeDomain(new URL(String(rawUrl || '')).hostname);
  } catch {
    return '';
  }
}

function matches(host, domain) {
  return Boolean(host && domain) && (host === domain || host.endsWith(`.${domain}`));
}

/**
 * @param {string} rawUrl 页面地址（短链也可以，按短链域名匹配）
 * @returns {string} Cookie 字符串；没配置返回 ''
 */
export function siteCookieFor(rawUrl) {
  const host = hostOf(rawUrl);
  if (!host) return '';

  for (const site of BUILTIN_SITES) {
    if (!matches(host, site.domain)) continue;
    const value = config.cookies?.[site.key];
    if (value) return String(value).trim();
  }

  for (const [domain, value] of Object.entries(config.cookies?.sites || {})) {
    if (!value) continue;
    if (matches(host, normalizeDomain(domain))) return String(value).trim();
  }

  return '';
}

/** 当前配置了哪些站点（只回域名，不回 Cookie 内容，便于日志/排查） */
export function configuredCookieSites() {
  const sites = [];
  if (config.cookies?.douyin) sites.push('douyin.com', 'iesdouyin.com');
  if (config.cookies?.xiaohongshu) sites.push('xiaohongshu.com', 'xhslink.com');
  for (const [domain, value] of Object.entries(config.cookies?.sites || {})) {
    if (value) sites.push(normalizeDomain(domain));
  }
  return [...new Set(sites)];
}
