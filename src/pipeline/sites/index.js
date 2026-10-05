/**
 * 站点适配器：抖音 / 小红书这类"数据只在 JS 里"的站点。
 *
 * 为什么需要单独一层：
 *   普通站点做懒加载兜底（data-src / srcset / 页面数据里的图片地址）就够了，
 *   但抖音、小红书的页面 HTML 里**既没有 <img> 也没有 <video>**，
 *   只有一个空壳播放器 + 一段签名接口调用；真正的地址在页面内嵌 JSON 里，
 *   而且字段名随版本变（play_addr / playAddr / media.stream.h264[*].masterUrl …）。
 *
 * 所以这里不写死路径，改成"先定位主体数据节点，再按字段名模式递归收集"：
 * 抖音换了字段名、小红书改版结构，通常都还能work；真解析不出来也只是少抓几个文件，
 * 不会影响正文与其它媒体的正常处理（convert.js 里是 try/catch 兜底调用）。
 *
 * 只做一件事：把页面数据里的图片/视频地址找出来，交给通用媒体阶段下载、改写、落盘。
 */

import { canonicalizeUrl } from '../../utils/text.js';
import { isUiAssetUrl } from '../../adblock/rules.js';
import { parsePageState } from './state.js';
import { douyinSite } from './douyin.js';
import { xiaohongshuSite } from './xiaohongshu.js';
import { collectViaXhsApi, xhsApiEnabled } from './xhs-api.js';

/** 已知站点（顺序即匹配优先级） */
export const SITES = [douyinSite, xiaohongshuSite];

/** 媒体地址所在的容器键（视频） */
const VIDEO_CONTAINER_KEYS = [
  'play_addr',
  'playAddr',
  'play_addr_h264',
  'playAddrH264',
  'play_addr_265',
  'playAddr265',
  'play_addr_bytevc1',
  'play_addr_lowbr',
  'download_addr',
  'downloadAddr',
];

/** 媒体地址所在的容器键（图集） */
const IMAGE_CONTAINER_KEYS = [
  'imageList',
  'image_list',
  'images',
  'picList',
  'pic_list',
  'imagePost',
  'image_post_info',
  'image_list_v2',
];

/** 容器里可能是数组或单个地址的键 */
const URL_KEYS = [
  'url_list',
  'urlList',
  'url_list_h264',
  'urlListH264',
  'url_default',
  'urlDefault',
  'url_default_list',
  'urlDefaultList',
  'url_pre',
  'urlPre',
  'url',
  'src',
  'master_url',
  'masterUrl',
  'backup_url',
  'backupUrl',
  'backup_urls',
  'backupUrls',
  'origin_url',
  'originUrl',
  'download_url',
  'downloadUrl',
];

/** 封面（只作为视频 poster，不单独算一个文件） */
const COVER_KEYS = [
  'cover',
  'cover_url',
  'coverUrl',
  'origin_cover',
  'originCover',
  'dynamic_cover',
  'dynamicCover',
  'poster',
];

/** 明显不是媒体资源的路径：分享页、个人主页等（注意别把 CDN 的 /video/tos/... 误伤） */
const NON_MEDIA_PATH_RE = /\/(share|user|profile|discover|search|login|qrcode)(\/|$)/i;

