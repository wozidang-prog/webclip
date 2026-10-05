import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { REMOVE_SELECTORS, LIGHT_SELECTORS, isKeepEmbed, looksLikeJunkToken } from '../adblock/rules.js';
import { convertBackgroundImages, prunePlayerChrome, promotePosterAttributes } from './dom-media.js';
import { pickLargestFromSrcset, isInlinePlaceholder, truncate } from '../utils/text.js';
import { logger } from '../utils/logger.js';

const log = logger.child({ mod: 'extract' });

const PROTECTED_SELECTORS = ['html', 'body', 'main', 'article', '[role="main"]', '#content', '#main'];

const JUNK_HEADING_RE = new RegExp(
  [
    '^related( posts| articles| stories| content| reading)?$',
    '^recommended( for you| reads| articles)?$',
    '^you may also like$',
    '^more (from|like this|stories|articles)$',
    '^read (more|next|also)$',
    '^popular( posts| now)?$',
    '^trending( now)?$',
    '^editor.?s picks$',
    '^sponsored( content)?$',
    '^advertisement$',
    '^advertising$',
    '^promoted$',
    '^sign up( for our newsletter)?$',
    '^subscribe( now)?$',
    '^newsletter$',
    '^share (this|it)$',
    '^comments?( \\(\\d+\\))?$',
    '^leave a (reply|comment)$',
    '^tags?$',
    '^about the author$',
    '^disclosures?$',
    '^相关(阅读|推荐|文章|链接|内容)$',
    '^推荐(阅读|内容|文章)?$',
    '^猜你喜欢$',
    '^广告$',
    '^赞助(内容)?$',
    '^推广$',
    '^热门(推荐|文章|阅读)?$',
    '^更多(阅读|内容|文章)?$',
    '^评论(区)?$',
    '^分享(到)?$',
    '^标签$',
    '^作者简介$',
    '^关于作者$',
    '^扫码关注$',
    '^关注我们$',
  ].join('|'),
  'i',
);

export function parseHtml(html, url) {
  const dom = new JSDOM(html, { url, contentType: 'text/html' });
  return { dom, document: dom.window.document };
}

function removeAll(document, selector) {
  let count = 0;
  let nodes;
  try {
    nodes = document.querySelectorAll(selector);
  } catch {
    return 0;
  }
  for (const el of nodes) {
    if (!el.isConnected) continue;
    if (PROTECTED_SELECTORS.some((s) => el.matches?.(s))) continue;
    el.remove();
    count += 1;
  }
  return count;
}

function textLength(el) {
  return (el?.textContent || '').replace(/\s+/g, '').length;
}

/** 链接密度：文本里有多少比例来自 <a> */
function linkDensity(el) {
  const total = textLength(el);
  if (!total) return 0;
  let linked = 0;
  for (const a of el.querySelectorAll('a')) linked += textLength(a);
  return Math.min(1, linked / total);
}

/** 1x1 / 透明占位图 / 追踪像素 */
export function isTrackingPixel(img) {
  const w = Number.parseInt(img.getAttribute('data-wc-w') || img.getAttribute('width') || '0', 10);
  const h = Number.parseInt(img.getAttribute('data-wc-h') || img.getAttribute('height') || '0', 10);
  if (w > 0 && h > 0 && w <= 2 && h <= 2) return true;
  const src = (img.getAttribute('src') || '').toLowerCase();
  if (/\/1x1\.(gif|png|jpe?g)/.test(src) || /spacer|blank\.gif|pixel\.gif|transparent\.gif/.test(src)) return true;
  if (/^data:image\/gif;base64,R0lGODlhAQABAI/.test(src) && (img.getAttribute('src') || '').length < 200) return true;
  return false;
}

/**
 * 展开"标题被永久链接整段包住"的写法（MDN、GitHub Docs 等）：
 *   <h2><a href="#anchor">What is JavaScript?</a></h2> → <h2>What is JavaScript?</h2>
 * 只在标题文字**全部**位于链接内时才展开，避免误伤 "## 参见 [文档](url)"。
 */
export function unwrapHeadingLinks(document) {
  let unwrapped = 0;
  for (const heading of document.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const anchors = [...heading.querySelectorAll('a')];
    if (!anchors.length) continue;
    const headingText = textLength(heading);
    const linkedText = anchors.reduce((acc, a) => acc + textLength(a), 0);
    const hasMedia = Boolean(heading.querySelector('img, svg, video'));
    if (hasMedia || headingText === 0 || linkedText < headingText) continue;
    for (const anchor of anchors) {
      if (!anchor.parentNode) continue;
      anchor.replaceWith(...anchor.childNodes);
      unwrapped += 1;
    }
  }
  return unwrapped;
}

