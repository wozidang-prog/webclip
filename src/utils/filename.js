const RESERVED_WINDOWS = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export const DEFAULT_FILENAME_TEMPLATE = '{date}-{title}';

/** 模板可用占位符（README / 设置页会用到） */
export const FILENAME_PLACEHOLDERS = {
  '{date}': '发布日期（缺失时用抓取日期），YYYY-MM-DD',
  '{clipdate}': '抓取日期，YYYY-MM-DD',
  '{time}': '抓取时间，HHMMSS',
  '{datetime}': '抓取日期时间，YYYY-MM-DD_HHMMSS',
  '{title}': '文章标题',
  '{site}': '站点名（如 og:site_name）',
  '{host}': '域名',
  '{author}': '作者',
  '{id}': '文章 id',
  '{words}': '字数',
  '{lang}': '语言',
};

/** 生成可安全用于 HTTP 头 / 文件系统的文件名（保留中文） */
export function safeFilename(input, { maxLength = 80, fallback = 'document' } = {}) {
  let name = String(input ?? '')
    .normalize('NFKC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/["'`]/g, '')
    .replace(/[\s\u00a0]+/g, ' ')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
    .trim();

  if (!name) name = fallback;
  if (RESERVED_WINDOWS.test(name)) name = `${name}_`;
  if (name.length > maxLength) name = name.slice(0, maxLength).trim();
  return name || fallback;
}

/** HTTP 头里 filename* 的编码值上限（留足余量，别把多字节字符切一半） */
const MAX_ENCODED_FILENAME = 1200;

function encodeFilenameValue(name) {
  return encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * 构造 Content-Disposition 头。
 * HTTP 头只能是 latin1，所以中文文件名必须放进 filename*（RFC 5987），
 * 同时提供一个 ASCII 兜底名给不支持 filename* 的客户端/下载器。
 *
 * 两个坑（都踩过）：
 *  1. 不能直接对百分号编码后的字符串做 slice —— 中文一字 9 个字符，
 *     切到 300 正好把标题从中间截断（"… - 今日" 后面全没了，连"日"都被切成半个字节）；
 *  2. 兜底名必须可读，用文章 id 兜底会得到一串时间戳。
 */
export function contentDisposition(
  filename,
  { type = 'inline', asciiFallback = 'article.md', maxEncodedLength = MAX_ENCODED_FILENAME } = {},
) {
  // 这里不再二次截断长度：名字长度由 buildArticleFilename / FILENAME_MAX_LENGTH 决定
  let name = safeFilename(filename, { maxLength: 255, fallback: asciiFallback });
  let encoded = encodeFilenameValue(name);

  if (encoded.length > maxEncodedLength) {
    // 按字符比例收缩，只切在字符边界上
    const ratio = maxEncodedLength / encoded.length;
    name = name.slice(0, Math.max(1, Math.floor(name.length * ratio))).replace(/[\s\-_.]+$/, '');
    encoded = encodeFilenameValue(name);
    while (encoded.length > maxEncodedLength && name.length > 1) {
      name = name.slice(0, -1).replace(/[\s\-_.]+$/, '');
      encoded = encodeFilenameValue(name);
    }
  }

  const ascii = safeFilename(asciiFallback, { fallback: 'article.md' });
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * 给不支持 filename* 的客户端准备一个「可读的」ASCII 文件名：
 * 优先沿用文件名里本来就有的 ASCII 单词（"2026-09-14-Rust 1.80 发布" → "2026-09-14-Rust-1.80.md"），
 * 全是中文时退化成 `<日期>-<站点>-<短哈希>`（例如 `2026-09-14-toutiao-12e43e.md`），
 * 而不是一串时间戳。
 */
export function asciiFallbackName(filename, { host = '', date = '', hash = '' } = {}) {
  const base = String(filename || '').replace(/\.md$/i, '');
  const ascii = base
    .replace(/[^\x20-\x7e]/g, ' ')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/[-_.]{2,}/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '')
    .slice(0, 60);

  // 必须含真正的字母才算"可读"：只有数字（2026-09-14）没有信息量
  if (/[A-Za-z]/.test(ascii) && (ascii.match(/[A-Za-z]/g) || []).length >= 2) return `${ascii}.md`;

  const parts = [];
  if (date) parts.push(String(date).slice(0, 10));
  if (host) {
    const brand = String(host)
      .replace(/^www\./i, '')
      .split('.')
      .slice(-2)[0]
      .replace(/[^A-Za-z0-9-]/g, '');
    if (brand) parts.push(brand);
  }
  if (hash) parts.push(String(hash).slice(0, 6));
  return `${parts.filter(Boolean).join('-') || 'article'}.md`;
}

/** 兼容旧调用：从文章 id 生成 ASCII 兜底名 */
export function asciiFilenameFromId(id, extension = '.md') {
  const ascii = String(id || '')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/[-_.]{2,}/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '')
    .slice(0, 80);
  return `${ascii || 'article'}${extension}`;
}

/* ------------------------------------------------------------------ *
 * 文章自动命名
 * ------------------------------------------------------------------ */

const pad = (n) => String(n).padStart(2, '0');

function localDateParts(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`,
    datetime: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`,
  };
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

/** 单段清洗：只去掉文件系统非法字符，保留 + # % & ' 等合法字符（"C++" 不能被吃掉） */
export function sanitizeSegment(value) {
  return String(value ?? '')
    .normalize('NFKC')
    // 控制字符（含换行）换成空格，避免把两个词粘在一起
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/[\s\u00a0]+/g, ' ')
    .trim();
}

/**
 * 按模板生成文章文件名（不含扩展名）。
 *
 * 默认 `{date}-{title}`，例如 `2024-01-05-科技爱好者周刊（第 285 期）.md`：
 * 带日期便于归档排序，也能避免同名覆盖。
 *
 * @param {object} meta 文章的元信息（title / siteName / author / createdAt / published / stats.words ...）
 * @param {{template?: string, maxLength?: number, maxBytes?: number, extension?: string}} options
 */
export function buildArticleFilename(meta = {}, options = {}) {
  const {
    template = DEFAULT_FILENAME_TEMPLATE,
    maxLength = 100,
    /** 单个文件名的字节上限：ext4/NTFS 都是 255 字节，中文一个字 3 字节，必须按字节再收一次 */
    maxBytes = 200,
    extension = '.md',
  } = options;

  const clipped = localDateParts(meta.createdAt) || localDateParts(new Date());
  const published = localDateParts(meta.published);

  const values = {
    date: (published || clipped)?.date || '',
    clipdate: clipped?.date || '',
    time: clipped?.time || '',
    datetime: clipped?.datetime || '',
    title: sanitizeSegment(meta.title || ''),
    site: sanitizeSegment(meta.siteName || ''),
    host: sanitizeSegment(hostOf(meta.finalUrl || meta.url || '')),
    author: sanitizeSegment(meta.author || ''),
    id: sanitizeSegment(meta.id || ''),
    words: meta.stats?.words ?? meta.words ?? '',
    lang: sanitizeSegment(meta.lang || ''),
  };

  const raw = String(template || DEFAULT_FILENAME_TEMPLATE);
  let name = raw.replace(/\{(\w+)\}/g, (match, key) => {
    // 标题缺失时用域名兜底：绝不能用 id（时间是戳，看不出内容）
    if (key === 'title') return values.title || values.host || values.site || 'untitled';
    return key in values ? String(values[key] ?? '') : match;
  });

  // 收敛：模板里 {title} 为空时会留下多余分隔符
  name = name
    .replace(/[\s\u00a0]+/g, ' ')
    .replace(/([-_—–.．]\s*){2,}/g, '-')
    .replace(/^[\s\-_—–.．]+/, '')
    .replace(/[\s\-_—–.．]+$/, '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (name.length > maxLength) {
    name = name.slice(0, maxLength).replace(/[\s\-_—–.．]+$/, '').trim();
  }
  // 再按字节收一次：ext4/NTFS 的单个文件名上限是 255 字节，中文 3 字节/字
  if (typeof Buffer !== 'undefined') {
    const budget = Math.max(16, maxBytes - Buffer.byteLength(extension, 'utf8'));
    while (Buffer.byteLength(name, 'utf8') > budget && name.length > 1) {
      name = name.slice(0, -1);
    }
    name = name.replace(/[\s\-_—–.．]+$/, '').trim();
  }
  if (RESERVED_WINDOWS.test(name)) name = `${name}_`;
  // 兜底顺序讲究：绝不用文章 id（它是"时间戳-哈希-slug"，会被当成时间戳命名）
  if (!name) {
    name = values.title || values.host || values.site || 'article';
    if (!name || /^\d[\d\s\-_.:]*$/.test(name)) name = 'article';
  }

  return `${name}${extension}`;
}