function isMediaUrl(value) {
  const url = String(value || '').trim();
  if (!/^https?:\/\//i.test(url)) return false;
  if (/(avatar|head_?img|headimg|qrcode|qr_?code|logo)/i.test(url)) return false;
  // 站点自身的 UI 资源（前端图标、播放器动画）不是内容
  if (isUiAssetUrl(url)) return false;
  return true;
}

/**
 * 画质排序用的标记（小红书：WB_DFT/nd_dft 是原图，WB_PRV/nd_prv 是预览图）。
 * 只认这些明确的标记，不去猜 URL 里的尺寸参数 —— 哈希串里的数字太容易误伤。
 */
const ORIGINAL_IMAGE_RE = /(nd_dft|wb_dft|url_?default|original|_origin|origin_)/i;
const PREVIEW_IMAGE_RE = /(nd_prv|wb_prv|url_?pre\b|url_?pre_|preview|thumb|thumbnail|_small|small_)/i;

/** 同一张图的多个候选里取画质最好的：显式原图标记 > 无标记 > 预览/缩略图标记 */
function bestImageUrl(urls) {
  if (!urls.length) return '';
  const rank = (url) => {
    if (ORIGINAL_IMAGE_RE.test(url)) return 2;
    if (PREVIEW_IMAGE_RE.test(url)) return 0;
    return 1;
  };
  const looks = (url) => (looksLikeMediaPath(url) ? 1 : 0);
  let best = urls[0];
  for (const url of urls.slice(1)) {
    if (rank(url) > rank(best) || (rank(url) === rank(best) && looks(url) > looks(best))) best = url;
  }
  return best;
}

/** 从一个"流"对象上读出画质信息（拿不到就记 0） */
function qualityOf(node) {
  const num = (...keys) => {
    for (const key of keys) {
      const value = Number(node?.[key]);
      if (Number.isFinite(value) && value > 0) return value;
    }
    return 0;
  };
  return {
    width: num('width'),
    height: num('height'),
    bitrate: num('avgBitrate', 'bit_rate', 'bitrate', 'videoBitrate'),
    size: num('size', 'data_size'),
  };
}

/**
 * 收集视频候选，并带上画质信息，供"取最高画质"排序：
 *   小红书：video.media.stream.EF4[0].masterUrl + {width,height,avgBitrate,size}
 *   抖音：video.bit_rate[].play_addr.url_list[] + {width,height,bit_rate,data_size}
 */
/** 明显是视频文件的路径特征（用来把封面/海报图从视频候选里剔掉） */
const VIDEO_PATH_RE = /\.(mp4|m4v|mov|webm|mkv)(\?|#|$)/i;
function looksLikeVideoUrl(value) {
  const url = String(value || '');
  if (!/^https?:\/\//i.test(url)) return false;
  if (VIDEO_PATH_RE.test(url)) return true;
  // 抖音的地址没有扩展名：…/video/tos/cn/…/media-video-avc1/?a=…；小红书是 …/stream/79/110/301/xxx.mp4
  return /\/(media-video|media-audio|stream)\//i.test(url) || /douyinvod/i.test(url);
}

function collectVideoCandidates(levels, node) {
  const withMeta = [];
  const plain = [];
  // 两个桶各自去重：容器层的"无元数据"条目不能把后面带元数据的真档位挡掉
  const seenMeta = new Set();
  const seenPlain = new Set();
  const walk = (value, depth) => {
    if (!value || typeof value !== 'object' || depth > 4 || withMeta.length > 60) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    const urls = [];
    // 对象自身的地址键：小红书的清晰度档位对象就是这样（{masterUrl, width, height, avgBitrate…}）
    for (const key of URL_KEYS) if (key in value) urls.push(...urlsFrom(value[key]));
    for (const key of VIDEO_CONTAINER_KEYS) if (key in value) urls.push(...urlsFrom(value[key]));
    urls.push(...urlsFrom(value.stream), ...urlsFrom(value?.media?.stream));
    const videoUrls = urls.filter(looksLikeVideoUrl);
    if (videoUrls.length) {
      const url = videoUrls.find(looksLikeMediaPath) || videoUrls[0];
      const meta = qualityOf(value);
      const hasMeta = Boolean(meta.width || meta.height || meta.bitrate || meta.size);
      const bucket = hasMeta ? withMeta : plain;
      const seenSet = hasMeta ? seenMeta : seenPlain;
      /**
       * 关键：只把**带画质元数据**的那一层当作候选（小红书的每个清晰度档位
       * `stream.EF4[0].masterUrl` 自带 width/height/avgBitrate/size），
       * 不含元数据的容器层（`media.stream` 只是把各档位聚合起来）不能当作候选 ——
       * 否则档位会被合并成一条、元数据全丢，画质排序和编码优选都无从判断。
       */
      if (url && !seenSet.has(url)) {
        seenSet.add(url);
        bucket.push({ url, cover: coverOf(value) || coverOf(node), ...meta });
      }
    }
    // 继续下钻：同一段视频的多个清晰度档位就在子节点里
    for (const child of Object.values(value)) walk(child, depth + 1);
  };
  for (const level of levels) walk(level, 0);
  // 站点没给元数据时退回原来的行为（至少有候选可用）
  return withMeta.length ? withMeta : plain;
}

/** 取最高画质：先比像素数，再比码率，最后比文件体积 */
function sortVideoCandidates(candidates) {
  return [...candidates].sort(
    (a, b) => b.width * b.height - a.width * a.height || b.bitrate - a.bitrate || b.size - a.size,
  );
}

/** 路径里带媒体扩展名（用来在同一份媒体的一堆 CDN 地址里挑最像文件的那个） */
function looksLikeMediaPath(value) {
  return /\.(jpe?g|png|gif|webp|avif|bmp|heic|mp4|mov|m4v|webm)(\?|#|$)/i.test(String(value || ''));
}

function pathOf(value) {
  try {
    return new URL(String(value)).pathname;
  } catch {
    return '';
  }
}

/** 把一个"地址容器"（字符串 / 数组 / 带 url_list 的对象）摊平成地址数组 */
function urlsFrom(value, depth = 0) {
  if (value == null || depth > 6) return [];
  if (typeof value === 'string') return isMediaUrl(value) ? [value] : [];
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) out.push(...urlsFrom(item, depth + 1));
    return out;
  }
  if (typeof value === 'object') {
    const out = [];
    for (const key of URL_KEYS) {
      if (key in value) out.push(...urlsFrom(value[key], depth + 1));
    }
    // 形如 { h264: [{ masterUrl }] } 的流结构
    for (const key of ['h264', 'h265', 'av1', 'hevc', 'stream']) {
      if (key in value) out.push(...urlsFrom(value[key], depth + 1));
    }
    if (!out.length) {
      /**
       * 兜底：容器里所有看起来像媒体地址的字符串。
       * 不能只认 url/master/play… 开头的键名 —— 小红书把清晰度档位写成 EF4/EF5/EF6/EF7
       * 这种代号（video.media.stream.EF4.0.masterUrl），按前缀过滤就会整段视频都漏掉。
       */
      for (const [, child] of Object.entries(value)) out.push(...urlsFrom(child, depth + 1));
    }
    return out;
  }
  return [];
}

/** 从节点上取封面地址 */
function coverOf(node) {
  for (const key of COVER_KEYS) {
    const urls = urlsFrom(node?.[key]);
    if (urls.length) return urls[0];
  }
  return '';
}

function firstString(node, keys) {
  for (const key of keys) {
    const value = node?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/** 深度优先找第一个满足条件的节点（带访问上限，避免大 JSON 卡住） */
function findNode(root, predicate, { maxNodes = 4000 } = {}) {
  const stack = [root];
  let visited = 0;
  while (stack.length && visited < maxNodes) {
    const node = stack.pop();
    visited += 1;
    if (!node || typeof node !== 'object') continue;
    if (!Array.isArray(node) && predicate(node)) return node;
    const children = Array.isArray(node) ? node : Object.values(node);
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const child = children[i];
      if (child && typeof child === 'object') stack.push(child);
    }
  }
  return null;
}

/**
 * 找一个键对应的值（任意深度），accept 用来跳过"键名对上了但内容不对"的情况
 * （例如 XHS 里 `note: "xxx"` 这种字符串）。
 */
function findByKey(root, keys, { maxNodes = 4000, accept = null } = {}) {
  const wanted = new Set(keys);
  const stack = [root];
  let visited = 0;
  while (stack.length && visited < maxNodes) {
    const node = stack.pop();
    visited += 1;
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i -= 1) stack.push(node[i]);
      continue;
    }
    for (const key of Object.keys(node)) {
      if (!wanted.has(key) || !node[key]) continue;
      if (accept && !accept(node[key], key)) continue;
      return { key, value: node[key], parent: node };
    }
    const children = Object.values(node);
    for (let i = children.length - 1; i >= 0; i -= 1) {
      if (children[i] && typeof children[i] === 'object') stack.push(children[i]);
    }
  }
  return null;
}

/**
 * 媒体容器常常不在主体节点上，而是在它的子对象里：
 *   抖音：item.video.play_addr.url_list[]、item.images[].url_list[]
 *   小红书：note.imageList[].urlDefault、note.video.media.stream.h264[].masterUrl
 * 所以收集时把这几个"可能的容器层级"都过一遍。
 */
function containerLevels(node) {
  const levels = [];
  const seen = new Set();
  const add = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || seen.has(value)) return;
    seen.add(value);
    levels.push(value);
  };
  add(node);
  for (const key of ['video', 'media', 'videoData', 'video_data', 'note']) add(node?.[key]);
  add(node?.video?.media);
  return levels;
}

