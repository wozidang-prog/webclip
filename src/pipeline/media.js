import { downloadBuffer } from '../utils/net.js';
import { mapLimit } from '../utils/pool.js';
import {
  canonicalizeUrl,
  isInlinePlaceholder,
  pickExtension,
  pickLargestFromSrcset,
} from '../utils/text.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { convertBackgroundImages } from './dom-media.js';
import { isUiAssetUrl } from '../adblock/rules.js';
import { muxTracks } from '../utils/ffmpeg.js';
import { mp4DurationSeconds, mp4VideoCodec } from '../utils/mp4.js';
import crypto from 'node:crypto';

const log = logger.child({ mod: 'media' });

const IMAGE_URL_RE = /\.(jpe?g|png|gif|webp|avif|bmp|svg|ico|tiff?|heic)(\?|#|$)/i;
const STREAM_URL_RE = /\.(m3u8|mpd)(\?|#|$)/i;

/** 从内容页地址里取出本条内容的 id（拿不到就返回空，此时不做"别的作品"过滤） */
function workIdOfUrl(rawUrl) {
  const match = /\/(?:video|shipin|note|explore|item)\/([0-9a-f]{16,32}|\d{8,})/i.exec(String(rawUrl || ''));
  if (match) return match[1].toLowerCase();
  const discovery = /\/discovery\/item\/([0-9a-f]{16,32}|\d{8,})/i.exec(String(rawUrl || ''));
  return discovery ? discovery[1].toLowerCase() : '';
}

/** 这个媒体节点是不是被"指向别的作品"的链接包着（推荐流卡片） */
function isInsideOtherWorkLink(el, ownWorkId) {
  try {
    const anchor = typeof el.closest === 'function' ? el.closest('a[href]') : null;
    if (!anchor) return false;
    const id = workIdOfUrl(anchor.getAttribute('href') || '');
    return Boolean(id) && id !== ownWorkId;
  } catch {
    return false;
  }
}

const LAZY_ATTRS = [
  'data-src',
  'data-original',
  'data-original-src',
  'data-lazy-src',
  'data-actualsrc',
  'data-echo',
  'data-url',
  'data-image',
  'data-img',
  'data-thumb',
  'data-large',
  'data-full',
  'data-orig-file',
  'data-cfsrc',
  'data-real-src',
];

const PLACEHOLDER_RE =
  /(^|[/_\-.=])(placeholder|blank|spacer|transparent|1x1|pixel|loading|lazy|dummy|grey|gray|default|no[-_]?image|unavailable|temp|trans)([/_\-.=]|$)/i;

/** src 常见于懒加载占位图，需要让位给 data-src / srcset */
export function isPlaceholderUrl(value) {
  const url = String(value || '').trim();
  if (!url) return true;
  if (isInlinePlaceholder(url)) return true;
  try {
    const { pathname } = new URL(url, 'https://placeholder.invalid');
    return PLACEHOLDER_RE.test(pathname);
  } catch {
    return PLACEHOLDER_RE.test(url);
  }
}

/**
 * 把 CSS 背景图转成真实的 <img>（实现见 dom-media.js，抽取阶段也会调用）。
 * 浏览器引擎里带布局尺寸的转换已在页面内完成，这里是 DOM 层兜底：
 * 供 fetch 引擎，以及"页面内没转成功"的情况使用。
 */
export { convertBackgroundImages } from './dom-media.js';

/** 把懒加载写法扶正为真实属性（fetch 引擎没有页面 JS，这一步很关键） */
export function normalizeMediaAttributes(document) {
  let changed = 0;

  for (const source of document.querySelectorAll('picture source[srcset], source[data-srcset]')) {
    const best = pickLargestFromSrcset(source.getAttribute('srcset') || source.getAttribute('data-srcset'));
    if (best) {
      source.setAttribute('srcset', best);
      changed += 1;
    }
  }

  for (const img of document.querySelectorAll('img')) {
    // 打分：真实图源 > 占位图
    const candidates = [];
    const srcsetBest = pickLargestFromSrcset(img.getAttribute('srcset') || img.getAttribute('data-srcset'));
    if (srcsetBest && !isPlaceholderUrl(srcsetBest)) candidates.push({ url: srcsetBest, score: 3 });
    for (const attr of LAZY_ATTRS) {
      const value = img.getAttribute(attr);
      if (value && !isPlaceholderUrl(value)) candidates.push({ url: value, score: 3 });
    }
    const current = img.getAttribute('src');
    if (current) candidates.push({ url: current, score: isPlaceholderUrl(current) ? 0 : 2 });

    candidates.sort((a, b) => b.score - a.score);
    const chosen = candidates[0];
    if (chosen && chosen.url !== current) {
      img.setAttribute('src', chosen.url);
      changed += 1;
    }
    img.removeAttribute('srcset');
    img.removeAttribute('data-srcset');
    for (const attr of LAZY_ATTRS) img.removeAttribute(attr);
  }

  for (const el of document.querySelectorAll('video, audio, source')) {
    if (el.getAttribute('src')) continue;
    for (const attr of ['data-src', 'data-url', 'data-lazy-src', 'data-video-src', 'data-audio-src']) {
      const value = el.getAttribute(attr);
      if (value) {
        el.setAttribute('src', value);
        changed += 1;
        break;
      }
    }
  }

  changed += convertBackgroundImages(document);

  return changed;
}

function kindForTag(el) {
  if (el.tagName === 'IMG') return 'image';
  if (el.tagName === 'VIDEO' || el.tagName === 'IFRAME') return 'video';
  if (el.tagName === 'AUDIO') return 'audio';
  if (el.tagName === 'SOURCE') {
    const parent = el.parentElement?.tagName;
    if (parent === 'VIDEO') return 'video';
    if (parent === 'AUDIO') return 'audio';
    return 'image';
  }
  return 'image';
}

/**
 * 收集页面中的媒体引用。
 * 返回 Map<canonicalUrl, { kind, url, refs: [{ el, attr }], alt }>
 */
export function collectMediaTargets(document, options = {}) {
  const {
    includeImages = true,
    includeVideos = true,
    includeAudio = true,
    pageUrl = '',
  } = options;

  /**
   * 本条内容自己的作品/笔记 id（抖音 /video|shipin/<19位>、小红书 /explore|discovery/item/<24位hex>）。
   * 页面上的推荐流卡片是"指向另一个作品的链接"，它的封面属于别的作品，不是本条内容。
   */
  const ownWorkId = workIdOfUrl(pageUrl);

  const targets = new Map();
  const add = (rawUrl, el, attr, kind, extra = {}) => {
    const url = String(rawUrl || '').trim();
    if (!url || isInlinePlaceholder(url)) return;
    if (!/^https?:/i.test(url)) return;
    // 二维码/小程序码这类永远不是正文配图
    if (/(qrcode|qr_?code|qr-?code)/i.test(url)) return;
    // 站点自身的 UI 资源（播放器动画、按钮图标）不是内容
    if (isUiAssetUrl(url)) return;
    // 包在"指向别的作品"的链接里的媒体：推荐流卡片的封面
    if (ownWorkId && el && isInsideOtherWorkLink(el, ownWorkId)) return;
    const key = canonicalizeUrl(url);
    const existing = targets.get(key);
    if (existing) {
      existing.refs.push({ el, attr });
      if (!existing.alt && extra.alt) existing.alt = extra.alt;
      return;
    }
    targets.set(key, {
      kind,
      url: key,
      originalUrl: url,
      refs: [{ el, attr }],
      alt: extra.alt || '',
      ...extra,
    });
  };

  if (includeImages) {
    for (const img of document.querySelectorAll('img[src]')) {
      add(img.getAttribute('src'), img, 'src', 'image', {
        alt: (img.getAttribute('alt') || '').trim(),
        fromNetwork: img.getAttribute('data-wc-captured') === '1',
      });
    }
    for (const video of document.querySelectorAll('video[poster]')) {
      add(video.getAttribute('poster'), video, 'poster', 'image', { alt: '' });
    }
  }

  if (includeVideos) {
    for (const video of document.querySelectorAll('video[src]')) {
      add(video.getAttribute('src'), video, 'src', 'video', {
        fromNetwork: video.getAttribute('data-wc-captured') === '1',
      });
    }
    for (const el of document.querySelectorAll('video source[src], audio video source[src]')) {
      add(el.getAttribute('src'), el, 'src', 'video', { fromNetwork: el.closest?.('[data-wc-captured]') !== null });
    }
  }

  if (includeAudio) {
    for (const audio of document.querySelectorAll('audio[src]')) {
      add(audio.getAttribute('src'), audio, 'src', 'audio', {
        fromNetwork: audio.getAttribute('data-wc-captured') === '1',
      });
    }
    for (const el of document.querySelectorAll('audio source[src]')) {
      add(el.getAttribute('src'), el, 'src', 'audio', { fromNetwork: el.closest?.('[data-wc-captured]') !== null });
    }
  }

  return targets;
}

function validateBuffer({ buffer, mime, kind }) {
  if (!buffer || buffer.byteLength === 0) return 'empty';
  if (buffer.byteLength < 40) return 'too_small';
  const type = String(mime || '').toLowerCase();
  if (type.startsWith('text/html') || type.startsWith('application/json')) return 'not_media';
  if (kind === 'image' && type && !type.startsWith('image/') && !type.startsWith('application/octet-stream')) {
    return `unexpected_type:${type.split(';')[0]}`;
  }
  if (kind === 'video' && type && !type.startsWith('video/') && !type.startsWith('application/octet-stream')) {
    return `unexpected_type:${type.split(';')[0]}`;
  }
  if (kind === 'audio' && type && !type.startsWith('audio/') && !type.startsWith('video/') && !type.startsWith('application/octet-stream')) {
    return `unexpected_type:${type.split(';')[0]}`;
  }
  return null;
}

/**
 * 把页面中的媒体搬到本地图床，并返回改写信息。
 *
 * @param {object} params
 * @param {Document} params.document 已清洗的正文 DOM（会被就地改写）
 * @param {string} params.pageUrl
 * @param {MediaStore} params.store
 * @param {Map} [params.capture] 浏览器网络层捕获的图片字节
 * @param {'local'|'remote'|'none'} [params.mode]
 */
export async function localizeMedia({
  document,
  pageUrl,
  store,
  capture = null,
  observed = null,
  mode = 'local',
  includeImages = true,
  includeVideos = true,
  includeAudio = true,
  localizeImageLinks = true,
  referer = pageUrl,
  cookie = '',
  maxFiles = config.storage.maxFilesPerPage,
  maxBytes = config.storage.maxBytesPerPage,
  maxFileBytes = config.storage.maxFileBytes,
  maxVideoBytes = config.storage.maxVideoBytes,
  maxAudioBytes = config.storage.maxAudioBytes,
  maxVideoBytesPerPage = config.storage.maxVideoBytesPerPage,
  concurrency = 6,
  onError = 'keep',
  /** 'folder'（按文章文件夹 + 顺序编号）| 'flat'（内容寻址） */
  layout = config.storage.layout,
  /** 站点目录名：媒体按网站分类（media/<站点域名>/…）；留空则不分类 */
  group = '',
  /** folder 布局：文章标题 slug 对应的文件夹名 */
  folder = '',
  /** folder 布局：媒体归属的文章 id（清理时按它整目录删） */
  articleId = '',
} = {}) {
  const report = {
    mode,
    layout,
    group: group || '',
    folder: layout === 'folder' ? folder : '',
    media: [],
    failures: [],
    codecWarnings: [],
    stats: { saved: 0, reusedFromCache: 0, reusedFromCapture: 0, failed: 0, skipped: 0, muxed: 0, deduped: 0, bytes: 0 },
  };

  if (mode === 'none') {
    for (const el of document.querySelectorAll('img, video, audio, picture, figure, iframe')) el.remove();
    return report;
  }

  normalizeMediaAttributes(document);
  const targets = collectMediaTargets(document, { includeImages, includeVideos, includeAudio, pageUrl });

  // 有些播放器（西瓜播放器 / 自研播放器）把视频地址交给内部实现，<video src> 始终为空，
  // 但网络层已经看到过媒体请求。这里把它补给"空壳" video/audio 节点。
  if (observed?.size) {
    const usedKeys = new Set(targets.keys());
    const spare = [...observed.values()].filter((o) => {
      if (!o?.url) return false;
      if (usedKeys.has(canonicalizeUrl(o.url))) return false;
      if (STREAM_URL_RE.test(o.url)) return false; // 播放列表（m3u8/mpd）不单独保存
      if (/\.(ts|m4s|cmfv|cmfa|aac)(\?|#|$)/i.test(o.url)) return false; // 分片
      return true;
    });
    const needsSrc = (el) => {
      const own = el.getAttribute('src') || '';
      if (/^https?:/i.test(own)) return false;
      const hasChild = [...el.querySelectorAll('source[src]')].some((s) => /^https?:/i.test(s.getAttribute('src') || ''));
      return !hasChild; // 没有可用 http 地址就算需要补（含为空、data:、blob: 即 MSE）
    };
    const emptyPlayers = [...document.querySelectorAll('video, audio')].filter(needsSrc);
    for (const el of emptyPlayers) {
      const kind = el.tagName === 'AUDIO' ? 'audio' : 'video';
      const index = spare.findIndex((o) => (o.kind || 'video') === kind);
      if (index < 0) continue;
      const candidate = spare.splice(index, 1)[0];
      const key = canonicalizeUrl(candidate.url);
      if (el.getAttribute('src')) el.removeAttribute('src'); // 换掉 blob:/data:
      el.setAttribute('src', candidate.url);
      targets.set(key, {
        kind,
        url: key,
        originalUrl: candidate.url,
        refs: [{ el, attr: 'src' }],
        alt: '',
        fromNetwork: true,
      });
    }
  }

  // 只保留允许下载的类型
  const queue = [];
  for (const target of targets.values()) {
    if (target.kind === 'video' && !includeVideos) {
      report.stats.skipped += 1;
      continue;
    }
    if (target.kind === 'audio' && !includeAudio) {
      report.stats.skipped += 1;
      continue;
    }
    if (STREAM_URL_RE.test(target.url)) {
      report.stats.skipped += 1;
      report.failures.push({ url: target.url, reason: 'streaming_playlist', kind: target.kind });
      continue;
    }
    if (queue.length >= maxFiles) {
      report.stats.skipped += 1;
      continue;
    }
    queue.push(target);
  }

  if (mode === 'remote') {
    // 不改写链接，仅上报
    for (const target of queue) {
      report.media.push({ sourceUrl: target.url, localUrl: null, kind: target.kind, bytes: 0, alt: target.alt });
    }
    return report;
  }

  /**
   * DASH 分离音视频（抖音 /video/<id> 就是这样）：播放器分别请求
   *   …/media-video-avc1/…（纯视频轨，落盘就是没声音的视频）
   *   …/media-audio-und-mp4a/…（纯音频轨）
   * 这里把它们认出来配对，交给 ffmpeg -c copy 合回一个文件；ffmpeg 不在时至少
   * 把纯音频轨按 .m4a 存（而不是再存一个 .mp4 让人以为是第二个视频）。
   */
  const DASH_VIDEO_RE = /\/media-video[-_]/i;
  const DASH_AUDIO_RE = /\/media-audio[-_]/i;
  const dashPairs = [];
  {
    const videoTracks = queue.filter((t) => DASH_VIDEO_RE.test(t.url));
    const audioTracks = queue.filter((t) => DASH_AUDIO_RE.test(t.url));
    for (let i = 0; i < Math.min(videoTracks.length, audioTracks.length); i += 1) {
      videoTracks[i].dashAudioPeer = audioTracks[i].url;
      audioTracks[i].muxInto = videoTracks[i].url;
      dashPairs.push({ video: videoTracks[i].url, audio: audioTracks[i].url });
    }
    // 纯音频轨按音频处理：别用视频上限，也别存成 .mp4
    for (const track of audioTracks) {
      if (track.muxInto || DASH_AUDIO_RE.test(track.url)) {
        track.kind = includeAudio ? 'audio' : track.kind;
        track.forceExt = '.m4a';
      }
    }
  }

  const headers = {
    referer,
    ...(cookie ? { cookie } : {}),
    accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,video/*,audio/*,*/*;q=0.8',
  };

  let budget = maxBytes;

  // 图片/音频与视频用各自的上限：视频动辄几十上百 MB，不能被图片的 25MiB 上限误伤
  const fileCapFor = (kind) =>
    kind === 'video' ? maxVideoBytes : kind === 'audio' ? maxAudioBytes : maxFileBytes;
  const pageCapFor = (kind) => (kind === 'video' ? maxVideoBytesPerPage : maxBytes);
  const spentByKind = { image: 0, audio: 0, video: 0 };
  // folder 布局的顺序号：按正文里的出现顺序，而不是下载完成顺序
  const orderIndex = new Map(queue.map((item, i) => [item.url, i + 1]));

  /**
   * 网络层/正文里同一份内容被多个地址请求时用到的认领集合（内容哈希 → 已认领）。
   * 必须在下面 mapLimit 的 worker 跑起来之前就位，否则 worker 里会踩暂时性死区。
   */
  const capturedDigests = new Set();

  const results = await mapLimit(queue, concurrency, async (target) => {
    const canon = target.url;
    const kind = target.kind;
    const fileCap = fileCapFor(kind);
    const remainingForKind = pageCapFor(kind) - (spentByKind[kind] || 0);

    // 0) 已被配对视频轨合流的纯音频轨：不单独落盘（它的字节由视频轨那边取）
    if (target.muxInto) return { target, ok: true, consumed: true, reason: 'merged_into_video' };

    // 1) 索引命中（只有 flat 布局做跨文章缓存；folder 布局按文章各存各的）
    const cached = layout === 'flat' ? store.get(canon) : null;
    if (cached) {
      if ((cached.b || 0) > fileCap) return { target, ok: false, reason: 'too_large' };
      store.touch(cached);
      spentByKind[kind] = (spentByKind[kind] || 0) + (cached.b || 0);
      return { target, ok: true, record: cached, source: 'cache' };
    }

    // 2) 浏览器网络层已捕获的字节
    const captured = capture?.get(canon);
    let buffer = null;
    let mime = '';

    // 视频用独立的页面预算，不占用图片/音频的额度
    const effectiveLimit = kind === 'video' ? remainingForKind : Math.min(remainingForKind, budget);

    /**
     * 取一份字节：先看浏览器网络层捕获，再回退到直接下载。
     * 合流音频轨时也走这里（播放器已经把它的字节抓到了）。
     */
    const fetchBytes = async (url, cap, limit) => {
      if (cap && cap.buffer && cap.buffer.byteLength <= maxAudioBytes * 8) return { buffer: cap.buffer, mime: cap.mime || '' };
      const res = await downloadBuffer(url, { headers, maxBytes: Math.max(1, Math.min(maxAudioBytes, limit)) });
      return { buffer: res.buffer, mime: res.mime || '' };
    };

    if (captured && captured.buffer && captured.buffer.byteLength <= fileCap) {
      buffer = captured.buffer;
      mime = captured.mime || '';
    } else {
      if (effectiveLimit <= 0) return { target, ok: false, reason: 'page_budget_exceeded' };
      try {
        const res = await downloadBuffer(canon, {
          headers,
          maxBytes: Math.max(1, Math.min(fileCap, effectiveLimit)),
        });
        buffer = res.buffer;
        mime = res.mime || '';
      } catch (err) {
        const reason = err.code === 'too_large' ? 'too_large' : err.code || 'download_failed';
        log.debug('媒体下载失败', { url: canon, reason, err: err.message });
        return { target, ok: false, reason, message: err.message };
      }
    }

    // 3) DASH 分离音视频：把配对的音频轨合进来，出来就是一个带声音的 MP4
    // 同时记录时长：同一条视频被请求了多个清晰度档位时，靠它认定"这是同一段内容"
    let merged = false;
    let dashDuration = 0;
    if (kind === 'video') dashDuration = mp4DurationSeconds(buffer);
    if (target.dashAudioPeer) {
      try {
        const peer = await fetchBytes(target.dashAudioPeer, capture?.get(target.dashAudioPeer), maxAudioBytes);
        const audioBytes = peer.buffer;
        if (audioBytes?.byteLength) {
          const joined = await muxTracks(buffer, audioBytes);
          if (joined) {
            buffer = joined;
            mime = 'video/mp4';
            merged = true;
          }
        }
      } catch (err) {
        log.debug('音频轨获取失败，视频将没有声音', { url: target.dashAudioPeer, err: err.message });
      }
      if (!merged) {
        report.failures.push({ url: canon, kind, reason: 'dash_audio_missing', message: '该页面是 DASH 分离音视频，未能合流（视频没有声音）' });
      }
    }
    if (target.forceExt) mime = mime || 'audio/mp4';

    /**
     * 同一份字节被多个地址请求的情况：抖音的媒体地址里带签名段
     * （…/1680441/6aae9b50/video/tos/…、aweme/v1/play?biz_sign=…），同一条视频每次请求的路径都不一样，
     * 按路径去重失效，实测同一条视频会被存 4 份（4×45MB）。字节在手，直接按内容哈希去重。
     * 视频/音频一律去重；图片只在"这是从播放器网络请求补出来的节点"时去重，
     * 免得把正文里刻意放了两次的同一张图删掉一次。
     */
    if (buffer?.byteLength && (target.fromNetwork || kind === 'video' || kind === 'audio')) {
      const digest = crypto.createHash('sha256').update(buffer).digest('hex');
      if (capturedDigests.has(digest)) {
        return { target, ok: true, consumed: true, reason: 'duplicate_bytes' };
      }
      capturedDigests.add(digest);
      target.__digest = digest;
    }

    const invalid = validateBuffer({ buffer, mime, kind });
    if (invalid) return { target, ok: false, reason: invalid };

    if (buffer.byteLength > fileCap) return { target, ok: false, reason: 'too_large' };
    if (buffer.byteLength > effectiveLimit) return { target, ok: false, reason: 'page_budget_exceeded' };
    spentByKind[kind] = (spentByKind[kind] || 0) + buffer.byteLength;
    if (kind !== 'video') budget -= buffer.byteLength;

    try {
      const extension = target.forceExt || pickExtension({ mime, url: canon });
      const record =
        layout === 'folder'
          ? await store.putArticleMedia({
              articleId,
              folder: folder || 'media',
              group,
              // 顺序号取"正文里的出现顺序"（并发下载不会打乱编号）
              index: orderIndex.get(canon) || 1,
              buffer,
              mime,
              kind: target.kind,
              sourceUrl: canon,
              ext: extension,
            })
          : await store.put({
              sourceUrl: canon,
              buffer,
              mime,
              kind: target.kind,
              ext: extension,
              group,
            });
      return {
        target,
        ok: true,
        record,
        source: captured ? 'capture' : 'network',
        dashDuration,
        merged,
        // 落盘后从字节里读编码，供上层给出"H.265 可能只有声音"的提示（不额外发请求）
        codec: kind === 'video' ? mp4VideoCodec(buffer) : '',
      };
    } catch (err) {
      // 落盘失败就把内容哈希的占位释放掉，让后面同内容的请求还能再试一次
      if (target.__digest) capturedDigests.delete(target.__digest);
      log.warn('写入图床失败', { url: canon, err: err.message });
      return { target, ok: false, reason: 'store_failed', message: err.message };
    }
  });

  const localUrlBySource = new Map();

  /** 撤掉正文里的一个媒体节点：它独占一个段落时连段落一起删，避免留下空行 */
  const dropMediaNode = (el) => {
    if (!el?.isConnected) return;
    const holder = typeof el.closest === 'function' ? el.closest('p') : null;
    if (holder && holder.querySelectorAll('video, audio, img').length <= 1) holder.remove();
    else el.remove();
  };

  /**
   * 同一条视频的多档位去重：播放器起播时先请求低清晰度、随后升档，同一条视频就会被抓成两份
   * （抖音实测两档：DASH 分离流合流后 20.35MB、渐进式 45.28MB，时长都是 168.9s）。
   * 时长相同即同一段内容，只留体积最大的那一档 —— 也就是画质最好的那份。
   * 只对"网络层捕获到的视频"生效，避免误伤正文 DOM 里真有的多段视频。
   */
  const dashGroups = new Map();
  for (const entry of results) {
    if (!entry?.ok || entry.consumed || !entry.dashDuration) continue;
    if (entry.target?.kind !== 'video') continue;
    const key = Math.round(entry.dashDuration);
    if (!dashGroups.has(key)) dashGroups.set(key, []);
    dashGroups.get(key).push(entry);
  }
  const dropped = new Set();
  for (const group of dashGroups.values()) {
    if (group.length < 2) continue;
    /**
     * 只在可靠的情形下合并，避免误伤"页面上真有两段时长恰好相同的视频"：
     *   · 组里至少有一条是 DASH 分离流合流出来的（那就是这个播放器的主视频）
     *   · 或者这组全是网络层捕获到的地址
     */
    const reliable = group.some((e) => e.merged) || group.every((e) => e.target?.fromNetwork === true);
    if (!reliable) continue;
    const sorted = [...group].sort((a, b) => (b.record?.b || 0) - (a.record?.b || 0));
    for (const loser of sorted.slice(1)) dropped.add(loser);
  }

  for (const entry of results) {
    if (entry?.__error) {
      report.stats.failed += 1;
      report.failures.push({ url: 'unknown', reason: 'internal_error', message: entry.__error.message });
      continue;
    }
    if (!entry) continue;
    const { target } = entry;
    // 已被合并掉的条目：纯音频轨（合流进视频）或同内容的重复字节 —— 不落盘、留在正文里的节点也撤掉
    if (entry.consumed) {
      if (entry.reason === 'merged_into_video') report.stats.muxed += 1;
      else report.stats.deduped += 1;
      for (const ref of target.refs) dropMediaNode(ref.el);
      continue;
    }
    // 同一条视频的低画质档位：删掉刚落的盘，并把它在正文里的节点一并撤掉
    if (dropped.has(entry)) {
      await store.removeFile(entry.record.f).catch(() => {});
      for (const ref of target.refs) dropMediaNode(ref.el);
      report.stats.deduped += 1;
      continue;
    }
    if (!entry.ok) {
      report.stats.failed += 1;
      report.failures.push({ url: target.url, kind: target.kind, reason: entry.reason, message: entry.message });
      if (onError === 'drop') {
        for (const ref of target.refs) {
          if (ref.el?.isConnected) {
            if (ref.el.tagName === 'IMG') ref.el.remove();
            else ref.el.removeAttribute(ref.attr);
          }
        }
      }
      continue;
    }

    const localUrl = store.localUrl(entry.record);
    localUrlBySource.set(target.url, localUrl);
    if (entry.source === 'cache') report.stats.reusedFromCache += 1;
    else if (entry.source === 'capture') report.stats.reusedFromCapture += 1;
    else report.stats.saved += 1;
    // bytes 只统计"这次真正落盘"的体积：同一份内容来自不同 CDN 地址时会被内容寻址去重
    if (entry.source !== 'cache' && !entry.record.reused) report.stats.bytes += entry.record.b || 0;

    for (const ref of target.refs) {
      const el = ref.el;
      if (!el?.isConnected) continue;
      el.setAttribute(ref.attr, localUrl);
      if (ref.attr === 'src' && el.tagName === 'IMG') {
        el.removeAttribute('srcset');
        el.removeAttribute('sizes');
      }
    }

    report.media.push({
      kind: target.kind,
      sourceUrl: target.originalUrl || target.url,
      localUrl,
      hash: entry.record.h,
      file: entry.record.f,
      mime: entry.record.m,
      bytes: entry.record.b,
      alt: target.alt || '',
      origin: entry.source,
    });

    /**
     * 编码提示（只提示、不改选择）：H.265/HEVC、AV1 在 Windows 自带播放器、不少手机和浏览器上
     * 解不了，播出来只有声音 —— 用户常以为"下载到的视频只有音频"。
     * 这里直接从落盘的字节里读（不额外发请求）。
     */
    if (target.kind === 'video' && entry.codec) {
      const codec = entry.codec;
      if (codec === 'h265' || codec === 'av1') {
        report.codecWarnings.push({
          file: entry.record.f,
          codec,
          message:
            codec === 'h265'
              ? `视频 ${entry.record.f} 的编码是 H.265（HEVC），Windows 自带播放器等环境解不了、只有声音：请用支持 HEVC 的播放器（如 VLC/PotPlayer），或换用提供 H.264 的档位`
              : `视频 ${entry.record.f} 的编码是 AV1，部分播放器解不了：请用支持 AV1 的播放器`,
        });
      }
    }
  }

  /**
   * 合并报告里的重复项：同一份内容常常有多个 CDN 地址（字节跳动的视频最典型，
   * v3-web / v6-web 两个域名给的是同一个文件），内容寻址后指向同一个本地文件。
   * 不合并的话前端媒体墙会出现两条一样的记录。
   */
  const merged = new Map();
  for (const item of report.media) {
    const key = item.localUrl || item.sourceUrl;
    const existing = merged.get(key);
    if (existing) {
      existing.sourceUrls = existing.sourceUrls || [existing.sourceUrl];
      if (item.sourceUrl && !existing.sourceUrls.includes(item.sourceUrl)) existing.sourceUrls.push(item.sourceUrl);
      existing.alt = existing.alt || item.alt;
      continue;
    }
    merged.set(key, { ...item });
  }
  if (merged.size !== report.media.length) {
    report.stats.mergedDuplicateUrls = report.media.length - merged.size;
    report.media = [...merged.values()];
  }

  // 图片链接（点击放大）也指向本地副本
  if (mode === 'local' && localizeImageLinks) {
    for (const anchor of document.querySelectorAll('a[href]')) {
      const img = anchor.querySelector('img[src]');
      if (!img) continue;
      const local = img.getAttribute('src') || '';
      if (local.includes('/media/')) anchor.setAttribute('href', local);
    }
  }

  log.info('媒体本地化完成', {
    page: pageUrl,
    total: queue.length,
    ...report.stats,
  });

  return report;
}

export { IMAGE_URL_RE, STREAM_URL_RE };