/** 绝对化所有 URL（含懒加载属性、srcset、poster、href） */
export function absolutizeUrls(document, baseUrl) {
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    return;
  }
  const abs = (value) => {
    if (!value) return value;
    const v = String(value).trim();
    if (!v || v.startsWith('data:') || v.startsWith('blob:') || v.startsWith('about:') || v.startsWith('javascript:')) return v;
    try {
      return new URL(v, base).toString();
    } catch {
      return v;
    }
  };
  for (const el of document.querySelectorAll('[src], [href], [poster], [data-src], [srcset], [data-srcset]')) {
    for (const attr of ['src', 'href', 'poster', 'data-src']) {
      const value = el.getAttribute?.(attr);
      if (value) el.setAttribute(attr, abs(value));
    }
    const srcset = el.getAttribute?.('srcset');
    if (srcset) {
      const rewritten = srcset
        .split(',')
        .map((part) => {
          const bits = part.trim().split(/\s+/);
          if (!bits[0]) return part;
          bits[0] = abs(bits[0]);
          return bits.join(' ');
        })
        .join(', ');
      el.setAttribute('srcset', rewritten);
    }
  }
}

/**
 * DOM 清洗。mode = 'full' 时激进（含 class/id 词元、导航、订阅框等），
 * 'light' 只删脚本样式与明确的广告位——用于激进清洗后正文过短的兜底重试。
 */