const hasVideoContainer = (node) =>
  containerLevels(node).some((level) => VIDEO_CONTAINER_KEYS.some((key) => key in level));
const hasImageContainer = (node) =>
  containerLevels(node).some((level) => IMAGE_CONTAINER_KEYS.some((key) => key in level));
const isItemNode = (node) => Boolean(node) && (hasVideoContainer(node) || hasImageContainer(node));

/**
 * 定位"这一次要抓的那条内容"。
 *
 * 抖音的页面数据里经常还混着推荐流、别人的作品；直接全树扫会把无关视频一起抓下来。
 * 所以优先按已知的主体结构取，取不到才退化成全树扫描（并且只认带描述/标题的节点）。
 */
function pickScope(data) {
  if (!data || typeof data !== 'object') return null;

  // 1) 抖音：aweme_detail（视频详情）
  const aweme = findByKey(data, ['aweme_detail', 'awemeDetail'], {
    accept: (value) => value && typeof value === 'object' && isItemNode(value),
  });
  if (aweme) return { node: aweme.value, source: 'aweme_detail' };

  // 2) 抖音：item_list / itemList 里第一条带媒体的
  const itemList = findByKey(data, ['item_list', 'itemList'], {
    accept: (value) => Array.isArray(value) && value.some((item) => item && typeof item === 'object' && isItemNode(item)),
  });
  if (itemList) {
    const list = Array.isArray(itemList.value) ? itemList.value : [itemList.value];
    const first = list.find((item) => item && typeof item === 'object' && isItemNode(item));
    if (first) return { node: first, source: itemList.key };
  }

  // 3) 小红书：noteDetailMap（{ noteId: { note: {...} } }）
  const detailMap = findByKey(data, ['noteDetailMap', 'note_detail_map'], {
    accept: (value) => value && typeof value === 'object' && !Array.isArray(value),
  });
  if (detailMap) {
    for (const entry of Object.values(detailMap.value)) {
      const note = entry?.note || entry?.note_card || entry?.noteCard || entry;
      if (note && typeof note === 'object' && isItemNode(note)) return { node: note, source: 'noteDetailMap' };
    }
  }

  // 4) 小红书：note / note_card
  const note = findByKey(data, ['note', 'note_card', 'noteCard'], {
    accept: (value) => value && typeof value === 'object' && isItemNode(value),
  });
  if (note) return { node: note.value, source: note.key };

  // 5) 全树：第一个带媒体容器的节点
  const any = findNode(data, isItemNode);
  if (any) return { node: any, source: 'scan' };

  return null;
}

