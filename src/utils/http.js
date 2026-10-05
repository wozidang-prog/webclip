/**
 * 从 HTTP 响应里判断编码并解码 HTML。
 * 优先 Content-Type，其次 <meta charset>，最后按 UTF-8 处理。
 */
export function detectCharset(buffer, contentType = '') {
  const fromHeader = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType || '')?.[1];
  if (fromHeader) return fromHeader.toLowerCase();

  const head = buffer.subarray(0, 8192).toString('latin1');
  const fromMeta =
    /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1] ||
    /<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([\w-]+)/i.exec(head)?.[1] ||
    /<\?xml[^>]+encoding\s*=\s*["']([\w-]+)/i.exec(head)?.[1];
  return fromMeta ? fromMeta.toLowerCase() : 'utf-8';
}

export function decodeHtmlBuffer(buffer, contentType = '') {
  const charset = detectCharset(buffer, contentType);
  const normalize = (c) => (c === 'gb2312' || c === 'gbk' || c === 'gb18030' ? 'gb18030' : c);
  try {
    return new TextDecoder(normalize(charset), { fatal: false }).decode(buffer);
  } catch {
    try {
      return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
    } catch {
      return buffer.toString('utf8');
    }
  }
}

export function buildCookieHeader(cookies) {
  if (!cookies) return '';
  if (typeof cookies === 'string') return cookies.trim();
  if (Array.isArray(cookies)) {
    return cookies
      .map((c) => (typeof c === 'string' ? c : c?.name && c?.value ? `${c.name}=${c.value}` : ''))
      .filter(Boolean)
      .join('; ');
  }
  if (typeof cookies === 'object') {
    return Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
  return '';
}
