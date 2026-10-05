import { sha256 } from '../utils/text.js';

/**
 * 正文指纹：用来判断"同一个网址这次抓到的内容是否和上次一样"。
 *
 * 组成：
 *   1. 正文纯文本（空白归一化）—— 主体
 *   2. 媒体数量 + 每个媒体地址的**最后一段路径**
 *
 * 为什么用最后一段而不是完整 URL：字节跳动这类 CDN 每次加载都会换域名前缀和签名
 * （v3-web / v6-web + 一次性 signature），完整 URL 每次都不同，没法比较；
 * 而最后一段通常是内容 id 或文件名（例如 okoBl3DAAgB7MggaMnaWC1IRUQKCyQeJqtIBeG），
 * 跨会话稳定，能识别出"文字没变但换了图/视频"。
 */
export function articleFingerprint({ text = '', mediaUrls = [] } = {}) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();

  const basenames = (mediaUrls || [])
    .map((url) => {
      try {
        const segments = new URL(url).pathname.split('/').filter(Boolean);
        return segments[segments.length - 1] || '';
      } catch {
        return '';
      }
    })
    .filter(Boolean)
    .sort();

  const hash = sha256(`${normalized}|media:${basenames.length}|${basenames.join(',')}`);
  return { hash, textLength: normalized.length, mediaCount: basenames.length };
}

/**
 * 影响输出结果的抓取选项指纹。
 * 用途：同一网址、正文没变，但用户这次换了选项（比如 imageMode=none、换文件名模板），
 * 就不能拿旧存档搪塞 —— 必须重新处理。
 */
export function optionsFingerprint(options = {}) {
  const relevant = {
    imageMode: options.imageMode,
    // 目录布局决定最终链接形状（media/<标题>/01.jpg vs media/<hash>.jpg），换布局必须重抓
    mediaLayout: options.mediaLayout,
    includeImages: options.includeImages,
    includeVideos: options.includeVideos,
    includeAudio: options.includeAudio,
    filterAds: options.filterAds,
    frontmatter: options.frontmatter,
    includeTitle: options.includeTitle,
    includeMetaSection: options.includeMetaSection,
    videoMarkdown: options.videoMarkdown,
    recoverEmbeddedMedia: options.recoverEmbeddedMedia,
    maxMediaFiles: options.maxMediaFiles,
    maxFileBytes: options.maxFileBytes,
    maxVideoBytes: options.maxVideoBytes,
    maxAudioBytes: options.maxAudioBytes,
    embeddedMediaHeading: options.embeddedMediaHeading,
    observedMediaHeading: options.observedMediaHeading,
    filenameTemplate: options.filenameTemplate,
    removeSelectors: options.removeSelectors,
    engine: options.engine,
  };
  return sha256(JSON.stringify(relevant));
}