export function cleanDocument(document, options = {}) {
  const {
    mode = 'full',
    extraRemoveSelectors = [],
    baseUrl = '',
    removeIframesOutsideAllowlist = true,
  } = options;

  const stats = { removedSelectors: 0, removedByToken: 0, removedPixels: 0, removedJunkSections: 0 };

  stats.removedSelectors += removeAll(
    document,
    ['script', 'style', 'noscript', 'template', 'link', 'meta', 'base', 'object', 'embed', 'applet', 'canvas', 'svg use', 'form', 'input', 'select', 'textarea', 'button', 'dialog', '[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]'].join(','),
  );

  // iframe：只保留白名单里的视频/代码托管嵌入
  if (removeIframesOutsideAllowlist) {
    for (const iframe of [...document.querySelectorAll('iframe')]) {
      const src = iframe.getAttribute('src') || '';
      if (!src || !isKeepEmbed(src)) {
        iframe.remove();
        stats.removedSelectors += 1;
      }
    }
  }

  const selectors =
    mode === 'light'
      ? [...LIGHT_SELECTORS, ...extraRemoveSelectors]
      : [
          ...REMOVE_SELECTORS.filter(
            (s) =>
              !/^(script|style|noscript|template|link|meta|base|object|embed|applet|canvas|map|form|input|select|textarea|button|dialog)$/.test(
                s,
              ),
          ),
          ...extraRemoveSelectors,
        ];
  stats.removedSelectors += removeAll(document, selectors.join(','));

  // 关键顺序：先把"背景图当正文配图"的容器换成真 <img>，再绝对化 URL、再删空节点。
  // 否则这类没有文字的 div 会在下面被当空容器删掉（今日头条的正文配图就是这样丢的）。
  stats.bgImagesConverted = convertBackgroundImages(document);
  // 播放器 UI（"暂停""进入全屏"等）和封面属性，同样要在正文抽取前处理
  stats.playerChromeRemoved = prunePlayerChrome(document);
  stats.postersPromoted = promotePosterAttributes(document);

  if (baseUrl) absolutizeUrls(document, baseUrl);

  // 追踪像素
  for (const img of [...document.querySelectorAll('img')]) {
    if (isTrackingPixel(img)) {
      img.remove();
      stats.removedPixels += 1;
    }
  }

  // class/id 词元级清理（仅激进模式）
  if (mode === 'full') {
    const candidates = document.body ? [...document.body.querySelectorAll('*')] : [];
    for (const el of candidates) {
      if (!el.isConnected) continue;
      if (PROTECTED_SELECTORS.some((s) => el.matches?.(s))) continue;
      const cls = el.getAttribute('class');
      const id = el.getAttribute('id');
      const role = el.getAttribute('role');
      if (role === 'navigation' || role === 'banner' || role === 'contentinfo' || role === 'complementary' || role === 'search') {
        el.remove();
        stats.removedByToken += 1;
        continue;
      }
      if ((cls && looksLikeJunkToken(cls)) || (id && looksLikeJunkToken(id))) {
        el.remove();
        stats.removedByToken += 1;
      }
    }
  }

  // 标题里的永久链接（MDN 等）：把标题文字从 <a> 里解放出来
  stats.unwrappedHeadings = unwrapHeadingLinks(document);

  // 代码块语言：Readability 会丢掉 class，先备份成 data-lang
  for (const pre of document.querySelectorAll('pre')) {
    const code = pre.querySelector('code') || pre;
    const cls = code.getAttribute('class') || '';
    const m = cls.match(/(?:language|lang|highlight|brush:|prettyprint)[-_:]?([a-z0-9+#]+)/i);
    if (m) pre.setAttribute('data-lang', m[1].toLowerCase());
  }

  // 空的 / 纯装饰节点
  for (const el of [...document.querySelectorAll('p, div, section, span, figure, li, td')]) {
    if (!el.isConnected) continue;
    if (el.querySelector('img, video, audio, iframe, pre, table, code')) continue;
    const txt = (el.textContent || '').replace(/[\s\u00a0\u200b]+/g, '');
    if (txt.length === 0) {
      el.remove();
      continue;
    }
    // 纯链接、无实义文本的块（导航 / 相关阅读 / 广告位）
    if (mode === 'full' && txt.length < 120) {
      const links = el.querySelectorAll('a');
      if (links.length >= 3 && linkDensity(el) > 0.8) {
        el.remove();
        stats.removedJunkSections += 1;
      }
    }
  }

  return stats;
}

/**
 * 删除"用 App 打开 / 扫码下载 App"这类推广块。
 * 它们通常是一小段文字 + 一个链接或二维码图片，几乎出现在所有国内内容站上，
 * 判定条件：文字很短、命中关键词、且块内有链接或图片。
 */
const APP_PROMO_RE = /(扫码|扫一扫|打开\s*APP|打开.{0,4}(应用|客户端)|下载.{0,8}(APP|应用|客户端)|用\s*APP\s*看|继续在.{0,6}中查看|打开.{0,6}继续阅读)/i;

export function removeAppPromoBlocks(document) {
  let removed = 0;
  const candidates = [...document.querySelectorAll('div, section, p, aside, a, span')];
  for (const el of candidates) {
    if (!el.isConnected || !el.parentNode) continue;
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 60) continue;
    if (!APP_PROMO_RE.test(text)) continue;
    if (!el.querySelector('a, img, button')) continue;
    // 整段就是推广才删；里面还裹着大量正文的容器不动
    if (textLength(el) > 60) continue;
    el.remove();
    removed += 1;
  }
  return removed;
}

/**
 * 删除“相关阅读 / 广告 / 评论 / 分享”这类段落。
 * 判定条件：标题命中关键词，且该段落链接密度高或内容极短。
 */
export function removeJunkSections(document) {
  let removed = 0;
  const headings = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')];
  for (const heading of headings) {
    if (!heading.isConnected) continue;
    const text = (heading.textContent || '').trim();
    if (!text || text.length > 30) continue;
    if (!JUNK_HEADING_RE.test(text)) continue;

    const level = Number.parseInt(heading.tagName.slice(1), 10);
    const section = [];
    let node = heading.nextElementSibling;
    while (node) {
      const tag = node.tagName;
      if (/^H[1-6]$/.test(tag) && Number.parseInt(tag.slice(1), 10) <= level) break;
      section.push(node);
      node = node.nextElementSibling;
    }
    const totalText = section.reduce((acc, el) => acc + textLength(el), 0);
    const totalLinks = section.reduce((acc, el) => acc + el.querySelectorAll('a').length, 0);
    const density = section.length ? section.reduce((acc, el) => acc + linkDensity(el), 0) / section.length : 0;
    const looksLikeJunk = totalText === 0 || (totalText < 400 && totalLinks >= 3) || density > 0.5;
    if (looksLikeJunk) {
      for (const el of section) el.remove();
      heading.remove();
      removed += 1;
    }
  }
  return removed;
}

/**
 * 解码字符串里的 JS 转义。
 * 有些站点（例如微信公众号）把描述写进 meta 时没解码，留下字面量 \x0a / \n 之类，
 * 直接输出会变成正文里的乱码。
 */
export function decodeTextEscapes(value) {
  return String(value ?? '')
    .replace(/\\x0a|\\n|\\u000a/gi, '\n')
    .replace(/\\x0d|\\r|\\u000d/gi, '')
    .replace(/\\x09|\\t|\\u0009/gi, ' ')
    .replace(/\\u003c/gi, '<')
    .replace(/\\u003e/gi, '>')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u002f/gi, '/')
    .replace(/\\x26/gi, '&')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\//g, '/');
}

/** 从原文档抽取元信息（在清洗前调用，信息最全） */
export function extractMetadata(document, baseUrl) {
  const meta = (selector, attr = 'content') => document.querySelector(selector)?.getAttribute(attr) || '';
  const clean = (s) => decodeTextEscapes(String(s || '')).replace(/\s+/g, ' ').trim();

  const title =
    clean(meta('meta[property="og:title"]')) ||
    clean(meta('meta[name="twitter:title"]')) ||
    clean(document.querySelector('h1')?.textContent) ||
    clean(document.title);

  const description =
    clean(meta('meta[property="og:description"]')) ||
    clean(meta('meta[name="description"]')) ||
    clean(meta('meta[name="twitter:description"]'));

  const author =
    clean(meta('meta[name="author"]')) ||
    clean(meta('meta[property="article:author"]')) ||
    clean(meta('meta[name="twitter:creator"]')) ||
    clean(document.querySelector('[rel="author"], .author-name, [itemprop="author"] [itemprop="name"], [itemprop="author"]')?.textContent);

  const published =
    clean(meta('meta[property="article:published_time"]')) ||
    clean(meta('meta[name="date"]')) ||
    clean(meta('meta[name="pubdate"]')) ||
    clean(meta('meta[name="publishdate"]')) ||
    clean(document.querySelector('time[datetime]')?.getAttribute('datetime')) ||
    clean(document.querySelector('time')?.textContent);

  const modified =
    clean(meta('meta[property="article:modified_time"]')) || clean(meta('meta[name="lastmod"]'));

  const siteName = clean(meta('meta[property="og:site_name"]')) || clean(meta('meta[name="application-name"]'));
  const canonical = clean(document.querySelector('link[rel="canonical"]')?.getAttribute('href')) || baseUrl;
  const image = clean(meta('meta[property="og:image"]')) || clean(meta('meta[name="twitter:image"]'));
  const lang = clean(document.documentElement?.getAttribute('lang')) || '';
  const keywords = clean(meta('meta[name="keywords"]'));

  const publishedIsoTarget = published;
  let publishedIso = '';
  if (publishedIsoTarget) {
    const d = new Date(publishedIsoTarget);
    if (!Number.isNaN(d.getTime())) publishedIso = d.toISOString();
  }

  return {
    title,
    /** 保留换行版本，正文为空时可以当导语用 */
    descriptionRaw: decodeTextEscapes(meta('meta[property="og:description"]') || meta('meta[name="description"]'))
      .replace(/[ \t\u00a0]+/g, ' ')
      .trim(),
    description,
    author,
    published: publishedIso || published || '',
    modified: modified || '',
    siteName,
    canonical,
    image,
    lang,
    keywords,
    excerpt: truncate(description, 300),
  };
}

/**
 * 去掉标题里的站点后缀（"标题 | 站点名" / "标题 - 站点名" / "标题 · 站点名"）。
 * 只有当被切掉的部分确实像站点名时才切，避免误伤「Rust 1.80 - 新特性」这类标题。
 */
export function tidyTitle(raw, { siteName = '', hostname = '' } = {}) {
  const title = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!title) return '';

  const site = String(siteName || '').toLowerCase().trim();
  const host = String(hostname || '').replace(/^www\./i, '').toLowerCase().trim();
  const hostWords = host ? [host, host.split('.')[0]] : [];

  const parts = title
    .split(/\s+[|\-–—·»]\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return title;

  const matchesSite = (part) => {
    const p = part.toLowerCase().trim();
    if (!p || p.length > 60) return false;
    if (site && (p === site || site.startsWith(p) || p.startsWith(site))) return true;
    return hostWords.some((w) => w.length > 2 && (p === w || p.startsWith(`${w} `) || p.endsWith(` ${w}`)));
  };

  const kept = parts.filter((p) => !matchesSite(p));
  if (!kept.length || kept.length === parts.length) return title;
  return kept.reduce((a, b) => (b.length > a.length ? b : a));
}

/**
 * 主入口：HTML → 干净正文 HTML。
 * 先做激进清洗 + Readability；若结果过短，退回轻度清洗重试。
 */
export function extractArticle({ html, url, options = {} }) {
  const {
    extraRemoveSelectors = [],
    readabilityCharThreshold = 180,
    minGoodLength = 220,
    aggressive = true,
  } = options;

  const { dom, document } = parseHtml(html, url);
  const metadata = extractMetadata(document, url);

  const attempts = aggressive
    ? [
        { mode: 'full', removeJunk: true },
        { mode: 'light', removeJunk: false },
      ]
    : [{ mode: 'light', removeJunk: false }];

  let best = null;
  for (const [index, attempt] of attempts.entries()) {
    const clone = document.cloneNode(true);
    const cleanStats = cleanDocument(clone, {
      mode: attempt.mode,
      extraRemoveSelectors,
      baseUrl: url,
    });

    let parsed = null;
    try {
      parsed = new Readability(clone, {
        charThreshold: readabilityCharThreshold,
        keepClasses: false,
        disableJSONLD: false,
        nbTopCandidates: 6,
      }).parse();
    } catch (err) {
      log.debug('Readability 解析异常', { err: err.message, mode: attempt.mode });
    }

    const fallbackHtml = clone.body ? clone.body.innerHTML : '';
    const contentHtml = parsed?.content || fallbackHtml;
    const text = (parsed?.textContent || clone.body?.textContent || '').replace(/\s+/g, ' ').trim();

    const candidate = {
      contentHtml,
      text,
      title: parsed?.title || metadata.title,
      byline: parsed?.byline || metadata.author,
      excerpt: parsed?.excerpt || metadata.excerpt,
      siteName: parsed?.siteName || metadata.siteName,
      lang: parsed?.lang || metadata.lang,
      length: text.length,
      cleanStats,
      mode: attempt.mode,
      readabilityOk: Boolean(parsed),
    };

    if (!best || candidate.length > best.length) best = candidate;
    if (candidate.length >= minGoodLength && index === 0) break;
  }

  // 对最终内容做二次清理（Readability 输出可能带回残留垃圾）
  const { document: doc2 } = parseHtml(
    `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><article id="wc-root">${best.contentHtml}</article></body></html>`,
    url,
  );
  const root = doc2.getElementById('wc-root');
  const postStats = cleanDocument(root.ownerDocument, {
    mode: aggressive ? 'full' : 'light',
    baseUrl: url,
    removeIframesOutsideAllowlist: true,
  });
  if (aggressive) {
    postStats.removedJunkSections += removeJunkSections(root);
    postStats.removedAppPromo = removeAppPromoBlocks(root);
  }

  /**
   * 正文几乎为空、但页面给了 description 时，把描述当导语补上。
   * 典型场景：微信"图片消息"这类以图为主的内容，正文文字只有页面描述那一小段。
   * 只在正文极少（< 40 字）时才用，避免与真实正文重复。
   */
  const bodyText = (root.textContent || '').replace(/\s+/g, '');
  const descriptionRaw = metadata.descriptionRaw || '';
  if (aggressive && bodyText.length < 40 && descriptionRaw.length >= 8) {
    const paragraphs = descriptionRaw
      .split(/\n{1,}/)
      .map((line) => line.trim())
      .filter(Boolean);
    // 描述首行常常就是标题，去掉避免重复
    const filtered = paragraphs.filter((line, index) => !(index === 0 && line === best.title));
    if (filtered.length) {
      const doc = root.ownerDocument;
      for (const line of filtered.reverse()) {
        const p = doc.createElement('p');
        p.setAttribute('data-wc-from-description', '1');
        p.textContent = line;
        root.insertBefore(p, root.firstChild);
      }
      postStats.descriptionUsed = true;
    }
  }

  let hostname = '';
  try {
    hostname = new URL(url).hostname;
  } catch {
    hostname = '';
  }
  const finalTitle = tidyTitle(metadata.title || best.title, {
    siteName: metadata.siteName || best.siteName,
    hostname,
  });

  return {
    metadata: {
      ...metadata,
      title: finalTitle || metadata.title,
      author: best.byline || metadata.author,
    },
    article: {
      title: finalTitle || best.title || metadata.title,
      byline: best.byline || metadata.author || '',
      excerpt: best.excerpt || metadata.excerpt,
      siteName: best.siteName || metadata.siteName,
      lang: best.lang || metadata.lang || 'zh-CN',
      contentHtml: root.innerHTML,
      textContent: (root.textContent || '').replace(/\s+/g, ' ').trim(),
      mode: best.mode,
      readabilityOk: best.readabilityOk,
    },
    /** 供媒体本地化就地改写的节点（调用方改完后用 root.innerHTML 取最新 HTML） */
    root,
    document: doc2,
    stats: mergeCleanStats(best.cleanStats, postStats, { contentLength: best.length, mode: best.mode }),
  };
}

/** 主清洗与二次清洗的统计需要累加，而不是互相覆盖 */
function mergeCleanStats(primary = {}, secondary = {}, extra = {}) {
  const merged = { ...extra };
  for (const key of Object.keys({ ...primary, ...secondary })) {
    merged[key] = (Number(primary[key]) || 0) + (Number(secondary[key]) || 0);
  }
  return merged;
}

export { pickLargestFromSrcset, isInlinePlaceholder };
