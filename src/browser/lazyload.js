/**
 * 在页面上下文中执行：把各种懒加载写法“扶正”成真实的 src / srcset。
 * 该函数会被 page.evaluate 序列化，必须自包含，不能引用外部变量。
 */
export function fixLazyMediaInPage() {
  const LAZY_ATTRS = [
    'data-src',
    'data-original',
    'data-original-src',
    'data-lazy',
    'data-lazy-src',
    'data-lazyload',
    'data-actualsrc',
    'data-echo',
    'data-url',
    'data-image',
    'data-image-src',
    'data-img',
    'data-thumb',
    'data-thumbnail',
    'data-hi-res-src',
    'data-large',
    'data-large-file',
    'data-full',
    'data-full-src',
    'data-medium-file',
    'data-orig-file',
    'data-defer-src',
    'data-delayed-url',
    'data-cfsrc',
    'data-ll-src',
    'data-real-src',
    'data-webp',
    'data-jpg',
  ];

  const pickLargest = (srcset) => {
    if (!srcset || typeof srcset !== 'string') return null;
    let best = null;
    let bestWeight = -1;
    for (const part of srcset.split(',')) {
      const bits = part.trim().split(/\s+/);
      if (!bits[0]) continue;
      let weight = 1;
      const desc = bits[1] || '';
      const m = desc.match(/^([\d.]+)([wx])$/);
      if (m) weight = parseFloat(m[1]) * (m[2] === 'x' ? 1000 : 1);
      if (weight > bestWeight) {
        bestWeight = weight;
        best = bits[0];
      }
    }
    return best;
  };

  const PLACEHOLDER_RE = /(^|[/_\-.=])(placeholder|blank|spacer|transparent|1x1|pixel|loading|lazy|dummy|grey|gray|default|no[-_]?image|unavailable|temp|trans)([/_\-.=]|$)/i;
  const isPlaceholder = (value) => {
    const url = String(value || '').trim();
    if (!url) return true;
    if (/^(data:|about:|blob:|javascript:)/i.test(url)) return true;
    try {
      const pathname = new URL(url, location.href).pathname;
      return PLACEHOLDER_RE.test(pathname);
    } catch {
      return PLACEHOLDER_RE.test(url);
    }
  };

  let fixed = 0;

  // <picture><source srcset> → 取最大候选
  document.querySelectorAll('picture source[srcset], source[data-srcset]').forEach((source) => {
    const raw = source.getAttribute('srcset') || source.getAttribute('data-srcset');
    const best = pickLargest(raw);
    if (best) {
      source.setAttribute('srcset', best);
      fixed += 1;
    }
  });

  document.querySelectorAll('img').forEach((img) => {
    const candidates = [];
    const srcsetBest = pickLargest(img.getAttribute('srcset') || img.getAttribute('data-srcset'));
    if (srcsetBest && !isPlaceholder(srcsetBest)) candidates.push({ url: srcsetBest, score: 3 });
    for (const attr of LAZY_ATTRS) {
      const value = img.getAttribute(attr);
      if (value && !isPlaceholder(value)) candidates.push({ url: value.trim(), score: 3 });
    }
    const currentSrc = img.currentSrc || img.src;
    if (currentSrc && currentSrc !== 'about:blank') {
      candidates.push({ url: currentSrc, score: isPlaceholder(currentSrc) ? 0 : 2 });
    }
    candidates.sort((a, b) => b.score - a.score);
    const chosen = candidates[0]?.url || null;
    if (chosen) {
      if (img.getAttribute('src') !== chosen) {
        img.setAttribute('src', chosen);
        fixed += 1;
      }
      if (img.getAttribute('srcset')) img.removeAttribute('srcset');
      for (const attr of LAZY_ATTRS) img.removeAttribute(attr);
    }
    img.removeAttribute('loading');
    img.removeAttribute('decoding');
    // 处理 background-image 伪装成图片的情况
    if (!img.getAttribute('src')) {
      const style = img.getAttribute('style') || '';
      const m = style.match(/url\((['"]?)([^'")]+)\1\)/);
      if (m && m[2] && !/^data:/.test(m[2])) img.setAttribute('src', m[2]);
    }
    // 记录声明尺寸，便于后续过滤 1x1 追踪像素
    const w = parseInt(img.getAttribute('width') || '0', 10);
    const h = parseInt(img.getAttribute('height') || '0', 10);
    if (w > 0) img.setAttribute('data-wc-w', String(w));
    if (h > 0) img.setAttribute('data-wc-h', String(h));
  });

  document.querySelectorAll('video, audio').forEach((el) => {
    if (!el.getAttribute('src')) {
      for (const attr of ['data-src', 'data-url', 'data-lazy-src', 'data-video-src']) {
        const value = el.getAttribute(attr);
        if (value) {
          el.setAttribute('src', value);
          fixed += 1;
          break;
        }
      }
    }
    el.removeAttribute('autoplay');
    // 封面常挂在播放器容器的 data-poster/tt-poster 上，搬到 poster 才能被识别
    if (!el.getAttribute('poster')) {
      let node = el;
      for (let depth = 0; node && depth < 4 && !el.getAttribute('poster'); depth += 1) {
        for (const attr of ['poster', 'data-poster', 'tt-poster', 'data-cover', 'data-pic', 'data-thumb']) {
          const value = (node.getAttribute?.(attr) || '').trim();
          if (value && !/^(data:|blob:|javascript:)/i.test(value)) {
            el.setAttribute('poster', value);
            break;
          }
        }
        node = node.parentElement;
      }
    }
  });

  // 删掉播放器自带的 UI 文字（"暂停""00:09 / 00:25""进入全屏"），只留媒体本身
  const PLAYER_CONTAINER_RE = /(video-?box|video-?container|video-?wrapper|video-?player|media-?player|tt-video|player-?container|artplayer|dplayer|prism-?player|xgplayer)/i;
  const PLAYER_UI_RE = /(control|controls|bar|btn|button|prompt|loading|poster|play|pause|time|fullscreen|volume|progress|mask|overlay|masking|error|enter|replay|tips|switch|danmaku|barrage|logo|icon)/i;
  let playerChromeRemoved = 0;
  document.querySelectorAll('video, audio').forEach((media) => {
    let container = media.parentElement;
    let matched = null;
    for (let depth = 0; container && depth < 4; depth += 1) {
      const id = `${container.getAttribute('class') || ''} ${container.id || ''}`;
      if (PLAYER_CONTAINER_RE.test(id)) {
        matched = container;
        break;
      }
      container = container.parentElement;
    }
    if (!matched) return;
    matched.querySelectorAll('*').forEach((node) => {
      if (node === media || node.contains(media) || media.contains(node)) return;
      if (node.tagName === 'SOURCE' || node.tagName === 'TRACK') return;
      if (node.querySelector('video, audio, iframe, img[src]')) return;
      const id = `${node.getAttribute('class') || ''} ${node.id || ''}`;
      const isMediaEl = ['IMG', 'VIDEO', 'AUDIO', 'IFRAME', 'PICTURE'].includes(node.tagName);
      if (isMediaEl && !PLAYER_UI_RE.test(id)) return;
      const text = (node.textContent || '').trim();
      if (PLAYER_UI_RE.test(id) || text.length <= 40) {
        node.remove();
        playerChromeRemoved += 1;
      }
    });
    // 只剩媒体就把容器解包，否则这个没有文字的 div 会被 Readability 当空容器丢掉
    const leftover = [...matched.childNodes].filter((n) => n.nodeType === 1 || (n.nodeType === 3 && (n.textContent || '').trim()));
    const MEDIA_TAGS = ['VIDEO', 'AUDIO', 'IMG', 'IFRAME', 'PICTURE', 'SOURCE', 'TRACK', 'FIGURE'];
    if (leftover.length && leftover.every((n) => n.nodeType !== 1 || MEDIA_TAGS.includes(n.tagName))) {
      matched.replaceWith(...matched.childNodes);
      playerChromeRemoved += 1;
    }
  });

  // 把"用 CSS 背景图当正文配图"的容器转成真正的 <img>。
  // 今日头条、部分 CMS 的正文配图就是背景图 div —— 这类节点没有文字，
  // Readability 会当成空容器整块丢掉，于是"页面明明有图却一张都抓不到"。
  let bgConverted = 0;
  document.querySelectorAll('[style*="background"]').forEach((el) => {
    if (el.tagName === 'IMG' || el.tagName === 'VIDEO') return;
    const style = el.getAttribute('style') || '';
    const m = style.match(/background(?:-image)?\s*:[^;]*url\((['"]?)([^'")]+)\1\)/i);
    if (!m || !m[2]) return;
    const src = m[2].trim();
    if (/^(data:|blob:|javascript:|about:|#)/i.test(src)) return; // 内联渐变/雪碧图/骨架屏

    const rect = el.getBoundingClientRect();
    const w = Math.round(rect.width) || el.offsetWidth || 0;
    const h = Math.round(rect.height) || el.offsetHeight || 0;
    if (w < 100 || h < 60) return; // 图标、按钮、装饰条
    const ratio = w / h;
    if (ratio < 0.2 || ratio > 6) return; // 极端长条多为分隔/横幅

    const identity = `${el.getAttribute('class') || ''} ${el.id || ''}`;
    if (/(logo|icon|avatar|sprite|placeholder|skeleton|shimmer|spinner|loading|banner|advert|qr-?code)/i.test(identity)) return;

    const inner = el.querySelector('img');
    if (inner && /^https?:/i.test((inner.getAttribute('src') || '').trim())) return;

    const img = document.createElement('img');
    img.setAttribute('src', src);
    img.setAttribute('data-wc-from-bg', '1');
    img.setAttribute('alt', (el.getAttribute('aria-label') || el.getAttribute('title') || '').trim());
    img.setAttribute('width', String(w));
    img.setAttribute('height', String(h));
    el.insertBefore(img, el.firstChild);
    // 清掉背景，避免同一张图被重复计入
    el.setAttribute('style', style.replace(/background(?:-image)?\s*:[^;]*;?/gi, ''));
    bgConverted += 1;
  });

  // 展开被折叠的正文（部分站点用 max-height + "展开全文" 按钮）
  document.querySelectorAll('[class*="truncat"], [class*="collapsed"], [class*="fold"]').forEach((el) => {
    const style = el.getAttribute('style') || '';
    if (/max-height|overflow:\s*hidden|display:\s*none/i.test(style)) {
      el.setAttribute('style', style.replace(/max-height\s*:[^;]+;?/gi, '').replace(/overflow\s*:\s*hidden;?/gi, '').replace(/display\s*:\s*none;?/gi, ''));
      fixed += 1;
    }
  });

  // 移除挡住正文的固定定位遮罩（脚本层已删掉大部分，这里兜底）
  document.querySelectorAll('body > div, body > section, body > aside').forEach((el) => {
    const style = window.getComputedStyle(el);
    if ((style.position === 'fixed' || style.position === 'sticky') && el.offsetHeight > window.innerHeight * 0.5) {
      const text = (el.textContent || '').trim();
      if (text.length < 400) el.remove();
    }
  });

  return { fixed, bgConverted, playerChromeRemoved };
}