/**
 * 从主体节点里按字段模式收集媒体。
 * @returns {{items: Array, caption: string, author: string, title: string}}
 */
export function extractSiteMedia(data, { limit = 40 } = {}) {
  const empty = { items: [], caption: '', author: '', title: '', source: '' };
  if (!data || typeof data !== 'object') return empty;

  const scope = pickScope(data);
  if (!scope) return empty;
  const node = scope.node;
  const levels = containerLevels(node);

  const items = [];
  const seen = new Set();
  const push = (kind, rawUrl, cover = '') => {
    const url = String(rawUrl || '').trim();
    if (!url) return;
    // 分享页 / 个人主页这类不是媒体文件
    if (NON_MEDIA_PATH_RE.test(pathOf(url)) && !looksLikeMediaPath(url)) return;
    const key = canonicalizeUrl(url);
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ kind, url, cover: cover && cover !== url ? cover : '' });
  };

  for (const level of levels) {
    for (const key of IMAGE_CONTAINER_KEYS) {
      if (items.length >= limit) break;
      const list = level[key];
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        if (items.length >= limit) break;
        const urls = urlsFrom(entry);
        // 同一个媒体会有多套 CDN 地址 / 预览图与原图，取画质最好的那个
        if (urls.length) push('image', bestImageUrl(urls));
      }
    }
  }

  // 视频：把页面数据里所有候选（含各清晰度档位）收齐，只落最高画质的那一条
  const videoCandidates = sortVideoCandidates(collectVideoCandidates(levels, node));
  const best = videoCandidates[0];
  if (best) push('video', best.url, best.cover);

  const author =
    firstString(node?.author, ['nickname', 'name', 'unique_id']) ||
    firstString(node?.user, ['nickname']) ||
    firstString(node?.userInfo, ['nickname']) ||
    firstString(node, ['nickname', 'author_name']);

  const caption = firstString(node, ['desc', 'description', 'content', 'caption', 'text']);
  const title = firstString(node, ['title', 'display_title', 'share_title']) || caption;

  return { items: items.slice(0, limit), caption, author, title, source: scope.source, videoCandidates: videoCandidates.map((c) => c.url) };
}

