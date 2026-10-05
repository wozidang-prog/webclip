/**
 * DOM 层的媒体恢复工具（抽取阶段与媒体阶段共用）。
 *
 * 为什么需要它：很多站点（今日头条、部分 CMS）把正文配图写成
 *   <div class="pgc-img" style="background-image:url(...);width:480px;height:320px"></div>
 * 这种节点**没有任何文字**，既会被 Readability 当成空容器丢掉，
 * 也会被我们自己的"空节点清理"删掉 —— 结果就是"页面明明有图却一张都抓不到"。
 * 所以在任何清理动作之前，先把它们换成真正的 <img>。
 */

const DECORATIVE_CLASS = /(logo|icon|avatar|sprite|placeholder|skeleton|shimmer|spinner|loading|banner|advert|qr-?code|arrow|bullet|divider)/i;

const BG_URL_RE = /background(?:-image)?\s*:[^;]*url\((['"]?)([^'")]+)\1\)/i;

/** 播放器容器的 class/id 特征 */
const PLAYER_CONTAINER_RE = /(video-?box|video-?container|video-?wrapper|video-?player|media-?player|tt-video|player-?container|artplayer|dplayer|prism-?player|xgplayer)/i;
/** 播放器内部控件（按钮/进度条/提示等）的特征 */
const PLAYER_UI_RE = /(control|controls|bar|btn|button|prompt|loading|poster|play|pause|time|fullscreen|volume|progress|mask|overlay|masking|error|enter|replay|tips|switch|danmaku|barrage|logo|icon)/i;
/** 封面可能挂在播放器容器上的属性名 */
const POSTER_ATTRS = ['poster', 'data-poster', 'tt-poster', 'data-cover', 'data-pic', 'data-thumb', 'data-video-poster'];

/** @returns {number} 转换的元素个数 */
export function convertBackgroundImages(document) {
  let converted = 0;

  for (const el of document.querySelectorAll('[style*="background"]')) {
    if (['IMG', 'VIDEO', 'AUDIO', 'SOURCE'].includes(el.tagName)) continue;

    const style = el.getAttribute('style') || '';
    const match = style.match(BG_URL_RE);
    if (!match || !match[2]) continue;

    const src = match[2].trim();
    // 只排除内联/伪协议；相对路径留给后续 absolutizeUrls 处理
    if (/^(data:|blob:|javascript:|about:|#)/i.test(src)) continue;

    const identity = `${el.getAttribute('class') || ''} ${el.getAttribute('id') || ''}`;
    if (DECORATIVE_CLASS.test(identity)) continue;

    // 元素里已经有真图就不用管
    const inner = el.querySelector('img');
    if (inner && /^https?:/i.test((inner.getAttribute('src') || '').trim())) continue;

    const img = document.createElement('img');
    img.setAttribute('src', src);
    img.setAttribute('data-wc-from-bg', '1');
    const alt = (el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
    if (alt) img.setAttribute('alt', alt);
    el.insertBefore(img, el.firstChild);

    // 清掉背景声明，避免同一张图被重复计入
    el.setAttribute('style', style.replace(/background(?:-image)?\s*:[^;]*;?/gi, ''));
    converted += 1;
  }

  return converted;
}

function identityOf(el) {
  return `${el.getAttribute?.('class') || ''} ${el.getAttribute?.('id') || ''}`;
}

/** 把封面地址从播放器容器的 data-* 属性搬到 <video poster>（很多站点只放在 data-poster/tt-poster 上） */
export function promotePosterAttributes(document) {
  let promoted = 0;
  for (const video of document.querySelectorAll('video')) {
    if (video.getAttribute('poster')) continue;
    let node = video;
    for (let depth = 0; node && depth < 4; depth += 1) {
      for (const attr of POSTER_ATTRS) {
        const value = (node.getAttribute?.(attr) || '').trim();
        if (value && !/^(data:|blob:|javascript:)/i.test(value)) {
          video.setAttribute('poster', value);
          promoted += 1;
          node = null;
          break;
        }
      }
      if (!node) break;
      node = node.parentElement;
    }
  }
  return promoted;
}

/**
 * 删掉播放器自带的 UI 噪音（"暂停""00:09 / 00:25""进入全屏"这类文字），
 * 只保留真正的媒体节点 —— 否则这些字会一字不差地混进 Markdown 正文。
 */
export function prunePlayerChrome(document) {
  let removed = 0;

  for (const video of document.querySelectorAll('video, audio')) {
    // 向上找播放器容器，找不到就不动（避免误删正常内容）
    let container = video.parentElement;
    let matched = null;
    for (let depth = 0; container && depth < 4; depth += 1) {
      if (PLAYER_CONTAINER_RE.test(identityOf(container))) {
        matched = container;
        break;
      }
      container = container.parentElement;
    }
    if (!matched) continue;

    for (const node of [...matched.querySelectorAll('*')]) {
      if (!node.isConnected) continue;
      if (node === video || node.contains(video) || video.contains(node)) continue;
      if (['SOURCE', 'TRACK'].includes(node.tagName)) continue;
      // 里面有真媒体就保留
      if (node.querySelector('video, audio, iframe, img[src]')) continue;
      const identity = identityOf(node);
      const isMediaEl = ['IMG', 'VIDEO', 'AUDIO', 'IFRAME', 'PICTURE'].includes(node.tagName);
      if (isMediaEl && !PLAYER_UI_RE.test(identity)) continue;
      const text = (node.textContent || '').trim();
      if (PLAYER_UI_RE.test(identity) || text.length <= 40) {
        node.remove();
        removed += 1;
      }
    }

    // 清理后如果容器里只剩媒体，就把容器解包。
    // 否则这个"没有文字"的 div 会被 Readability 当成空容器整块丢掉，
    // 视频反而会因为"播放器控件文字被删掉"而一起消失（曾经的回归 bug）。
    const leftover = [...matched.childNodes].filter(
      (n) => n.nodeType === 1 || (n.nodeType === 3 && (n.textContent || '').trim()),
    );
    const MEDIA_TAGS = ['VIDEO', 'AUDIO', 'IMG', 'IFRAME', 'PICTURE', 'SOURCE', 'TRACK', 'FIGURE'];
    if (leftover.length && leftover.every((n) => n.nodeType !== 1 || MEDIA_TAGS.includes(n.tagName))) {
      matched.replaceWith(...matched.childNodes);
      removed += 1;
    }
  }

  return removed;
}
