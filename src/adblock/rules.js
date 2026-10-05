/**
 * 广告 / 追踪 / 干扰内容规则库。
 *
 * 三部分：
 *  1. HOST_PATTERNS —— 网络层拦截（无头浏览器 + 下载器都会用）
 *  2. REMOVE_SELECTORS —— DOM 层直接删除
 *  3. JUNK_ATTR_PATTERN —— 通过 class/id 词元命中的“广告容器”
 *
 * 环境变量 ADBLOCK_EXTRA_DOMAINS（逗号分隔）可追加域名，ADBLOCK_DISABLE=1 关闭。
 */

const HOST_PATTERNS = [
  // Google / 常见广告联盟
  /(^|\.)doubleclick\.net$/i,
  /(^|\.)googlesyndication\.com$/i,
  /(^|\.)googleadservices\.com$/i,
  /(^|\.)googletagservices\.com$/i,
  /(^|\.)googletagmanager\.com$/i,
  /(^|\.)google-analytics\.com$/i,
  /(^|\.)analytics\.google\.com$/i,
  /(^|\.)adservice\.google\./i,
  /(^|\.)2mdn\.net$/i,
  /(^|\.)adnxs\.com$/i,
  /(^|\.)adsrvr\.org$/i,
  /(^|\.)adform\.net$/i,
  /(^|\.)advertising\.com$/i,
  /(^|\.)amazon-adsystem\.com$/i,
  /(^|\.)adsystem\.com$/i,
  /(^|\.)criteo\.(com|net)$/i,
  /(^|\.)taboola\.com$/i,
  /(^|\.)outbrain\.com$/i,
  /(^|\.)pubmatic\.com$/i,
  /(^|\.)rubiconproject\.com$/i,
  /(^|\.)openx\.net$/i,
  /(^|\.)casalemedia\.com$/i,
  /(^|\.)sharethrough\.com$/i,
  /(^|\.)teads\.tv$/i,
  /(^|\.)smartadserver\.com$/i,
  /(^|\.)yieldmo\.com$/i,
  /(^|\.)moatads\.com$/i,
  /(^|\.)bidswitch\.net$/i,
  /(^|\.)districtm\.io$/i,
  /(^|\.)gumgum\.com$/i,
  /(^|\.)infolinks\.com$/i,
  /(^|\.)revcontent\.com$/i,
  /(^|\.)mgid\.com$/i,
  /(^|\.)zergnet\.com$/i,
  /(^|\.)plista\.com$/i,
  /(^|\.)adroll\.com$/i,
  /(^|\.)360yield\.com$/i,
  /(^|\.)sizmek\.com$/i,
  /(^|\.)flashtalking\.com$/i,
  /(^|\.)mediaplex\.com$/i,
  /(^|\.)richaudience\.com$/i,
  /(^|\.)adcolony\.com$/i,
  /(^|\.)applovin\.com$/i,
  /(^|\.)inmobi\.com$/i,
  /(^|\.)unityads\.unity3d\.com$/i,
  /(^|\.)mopub\.com$/i,
  /(^|\.)pangolin-sdk-toutiao\.com$/i,
  // 统计 / 行为分析 / 会话录制
  /(^|\.)scorecardresearch\.com$/i,
  /(^|\.)quantserve\.com$/i,
  /(^|\.)quantcast\.com$/i,
  /(^|\.)bluekai\.com$/i,
  /(^|\.)demdex\.net$/i,
  /(^|\.)everesttech\.net$/i,
  /(^|\.)chartbeat\.(com|net)$/i,
  /(^|\.)hotjar\.com$/i,
  /(^|\.)mixpanel\.com$/i,
  /(^|\.)segment\.(io|com)$/i,
  /(^|\.)amplitude\.com$/i,
  /(^|\.)braze\.com$/i,
  /(^|\.)branch\.io$/i,
  /(^|\.)adjust\.com$/i,
  /(^|\.)kochava\.com$/i,
  /(^|\.)newrelic\.com$/i,
  /(^|\.)sentry\.io$/i,
  /(^|\.)bugsnag\.com$/i,
  /(^|\.)logrocket\.(com|io)$/i,
  /(^|\.)fullstory\.com$/i,
  /(^|\.)mouseflow\.com$/i,
  /(^|\.)luckyorange\.com$/i,
  /(^|\.)crazyegg\.com$/i,
  /(^|\.)clarity\.ms$/i,
  /(^|\.)smartlook\.com$/i,
  /(^|\.)yandex\.ru$/i,
  /(^|\.)mc\.yandex\.ru$/i,
  // 国内统计 / 广告
  /(^|\.)cnzz\.com$/i,
  /(^|\.)umeng\.com$/i,
  /(^|\.)umengcloud\.com$/i,
  /(^|\.)talkingdata\.com$/i,
  /(^|\.)growingio\.com$/i,
  /(^|\.)sensorsdata\.cn$/i,
  /(^|\.)zhugeio\.com$/i,
  /(^|\.)51\.la$/i,
  /(^|\.)tanx\.com$/i,
  /(^|\.)alimama\.cn$/i,
  /(^|\.)mmstat\.com$/i,
  /(^|\.)adsame\.com$/i,
  /(^|\.)ipinyou\.com$/i,
  /(^|\.)mediav\.com$/i,
  /(^|\.)miaozhen\.com$/i,
  /(^|\.)admaster\.com$/i,
  /(^|\.)gridsumdissector\.com$/i,
  /(^|\.)adview\.cn$/i,
  /(^|\.)irs01\.com$/i,
  /(^|\.)union\.baidu\.com$/i,
  /(^|\.)pos\.baidu\.com$/i,
  /(^|\.)hm\.baidu\.com$/i,
  /(^|\.)cpro\.baidu\.com$/i,
  /(^|\.)ad\.toutiao\.com$/i,
  /(^|\.)pangolin-sdk\.com$/i,
  // 弹窗 / 订阅 / 许可管理（这些脚本通常只负责遮挡正文）
  /(^|\.)onetrust\.com$/i,
  /(^|\.)cookielaw\.org$/i,
  /(^|\.)trustarc\.com$/i,
  /(^|\.)iubenda\.com$/i,
  /(^|\.)usercentrics\.eu$/i,
  /(^|\.)privacy-mgmt\.com$/i,
  /(^|\.)sp-prod\.net$/i,
  /(^|\.)cookiebot\.com$/i,
  /(^|\.)consensu\.org$/i,
  /(^|\.)osano\.com$/i,
  /(^|\.)tinypass\.com$/i,
  /(^|\.)poool\.fr$/i,
];