/** 按 URL 选站点适配器 */
export function siteAdapterFor(rawUrl) {
  let host = '';
  try {
    host = new URL(String(rawUrl)).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
  return (
    SITES.find((site) => site.hosts.some((h) => host === h || host.endsWith(`.${h}`))) || null
  );
}

/**
 * 站点媒体入口：解析页面数据 → 抽出图片/视频。
 * 任何失败都只返回空结果，绝不抛错（调用方还有一层 try/catch）。
 *
 * 小红书配了自建解析器（XIAOHONGSHU_API）时**优先走解析器**：一次请求就能拿到
 * 标题/正文/作者 + 图片视频直链，不受登录态与改版影响；解析器没结果再退回页面解析。
 */
export async function collectSiteMedia({ url, originalUrl, html, limit = 40, headers = {}, xhsApiUrl = '' } = {}) {
  const site = siteAdapterFor(url);
  if (!site) return { adapter: null, label: '', items: [], caption: '', author: '', title: '', source: '' };

  const failures = [];
  /** 解析器这一步失败时的可操作提示：即使后面页面解析救回来了，也要让用户知道原因 */
  let xhsApiHint = '';
  if (site.id === 'xiaohongshu' && (xhsApiUrl || xhsApiEnabled())) {
    try {
      // 优先用用户给的原始地址：分享短链只有原样交给解析器（或由它展开）才认得出来
      const viaApi = await collectViaXhsApi(originalUrl || url, { limit, apiUrl: xhsApiUrl });
      if (viaApi.items.length) {
        return {
          adapter: site.id,
          label: site.label,
          items: viaApi.items,
          caption: viaApi.caption,
          author: viaApi.author,
          title: viaApi.title,
          source: 'xhs_api',
          stateSource: 'xhs_api',
          noteId: viaApi.noteId,
          noteUrl: viaApi.noteUrl,
        };
      }
      failures.push(`xhs_api:${viaApi.reason || 'no_media'}`);
      // 注意：这里**不能**直接 return —— 解析器失败后页面解析仍可能救回来（缺 token 时就是如此）
      xhsApiHint = viaApi.hint || '';
    } catch (err) {
      failures.push(`xhs_api:${err.message}`);
    }
  }

  for (const hints of site.stateHints) {
    try {
      const state = parsePageState(html, hints);
      if (!state?.data) {
        failures.push(`${hints.label || 'state'}:none`);
        continue;
      }
      const result = extractSiteMedia(state.data, { limit });
      if (result.items.length) {
        return {
          adapter: site.id,
          label: site.label,
          ...result,
          stateSource: `${state.source}:${result.source}`,
          ...(xhsApiHint ? { xhsApiHint } : {}),
        };
      }
      failures.push(`${hints.label || 'state'}:no_media`);
    } catch (err) {
      failures.push(`${hints.label || 'state'}:${err.message}`);
    }
  }
  return {
    adapter: site.id,
    label: site.label,
    items: [],
    caption: '',
    author: '',
    title: '',
    source: '',
    failures,
    ...(xhsApiHint ? { xhsApiHint } : {}),
  };
}