const EXTRA_PATTERNS = (process.env.ADBLOCK_EXTRA_DOMAINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((domain) => new RegExp(`(^|\\.)${domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'));

/** URL 路径级别的规则（有些追踪请求本身就在主域下） */
const PATH_PATTERNS = [
  /\/pagead\//i,
  /\/gampad\//i,
  /\/adserver\//i,
  /\/advert(is|ising|ement)?[s_-]?\//i,
  /\/beacon(\?|$)/i,
  /\/telemetry(\?|$)/i,
  /\/track(ing)?(\?|$|\/)/i,
  /\/pixel(\?|$|\/)/i,
  /\/collect(\?|$)/i,
  /\/log(ger)?\.(js|gif|png)/i,
  /facebook\.com\/tr\//i,
  /linkedin\.com\/px\//i,
  /bing\.com\/bat\//i,
  /google\.com\/ads\//i,
  /hm\.baidu\.com/i,
  /\/1x1\.(gif|png)/i,
];

export const ADBLOCK_DISABLED = process.env.ADBLOCK_DISABLE === '1';

export function isBlockedUrl(rawUrl, { resourceType = '' } = {}) {
  if (ADBLOCK_DISABLED) return false;
  if (resourceType === 'document') return false; // 绝不拦截主文档
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const hostname = url.hostname;
  const full = url.toString();
  for (const re of HOST_PATTERNS) if (re.test(hostname)) return true;
  for (const re of EXTRA_PATTERNS) if (re.test(hostname)) return true;
  for (const re of PATH_PATTERNS) if (re.test(full)) return true;
  return false;
}

/** 直接删除的 DOM 选择器 */
export const REMOVE_SELECTORS = [
  'script',
  'style',
  'noscript',
  'template',
  'link',
  'meta',
  'base',
  'object',
  'embed',
  'applet',
  'canvas',
  'map',
  'form',
  'input',
  'select',
  'textarea',
  'button',
  'dialog',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[aria-modal="true"]',
  'ins.adsbygoogle',
  'ins[data-ad-client]',
  'ins[data-ad-slot]',
  'amp-ad',
  'amp-embed',
  'amp-sticky-ad',
  'amp-auto-ads',
  '[data-ad]',
  '[data-ads]',
  '[data-ad-slot]',
  '[data-ad-client]',
  '[data-ad-unit]',
  '[data-google-query-id]',
  '[data-testid="ad"]',
  '[id^="google_ads"]',
  '[id^="div-gpt-ad"]',
  '[id*="aswift"]',
  '[id*="taboola"]',
  '[id*="outbrain"]',
  '[class*="taboola"]',
  '[class*="outbrain"]',
  '[id*="criteo"]',
  '[class*="adsbygoogle"]',
  '[class*="sponsored-content"]',
  '[class*="ad-slot"]',
  '[class*="adslot"]',
  '[class*="ad-container"]',
  '[class*="ad-wrapper"]',
  '[class*="ad-overlay"]',
  '[class*="ad-placeholder"]',
  '[class*="banner-ad"]',
  '[class*="ad-banner"]',
  '[class*="advertisement"]',
  '[class*="advertiser"]',
  '[class*="popup-ad"]',
  '[class*="interstitial"]',
  '[class*="sticky-ad"]',
  '[aria-label*="advertisement" i]',
  '[aria-label*="广告"]',
  // 弹窗 / 遮罩 / 订阅框 / 同意书
  '[class*="cookie-banner"]',
  '[class*="cookie-consent"]',
  '[class*="cookie-notice"]',
  '[class*="cookiebar"]',
  '[class*="consent-banner"]',
  '[class*="gdpr"]',
  '[id*="cookie-banner"]',
  '[id*="cookie-consent"]',
  '[id*="onetrust"]',
  '[class*="onetrust"]',
  '[id*="intercom"]',
  '[class*="intercom"]',
  '[id*="drift-"]',
  '[class*="newsletter-signup"]',
  '[class*="subscribe-modal"]',
  '[class*="paywall-overlay"]',
  '[class*="modal-backdrop"]',
  '[class*="social-share"]',
  '[class*="share-buttons"]',
  '[class*="share-tools"]',
  '[class*="addthis"]',
  '[class*="sharedaddy"]',
  '[class*="jp-relatedposts"]',
  '[class*="related-posts"]',
  '[class*="recommended-articles"]',
  '[class*="you-may-also-like"]',
  '[class*="read-next"]',
  '[class*="more-from"]',
  '[class*="trending-now"]',
  '[class*="comment-respond"]',
  '[class*="comment-form"]',
  '[class*="back-to-top"]',
  '[class*="scroll-top"]',
  '[class*="skip-link"]',
  '[class*="screen-reader"]',
  '[class*="sr-only"]',
  '[class*="visually-hidden"]',
  '[class*="breadcrumb"]',
  '[class*="pagination"]',
  '[class*="pager"]',
  '[class*="sidebar"]',
  '[class*="widget-area"]',
  '[class*="site-footer"]',
  '[class*="site-header"]',
  '[class*="global-nav"]',
  '[class*="main-nav"]',
  '[class*="mobile-menu"]',
  '[class*="nav-menu"]',
  '[class*="menu-toggle"]',
  '[class*="hamburger"]',
  '[class*="sticky-header"]',
  '[class*="reading-progress"]',
  '[class*="progress-bar"]',
  '[class*="toc-toggle"]',
  '[class*="language-switch"]',
  '[class*="country-select"]',
  '[class*="app-download"]',
  '[class*="qr-code"]',
  '[class*="print-only"]',
  '[class*="no-print"]',
  '[class*="hidden-print"]',
  // 微信/公众号界面的固定噪音（扫码框、操作栏、在看/赞赏等）
  '#js_profile_qrcode',
  '#js_pc_qr_code',
  '#js_article_bottom_bar',
  '#js_article_comment',
  '.weui-dialog',
  '.weui-mask',
  '.weui-actionsheet',
  '.weui-toast',
  '.weui-half-screen-dialog',
  '.rich_media_area_extra',
  '.rich_media_tool',
  '.mp_profile_iframe_wrp',
  '.js_profile_qrcode',
  '.qr_code_pc_outer',
  '.reward_area',
  'mp-common-profile',
  'mp-common-qrcode',
  'mp-common-mpaudio',
  '[class*="qrcode"]',
  '[class*="qr_code"]',
];

/**
 * “轻量清洗”使用的最小集合：只删明确的广告位/弹窗，不碰导航与侧栏。
 * 用于激进清洗后正文过短时的兜底重试。
 */
export const LIGHT_SELECTORS = [
  'script',
  'style',
  'noscript',
  'template',
  'link',
  'meta',
  'base',
  'object',
  'embed',
  'form',
  'input',
  'select',
  'textarea',
  'button',
  'dialog',
  '[role="dialog"]',
  '[aria-modal="true"]',
  'ins.adsbygoogle',
  'ins[data-ad-client]',
  'ins[data-ad-slot]',
  'amp-ad',
  'amp-embed',
  'amp-sticky-ad',
  'amp-auto-ads',
  '[data-ad]',
  '[data-ad-slot]',
  '[data-ad-client]',
  '[data-ad-unit]',
  '[data-google-query-id]',
  '[id^="google_ads"]',
  '[id^="div-gpt-ad"]',
  '[id*="taboola"]',
  '[id*="outbrain"]',
  '[class*="adsbygoogle"]',
  '[class*="advertisement"]',
  '[class*="sponsored-content"]',
  '[class*="ad-slot"]',
  '[class*="adslot"]',
  '[class*="ad-container"]',
  '[class*="banner-ad"]',
  '[class*="ad-banner"]',
  '[class*="ad-overlay"]',
  '[class*="popup-ad"]',
  '[class*="interstitial"]',
  '[class*="cookie-banner"]',
  '[class*="cookie-consent"]',
  '[class*="consent-banner"]',
  '[id*="onetrust"]',
  '[class*="onetrust"]',
  '[id*="intercom"]',
  '[class*="intercom"]',
  '[class*="modal-backdrop"]',
];

/** 允许保留的嵌入（视频/代码托管），命中时不会被删掉 */
export const KEEP_EMBED_HOSTS = [
  /(^|\.)youtube(-nocookie)?\.com$/i,
  /(^|\.)youtu\.be$/i,
  /(^|\.)player\.vimeo\.com$/i,
  /(^|\.)bilibili\.com$/i,
  /(^|\.)player\.bilibili\.com$/i,
  /(^|\.)dailymotion\.com$/i,
  /(^|\.)youku\.com$/i,
  /(^|\.)qq\.com$/i,
  /(^|\.)ixigua\.com$/i,
  /(^|\.)soundcloud\.com$/i,
  /(^|\.)spotify\.com$/i,
  /(^|\.)codepen\.io$/i,
  /(^|\.)jsfiddle\.net$/i,
  /(^|\.)codesandbox\.io$/i,
  /(^|\.)gist\.github\.com$/i,
  /(^|\.)twitter\.com$/i,
  /(^|\.)x\.com$/i,
  /(^|\.)platform\.twitter\.com$/i,
  /(^|\.)instagram\.com$/i,
  /(^|\.)docs\.google\.com$/i,
  /(^|\.)slideshare\.net$/i,
  /(^|\.)speakerdeck\.com$/i,
];

export function isKeepEmbed(url) {
  try {
    const { hostname } = new URL(url);
    return KEEP_EMBED_HOSTS.some((re) => re.test(hostname));
  } catch {
    return false;
  }
}

/**
 * class/id 词元级“像广告/像导航”的判定。
 * 注意：必须按词元切分，避免误伤 download / header-2 / adaptive 之类。
 */
const JUNK_TOKEN = /^(ads?|advert|adverts|advertising|advertisement|adsbygoogle|adbox|adwrap|adholder|adunit|adslot|banner|banners|sponsor|sponsored|sponsorship|promo|promotion|promoted|commercial|partner|partners|recommend|recommended|recommendation|related|share|sharing|social|socials|comment|comments|disqus|newsletter|subscribe|subscription|popup|modal|overlay|lightbox|interstitial|cookie|cookies|consent|gdpr|ccpa|privacy-banner|sidebar|widget|widgets|menu|menus|nav|navbar|navigation|breadcrumb|pagination|pager|toolbar|toolbars|footer|footerlinks|header-top|skip|print|hidden|invisible|offscreen|tracking|track|analytics|telemetry|beacon|pixel|weui|qrcode|actionsheet|toast|reward|mask|guide|medal|avatar|vip|follow|fans|hotspot)$/i;

export function looksLikeJunkToken(value) {
  if (!value) return false;
  const tokens = String(value)
    .split(/[\s_\-.:[\]|/]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (!tokens.length) return false;
  // 单个词元命中即可疑；多个词元里至少有 1 个命中 + 整体较短，避免误伤长哈希类名
  return tokens.some((t) => JUNK_TOKEN.test(t));
}

/**
 * 站点自身的 UI 资源（播放器动画、按钮图标、前端框架占位图）。
 *
 * 这些和正文媒体一样是 .mp4/.png，扩展名判断放行得了，但它们永远不是内容：
 *   · 抖音：/obj/douyin-pc-web/uuu_265.mp4（点击动画）、/obj/douyin-pc-web/refresh_btn.png、
 *          /obj/ies.fe.effect/*.mp4（特效动画）
 *   · 小红书：fe-platform / fe-static / picasso-static / formula-static 下的图标与占位图
 * 实测一条 23 秒的小红书视频笔记，光这些就能多存 30MB。
 */
const UI_ASSET_RE = new RegExp(
  [
    '/obj/(?:douyin-pc-web|douyin-pc|ies\\.fe\\.effect|ies\\.fe\\.)',
    '/obj/eden-cn/', // 字节内部静态资源（抖音埋点用的 report.png 在这里）
    '/(?:fe-platform|fe-static|picasso-static|formula-static)/',
    '/uuu_\\d+\\.(?:mp4|webm)$',
  ].join('|'),
  'i',
);

export function isUiAssetUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) return false;
  try {
    const { pathname } = new URL(value, 'https://placeholder.invalid');
    return UI_ASSET_RE.test(pathname);
  } catch {
    return UI_ASSET_RE.test(value);
  }
}

/** 供 /api/rules 展示 */
export function rulesSummary() {
  return {
    disabled: ADBLOCK_DISABLED,
    hostPatterns: HOST_PATTERNS.length + EXTRA_PATTERNS.length,
    pathPatterns: PATH_PATTERNS.length,
    removeSelectors: REMOVE_SELECTORS.length,
    keepEmbedHosts: KEEP_EMBED_HOSTS.length,
  };
}
