import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { AppError, badRequest, timeout as timeoutError } from '../utils/errors.js';
import { assertUrlAllowed, downloadBuffer, isHtmlContentType, siteKeyFromUrl, withTimeout } from '../utils/net.js';
import { decodeHtmlBuffer } from '../utils/http.js';
import { canonicalizeUrl, shortHash, slugify } from '../utils/text.js';
import { isLoginWallUrl, pickTitle } from '../utils/title.js';
import { buildArticleFilename } from '../utils/filename.js';
import { Semaphore } from '../utils/pool.js';
import { browserPool } from '../browser/pool.js';
import { fixLazyMediaInPage } from '../browser/lazyload.js';
import { extractArticle } from './extract.js';
import { localizeMedia } from './media.js';
import { collectEmbeddedMediaUrls } from './embedded.js';
import { isUiAssetUrl } from '../adblock/rules.js';
import { siteCookieFor } from '../utils/cookies.js';
import { sendWebhook } from '../utils/webhook.js';
import { htmlToMarkdown } from './markdown.js';
import { mediaStore } from '../storage/media.js';
import { mediaOnlyStore } from '../storage/media-only.js';
import { articleStore, coerceArticleId } from '../storage/articles.js';
import { articleDb } from '../storage/db.js';
import { articleFingerprint, optionsFingerprint } from './fingerprint.js';

const log = logger.child({ mod: 'convert' });

/** 全局并发闸门：同时最多跑 N 个抓取任务 */
export const conversionGate = new Semaphore(config.convert.concurrency);

const ENGINES = new Set(['browser', 'fetch']);
const IMAGE_MODES = new Set(['local', 'remote', 'none']);
const MEDIA_LAYOUTS = new Set(['folder', 'flat']);
const STREAM_MANIFEST_RE = /\.(m3u8|mpd)(\?|#|$)/i;

function toBool(value, def) {
  if (value === undefined || value === null || value === '') return def;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

export function normalizeOptions(raw = {}) {
  const engine = String(raw.engine || 'browser').toLowerCase();
  if (!ENGINES.has(engine)) throw badRequest(`engine 只能是 browser 或 fetch，收到: ${engine}`);

  const imageMode = String(raw.imageMode || raw.mediaMode || 'local').toLowerCase();
  if (!IMAGE_MODES.has(imageMode)) throw badRequest(`imageMode 只能是 local/remote/none，收到: ${imageMode}`);

  const mediaLayout = String(raw.mediaLayout || raw.layout || config.storage.layout).toLowerCase();
  if (!MEDIA_LAYOUTS.has(mediaLayout)) {
    throw badRequest(`mediaLayout 只能是 folder 或 flat，收到: ${mediaLayout}`);
  }

  const timeoutMs = Number(raw.timeoutMs) > 0 ? Math.min(Number(raw.timeoutMs), 300_000) : config.convert.jobTimeoutMs;
  const positive = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };

  return {
    engine,
    imageMode,
    /** 媒体目录布局：folder（默认，按标题文件夹 + 正文顺序编号）| flat（内容寻址、跨文章去重） */
    mediaLayout,
    includeImages: toBool(raw.includeImages, true),
    includeVideos: toBool(raw.includeVideos, true),
    includeAudio: toBool(raw.includeAudio, true),
    filterAds: toBool(raw.filterAds, true),
    frontmatter: toBool(raw.frontmatter, true),
    includeTitle: toBool(raw.includeTitle, true),
    includeMetaSection: toBool(raw.includeMetaSection, false),
    store: toBool(raw.store, true),
    scroll: toBool(raw.scroll, config.browser.scroll),
    scrollSteps: Number.isFinite(Number(raw.scrollSteps)) ? Math.min(Number(raw.scrollSteps), 60) : config.browser.scrollSteps,
    waitSelector: typeof raw.waitSelector === 'string' ? raw.waitSelector.slice(0, 200) : '',
    waitMs: Number.isFinite(Number(raw.waitMs)) ? Math.max(0, Math.min(Number(raw.waitMs), 30_000)) : 0,
    timeoutMs,
    maxMediaFiles: Number.isFinite(Number(raw.maxMediaFiles)) ? Math.max(0, Number(raw.maxMediaFiles)) : config.storage.maxFilesPerPage,
    // 容量上限可按请求覆盖（例如临时允许大视频）
    maxFileBytes: positive(raw.maxFileBytes, config.storage.maxFileBytes),
    maxVideoBytes: positive(raw.maxVideoBytes, config.storage.maxVideoBytes),
    maxAudioBytes: positive(raw.maxAudioBytes, config.storage.maxAudioBytes),
    maxBytesPerPage: positive(raw.maxBytesPerPage, config.storage.maxBytesPerPage),
    maxVideoBytesPerPage: positive(raw.maxVideoBytesPerPage, config.storage.maxVideoBytesPerPage),
    /** 下载文件名模板，可覆盖服务端默认（如 {date}-{title}） */
    filenameTemplate:
      typeof raw.filenameTemplate === 'string' && raw.filenameTemplate.trim()
        ? raw.filenameTemplate.trim().slice(0, 200)
        : config.filenames.template,
    /** 从页面数据里补出来的媒体放在正文末尾，用这个标题标注来源 */
    embeddedMediaHeading:
      typeof raw.embeddedMediaHeading === 'string' && raw.embeddedMediaHeading.trim()
        ? raw.embeddedMediaHeading.trim().slice(0, 60)
        : '图片（来自页面数据）',
    /** 只出现在播放器网络请求里的音视频，补出来时用这个标题 */
    observedMediaHeading:
      typeof raw.observedMediaHeading === 'string' && raw.observedMediaHeading.trim()
        ? raw.observedMediaHeading.trim().slice(0, 60)
        : '视频（来自页面请求）',
    /** 关掉"从页面数据补媒体"的行为 */
    recoverEmbeddedMedia: toBool(raw.recoverEmbeddedMedia, true),
    /** 忽略"正文未变化就别再下载"的判断，强制完整重抓 */
    force: toBool(raw.force, false),
    /**
     * 只下载视频/图片（API: mediaOnly=1，别名 onlyMedia）：
     * 媒体落到独立的媒体目录（默认与 DATA_DIR 同级的 media-only），
     * 并且默认不落文章（想同时存文章就显式传 store=true）。
     */
    mediaOnly: toBool(raw.mediaOnly ?? raw.onlyMedia, false),
    /** 请求里是否显式指定了 store（mediaOnly 只在没显式指定时才强制关掉文章落盘） */
    storeExplicit: raw.store !== undefined,
    /** webhook：显式 true/false；不传时"只下载媒体"模式且配了 WEBHOOK_URL 才发 */
    webhook: raw.webhook === undefined ? undefined : toBool(raw.webhook, false),
    /** 单次请求覆盖 webhook 地址（留空用服务端 WEBHOOK_URL） */
    webhookUrl:
      typeof raw.webhookUrl === 'string' && /^https?:\/\//i.test(raw.webhookUrl.trim())
        ? raw.webhookUrl.trim().slice(0, 500)
        : '',
    /** 单次请求覆盖小红书自建解析器地址（留空用服务端 XIAOHONGSHU_API） */
    xhsApiUrl:
      typeof raw.xhsApiUrl === 'string' && /^https?:\/\//i.test(raw.xhsApiUrl.trim())
        ? raw.xhsApiUrl.trim().slice(0, 500)
        : '',
    /** 小红书是否"只用解析器、不抓网页"：默认跟随服务端 XIAOHONGSHU_PARSER_ONLY */
    xhsParserOnly: raw.xhsParserOnly === undefined ? config.xhsParserOnly : toBool(raw.xhsParserOnly, true),
    /** 视频/音频在 Markdown 里用 HTML 标签还是链接：html | link | both */
    videoMarkdown: ['html', 'link', 'both'].includes(String(raw.videoMarkdown || '').toLowerCase())
      ? String(raw.videoMarkdown).toLowerCase()
      : config.markdown.video,
    extraRemoveSelectors: Array.isArray(raw.removeSelectors)
      ? raw.removeSelectors.filter((s) => typeof s === 'string' && s.length < 200).slice(0, 50)
      : [],
    headers: raw.headers && typeof raw.headers === 'object' ? raw.headers : {},
    cookies: typeof raw.cookies === 'string' ? raw.cookies.slice(0, 8000) : '',
    userAgent: typeof raw.userAgent === 'string' && raw.userAgent ? raw.userAgent.slice(0, 400) : config.fetch.userAgent,
    /** 请求里是否显式指定了 UA（显式指定才覆盖浏览器自己的 UA） */
    userAgentExplicit: typeof raw.userAgent === 'string' && raw.userAgent.trim() !== '',
    keepMarkdownInResponse: toBool(raw.returnMarkdown, true),
    onMediaError: raw.onMediaError === 'drop' ? 'drop' : 'keep',
  };
}

/** 给媒体条目补上磁盘绝对路径（自动化/脚本常需要直接读文件，尤其是 mediaOnly 模式） */
function addLocalPath(store, item) {
  if (!item?.file || !store) return item;
  try {
    return { ...item, localPath: store.localPath({ f: item.file }) };
  } catch {
    return item;
  }
}

async function autoScroll(page, steps) {
  if (!steps || steps <= 0) return;
  try {
    await page.evaluate(async (maxSteps) => {
      await new Promise((resolve) => {
        let count = 0;
        const step = () => {
          const scrolled = window.scrollY || window.pageYOffset || 0;
          window.scrollBy(0, Math.max(window.innerHeight * 0.9, 500));
          count += 1;
          const atBottom = scrolled + window.innerHeight >= (document.body?.scrollHeight || 0) - 4;
          if (count >= maxSteps || atBottom) {
            window.scrollTo(0, 0);
            resolve();
            return;
          }
          setTimeout(step, 220);
        };
        step();
        setTimeout(() => {
          window.scrollTo(0, 0);
          resolve();
        }, maxSteps * 320 + 1500);
      });
    }, steps);
  } catch (err) {
    log.debug('自动滚动失败（忽略）', { err: err.message });
  }
}

/** 无头浏览器抓取：返回渲染后的 HTML + 网络层捕获的媒体字节 + Cookie */
async function captureWithBrowser(url, options) {
  const capture = new Map();
  const observed = new Map();
  let stats = { blocked: 0, captured: 0, captureBytes: 0, skippedLarge: 0, observedMedia: 0 };

  const result = await browserPool.withPage(
    async (page, context) => {
      const navTimeout = Math.min(options.timeoutMs, config.browser.navigationTimeoutMs);
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeout });

      if (options.waitSelector) {
        await page.waitForSelector(options.waitSelector, { timeout: Math.min(navTimeout, 20_000) }).catch(() => {});
      }
      if (options.waitMs) await page.waitForTimeout(options.waitMs);

      await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});

      if (options.scroll) await autoScroll(page, options.scrollSteps);

      let lazyFixed = 0;
      let bgConverted = 0;
      let playerChromeRemoved = 0;
      try {
        const fixed = await page.evaluate(fixLazyMediaInPage);
        lazyFixed = fixed?.fixed || 0;
        bgConverted = fixed?.bgConverted || 0;
        playerChromeRemoved = fixed?.playerChromeRemoved || 0;
      } catch (err) {
        log.debug('懒加载修复脚本执行失败（忽略）', { err: err.message });
      }

      await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(config.browser.settleMs);

      /**
       * 把播放器推起来再收网。
       *
       * 抖音（以及其它 MSE 播放器）的视频地址不会出现在 HTML 里：播放器用 blob: + MediaSource，
       * 靠 fetch + Range 分片去取 DASH 流，**只有真正开始播放才会发出这些请求**。
       * 不推这一把，抓到的就只是页面装饰图 —— 同一地址有时抓得到、有时抓不到，就是这么来的。
       * 音频轨同理：DASH 的声画是两条流，都得请求过我们才知道地址（之后由 ffmpeg 合流）。
       */
      if (options.includeVideos) {
        try {
          const nudged = await page.evaluate(() => {
            let started = 0;
            for (const video of document.querySelectorAll('video')) {
              try {
                video.muted = true;
                video.setAttribute('playsinline', '');
                const p = video.play?.();
                if (p && typeof p.catch === 'function') p.catch(() => {});
                started += 1;
              } catch {
                /* 单个播放器失败不影响其它 */
              }
              // 有些播放器把开始交给自定义按钮
              const box = video.closest('div');
              if (box && !video.paused) continue;
              const button = box?.querySelector('[class*="play" i], [aria-label*="播放"]');
              if (button && typeof button.click === 'function') {
                try {
                  button.click();
                  started += 1;
                } catch {
                  /* ignore */
                }
              }
            }
            return started;
          });
          if (nudged) {
            log.debug('已尝试触发播放器', { players: nudged });
            await page.waitForTimeout(config.browser.playNudgeMs);
            await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
          }
        } catch (err) {
          log.debug('触发播放器失败（忽略）', { err: err.message });
        }
      }

      const html = await page.content();
      const finalUrl = page.url();
      const pageTitle = await page.title().catch(() => '');

      // 只带"第一方"Cookie 去抓媒体：避免把无关站点的 Cookie 发给第三方 CDN
      let pageHost = '';
      try {
        pageHost = new URL(finalUrl).hostname;
      } catch {
        pageHost = '';
      }
      const cookies = await context
        .cookies()
        .then((list) =>
          list
            .filter((c) => {
              const domain = String(c.domain || '').replace(/^\./, '').toLowerCase();
              if (!domain || !pageHost) return false;
              const host = pageHost.toLowerCase();
              return host === domain || host.endsWith(`.${domain}`);
            })
            .map((c) => `${c.name}=${c.value}`)
            .join('; '),
        )
        .catch(() => '');

      return {
        html,
        finalUrl,
        pageTitle,
        cookies,
        capture,
        observed,
        lazyFixed,
        bgConverted,
        playerChromeRemoved,
        httpStatus: response?.status() ?? 0,
      };
    },
    {
      capture,
      observed,
      cookies: options.cookies || null,
      /**
       * 浏览器 UA：请求里显式指定了才覆盖，否则用浏览器自己的真实 UA
       * （否则会出现"UA 说 Windows/131、实际是 Linux/153"这种矛盾身份，被风控拦）。
       */
      userAgent: options.userAgentExplicit ? options.userAgent : config.browser.userAgent,
      extraHeaders: options.headers,
      blockFonts: false,
      blockMedia: !options.includeVideos,
      captureLimit: Math.max(1, options.maxMediaFiles),
      onStats: (s) => {
        stats = s;
      },
    },
  );

  return { ...result, stats };
}

/** 纯 HTTP 抓取（无需浏览器，适合静态页面/容器资源紧张时） */
async function captureWithFetch(url, options) {
  const request = (cookie) =>
    downloadBuffer(url, {
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...(cookie ? { cookie } : {}),
        ...options.headers,
      },
      maxBytes: 16 * 1024 * 1024,
      timeoutMs: Math.min(options.timeoutMs, config.fetch.timeoutMs),
    });

  let res = await request(options.cookies);
  let cookiesUsed = options.cookies || '';

  /**
   * 分享短链（xhslink.cn / v.douyin.com 之类）的第一跳域名常常不在站点名单里，
   * 于是这一跳没带 Cookie，跳到主站后才被登录墙挡住。
   * 这里按"跳转后的最终域名"再取一次站点 Cookie，命中就带着重抓一次。
   */
  if (!cookiesUsed) {
    const siteCookie = siteCookieFor(res.finalUrl);
    if (siteCookie) {
      log.debug('短链跳转后命中站点 Cookie，带 Cookie 重抓一次', { finalUrl: String(res.finalUrl).slice(0, 120) });
      try {
        const retry = await request(siteCookie);
        res = retry;
        cookiesUsed = siteCookie;
      } catch (err) {
        log.debug('带 Cookie 重抓失败，沿用第一次的结果', { err: err.message });
      }
    }
  }

  const html = decodeHtmlBuffer(res.buffer, res.mime);
  return {
    html,
    finalUrl: res.finalUrl,
    pageTitle: '',
    cookies: cookiesUsed,
    capture: new Map(),
    observed: new Map(),
    lazyFixed: 0,
    bgConverted: 0,
    httpStatus: res.status,
    contentType: res.mime,
  };
}

/**
 * 站点适配器（抖音 / 小红书）是"锦上添花"：模块本身或解析逻辑出问题都不该让整次抓取失败，
 * 所以这里动态引入 + 兜底，任何异常都退化成"这个站点没有适配器"。
 */
const EMPTY_SITE_RESULT = { adapter: null, label: '', items: [], caption: '', author: '', title: '' };

/**
 * 小红书：只用自建解析器的数据成文，**完全不抓网页**。
 *
 * 只在「链接属于小红书」且「配了解析器」（服务端 `XIAOHONGSHU_API` 或请求里的 `xhsApiUrl`）时启用。
 * 未登录或被风控时网页只会返回「安全限制」这类页面，抓它既拿不到内容、又容易招来验证，
 * 所以配了解析器就没必要碰网页。任何失败都返回 null，调用方照常抓网页，不影响其它站点。
 */
async function tryXhsParserArticle(rawUrl, options, warnings) {
  try {
    const sites = await import('./sites/index.js');
    if (sites.siteAdapterFor(rawUrl)?.id !== 'xiaohongshu') return null;

    const api = await import('./sites/xhs-api.js');
    const apiUrl = options.xhsApiUrl || '';
    if (!apiUrl && !api.xhsApiEnabled()) return null;

    const built = await api.buildXhsParserHtml(rawUrl, {
      limit: Math.max(10, options.maxMediaFiles),
      apiUrl,
      cookie: options.cookies || undefined,
    });
    if (!built) return null;

    warnings.push('已用小红书自建解析器直接成文（未抓取网页，避免登录页/风控页）');
    return built;
  } catch (err) {
    log.warn('小红书自建解析器不可用，改为抓取网页', { err: err.message });
    return null;
  }
}

async function runSiteAdapters({ url, originalUrl, html, limit, headers = {}, xhsApiUrl = '' }) {
  try {
    const mod = await import('./sites/index.js');
    if (typeof mod?.collectSiteMedia !== 'function') return { ...EMPTY_SITE_RESULT };
    const result = await mod.collectSiteMedia({ url, originalUrl, html, limit, headers, xhsApiUrl });
    return { ...EMPTY_SITE_RESULT, ...(result || {}) };
  } catch (err) {
    log.warn('站点适配器不可用（忽略，不影响正文抓取）', { err: err.message });
    return { ...EMPTY_SITE_RESULT };
  }
}

function countWords(text) {
  const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
  const latin = (text.replace(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g, ' ').match(/[A-Za-z0-9_'’-]+/g) || []).length;
  return cjk + latin;
}

/**
 * 复用已存档的文章：正文副本、磁盘文件、图床文件都还在才复用。
 * 任何一项缺失（比如手动删过文件/清理过图床）都返回 null，让调用方走完整流程重新抓。
 */
async function tryReuseArticle(record, { options, fingerprint, warnings }) {
  const stored = articleDb.getStoredArticle(record.articleId);
  if (!stored?.markdown) {
    log.debug('复用未通过：数据库里没有正文副本', { id: record.articleId });
    return null;
  }

  // 磁盘上那两份文件还在吗
  const meta = await articleStore.getMeta(stored.id).catch(() => null);
  if (!meta) {
    log.debug('复用未通过：磁盘上的文章文件已不在', { id: stored.id });
    return null;
  }

  // 文章引用的图床文件都还在吗（被容量淘汰/手动删过就不能复用）
  const media = Array.isArray(meta.media) ? meta.media : [];
  for (const item of media.slice(0, 200)) {
    if (!item?.hash) continue;
    // folder 布局按文件路径找（同一份内容在别的文章里有副本，按 hash 找会指错文件）
    const record = item.file ? mediaStore.getByFile(item.file) : mediaStore.getByHash(item.hash);
    const exists = await mediaStore.has(record);
    if (!exists) {
      log.debug('复用未通过：图床文件已丢失', { id: stored.id, file: item.file });
      return null;
    }
  }

  const filename = meta.filename || stored.filename || '';
  warnings.push(
    `该网址已抓取过 ${(record.fetchCount || 0) + 1} 次，正文未发生变化（指纹 ${fingerprint.hash.slice(0, 8)}），已直接复用存档与图床文件，未重新下载`,
  );

  return {
    id: stored.id,
    url: meta.url || stored.url,
    finalUrl: meta.finalUrl || stored.final_url,
    title: meta.title || stored.title,
    author: meta.author || '',
    siteName: meta.siteName || '',
    published: meta.published || '',
    excerpt: meta.excerpt || '',
    createdAt: meta.createdAt || stored.created_at,
    engine: options.engine,
    filename,
    markdown: options.keepMarkdownInResponse ? stored.markdown : undefined,
    markdownUrl: `${config.publicBaseUrl}/api/articles/${encodeURIComponent(stored.id)}/markdown`,
    downloadUrl: `${config.publicBaseUrl}/api/articles/${encodeURIComponent(stored.id)}/download`,
    articleApiUrl: `${config.publicBaseUrl}/api/articles/${encodeURIComponent(stored.id)}`,
    media,
    mediaFailures: meta.mediaFailures || [],
    stats: {
      ...(meta.stats || {}),
      words: meta.stats?.words ?? countWords(stored.markdown),
      media: { ...(meta.stats?.media || {}), saved: 0, reusedFromCache: media.length, failed: 0 },
      elapsedMs: 0,
    },
    warnings,
    unchanged: true,
    reused: true,
  };
}

/**
 * 主流程：网址 → 抓取 → 过滤 → Markdown → 本地图床 → 落盘。
 *
 * 外面套了一层"浏览器被风控挡了就退回 fetch 引擎"的自动降级，见 convertOnce 的调用处。
 */
export async function convertUrl(rawUrl, rawOptions = {}) {
  const result = await runWithFetchFallback(rawUrl, rawOptions);
  return await maybeNotify(result, rawOptions);
}

/**
 * webhook 通知：显式传了 webhook 就按它，否则"只下载媒体 或 指定了 webhookUrl"时自动发。
 * 发送失败只记日志，不影响抓取结果（结果里带 webhook 字段供排查）。
 */
async function maybeNotify(result, rawOptions) {
  const url = typeof rawOptions.webhookUrl === 'string' && rawOptions.webhookUrl.trim()
    ? rawOptions.webhookUrl.trim()
    : config.webhook.url;
  const want =
    rawOptions.webhook === undefined
      ? Boolean(result?.mediaOnly) || Boolean(rawOptions.webhookUrl)
      : toBool(rawOptions.webhook, false);
  if (!want || !url) return result;
  const sent = await sendWebhook(result, { event: result?.mediaOnly ? 'media.downloaded' : 'convert.finished', url });
  return { ...result, webhook: sent };
}

async function runWithFetchFallback(rawUrl, rawOptions = {}) {
  const first = await convertOnce(rawUrl, rawOptions);
  if (!shouldRetryWithFetch(first, rawOptions)) return first;

  log.info('浏览器引擎几乎没抓到内容，改用 fetch 引擎重试一次', { url: String(rawUrl).slice(0, 120) });
  try {
    const second = await convertOnce(rawUrl, { ...rawOptions, engine: 'fetch', __noFetchFallback: true });
    // 只在新结果确实更好时采用（正文更多，或多了媒体）
    const better =
      (second.stats?.words || 0) > (first.stats?.words || 0) ||
      ((second.media?.length || 0) > 0 && (first.media?.length || 0) === 0);
    if (better) {
      // 第一次落的那篇（风控页/空壳）没用了，连它的图床文件一起清掉
      if (first.id && first.id !== second.id) {
        const { deleteArticle } = await import('../storage/maintenance.js');
        await deleteArticle({ id: first.id, withMedia: true }).catch((err) =>
          log.debug('清理风控页文章失败（忽略）', { id: first.id, err: err.message }),
        );
      }
      second.warnings = [
        ...(second.warnings || []),
        '浏览器引擎被站点风控拦截（正文几乎为空），已自动改用 fetch 引擎重抓',
      ];
      return second;
    }
  } catch (err) {
    log.warn('fetch 引擎重试失败，保留浏览器引擎的结果', { err: err.message });
  }
  return first;
}

/**
 * 浏览器引擎 + 正文几乎为空 = 多半是被风控页挡住了（例如小红书返回"安全限制"），
 * 这时候值得用 fetch 引擎再试一次：小红书这类站点的重要内容本来就在服务端渲染的页面数据里。
 */
function shouldRetryWithFetch(result, rawOptions) {
  if (!result || rawOptions.__noFetchFallback) return false;
  if (String(result.engine || '').toLowerCase() !== 'browser') return false;
  const words = result.stats?.words || 0;
  const media = (result.media || []).length;
  return words < 40 && media <= 2;
}

/**
 * 单次转换（不带降级）。
 */
async function convertOnce(rawUrl, rawOptions = {}) {
  const options = normalizeOptions(rawOptions);
  /**
   * 站点 Cookie：请求里没传就用配置里的（DOUYIN_COOKIE / XIAOHONGSHU_COOKIE / SITE_COOKIES）。
   * 抖音、小红书不登录基本看不了，配一次就不用每次请求都带 cookies 参数了。
   */
  if (!options.cookies) options.cookies = siteCookieFor(rawUrl);
  if (options.cookies) log.debug('已带上站点 Cookie', { url: String(rawUrl).slice(0, 120), bytes: options.cookies.length });
  // 只下载媒体时默认不落文章（显式传了 store 就按用户的来）
  if (options.mediaOnly && !options.storeExplicit) options.store = false;
  const started = Date.now();
  const warnings = [];

  const { url } = await assertUrlAllowed(rawUrl);

  return conversionGate.run(async () => {
    log.info('开始转换', { url: url.toString(), engine: options.engine });
    const timer = withTimeout(options.timeoutMs, '转换超时');

    try {
      /**
       * 小红书配了自建解析器时**先走解析器、完全不抓网页**：
       * 网页端未登录/被风控时只会返回「安全限制」这类页面 —— 没内容、还容易招来验证。
       * 解析器给出了作品数据就用它造一篇页面往下走；没给出内容（或没配解析器）才照常抓网页。
       */
      let parserArticle = null;
      if (options.xhsParserOnly) {
        parserArticle = await tryXhsParserArticle(url.toString(), options, warnings);
      }

      const shot = parserArticle
        ? {
            html: parserArticle.html,
            finalUrl: parserArticle.noteUrl || url.toString(),
            httpStatus: 200,
            contentType: 'text/html; charset=utf-8',
            pageTitle: parserArticle.title,
            stats: { blocked: 0, captured: 0, observedMedia: 0 },
            source: 'xhs_api',
          }
        : options.engine === 'browser'
          ? await captureWithBrowser(url.toString(), options)
          : await captureWithFetch(url.toString(), options);

      if (!shot.html || shot.html.length < 50) {
        throw new AppError('目标页面没有返回有效 HTML', { status: 422, code: 'empty_document' });
      }
      if (shot.httpStatus >= 400) {
        warnings.push(`目标页面返回 HTTP ${shot.httpStatus}`);
      }
      if (options.engine === 'fetch' && shot.contentType && !isHtmlContentType(shot.contentType)) {
        warnings.push(`目标返回的内容类型为 ${shot.contentType}，可能不是 HTML 页面`);
      }

      const extracted = extractArticle({
        html: shot.html,
        url: shot.finalUrl || url.toString(),
        options: {
          extraRemoveSelectors: options.filterAds ? options.extraRemoveSelectors : [],
          aggressive: options.filterAds,
        },
      });

      if (!options.filterAds) {
        warnings.push('filterAds=false：未启用广告/无关内容过滤');
      }

      const root = extracted.root;

      /**
       * 页面数据兜底：把 <script> 内嵌数据里、但 DOM 里没渲染出来的媒体补进正文。
       * 微信"图片消息"、Next.js/Nuxt 站点、swiper 相册都是这种结构 ——
       * 图片地址只在数据里，DOM 里要么没有，要么只加载了可视区域那一两张。
       */
      const domMediaUrls = new Set(
        [...root.querySelectorAll('img[src], video[src], audio[src], video[poster]')]
          .map((el) => el.getAttribute('src') || el.getAttribute('poster') || '')
          .filter((value) => /^https?:/i.test(value))
          .map((value) => canonicalizeUrl(value)),
      );

      /**
       * 网址记录：同一个网址重新抓取时，先看正文指纹有没有变。
       * 没变就直接复用已存档的文章与图床文件 —— 一个字节都不用重新下载。
       */
      await articleDb.ready();
      const fingerprint = articleFingerprint({
        text: extracted.article.textContent || '',
        mediaUrls: [...domMediaUrls],
      });
      const optionsHash = optionsFingerprint(options);
      // 记录键统一用规范化 URL：同一个页面从不同分享链接进来（带 utm_ 等）要算同一个网址
      const urlKey = canonicalizeUrl(url.toString());
      const knownUrl = articleDb.getUrlRecord(urlKey);
      const skipCheck = config.database.skipUnchanged && !options.force;
      if (skipCheck) {
        const contentSame = knownUrl ? knownUrl.contentHash === fingerprint.hash : false;
        const optionsSame = knownUrl ? (knownUrl.optionsHash || '') === optionsHash : false;
        if (knownUrl?.articleId && contentSame && optionsSame) {
          const reused = await tryReuseArticle(knownUrl, { options, fingerprint, warnings });
          if (reused) {
            articleDb.recordFetch({
              url: urlKey,
              articleId: reused.id,
              title: reused.title,
              contentHash: fingerprint.hash,
              textLength: fingerprint.textLength,
              mediaCount: fingerprint.mediaCount,
              optionsHash,
              status: 'ok',
              changed: false,
            });
            log.info('正文未变化，复用已存档文章', { url: urlKey, id: reused.id });
            return reused;
          }
        } else {
          log.debug('未复用已存档文章', {
            url: urlKey,
            reason: !knownUrl ? 'no_record' : !knownUrl.articleId ? 'record_without_article' : 'content_or_options_changed',
            contentSame,
            optionsSame,
            storedHash: String(knownUrl?.contentHash || '').slice(0, 8),
            currentHash: fingerprint.hash.slice(0, 8),
          });
        }
      }

      /**
       * 站点适配器（抖音 / 小红书）必须放在通用兜底之前判断：这两类站点的页面数据里
       * 既有本条内容的真实地址，也混着站点 UI 资源（搜索图标、占位图）、推荐位封面
       * 以及同一段视频的多个清晰度档位。适配器一旦命中，"页面数据捞媒体"就该让位，
       * 否则补进正文的全是这些噪声（实测一条 23 秒的小红书视频笔记会因此多抓 30MB）。
       */
      const siteAdapterEnabled = Boolean(
        options.recoverEmbeddedMedia && options.includeImages && options.imageMode !== 'none',
      );
      const siteInfo = parserArticle
        ? {
            adapter: 'xiaohongshu',
            label: '小红书',
            items: parserArticle.items,
            /** 作品描述已经写进正文了，别再当"导语"插一遍 */
            caption: '',
            captionInBody: true,
            author: parserArticle.author,
            title: parserArticle.title,
            source: 'xhs_api',
            stateSource: 'xhs_api',
            noteId: parserArticle.noteId,
            noteUrl: parserArticle.noteUrl,
          }
        : siteAdapterEnabled
          ? await runSiteAdapters({
              url: shot.finalUrl || url.toString(),
              /** 用户给的原始地址：分享短链要靠它才能被自建解析器认出来 */
              originalUrl: url.toString(),
              /** 单次请求里的解析器地址覆盖（留空用服务端配置） */
              xhsApiUrl: options.xhsApiUrl || '',
              html: shot.html || '',
              limit: Math.max(10, options.maxMediaFiles),
              headers: { referer: shot.finalUrl || url.toString(), ...(options.cookies ? { cookie: options.cookies } : {}) },
            })
          : { ...EMPTY_SITE_RESULT };
      const siteAdapterHit = siteInfo.items.length > 0;
      /**
       * 自建解析器这一步失败时，把"该怎么办"直接摆进 warnings：
       * 容器里最常见的是网络问题（DDNS 只有 IPv6 记录、容器默认没 IPv6 → 连不通），
       * 只把失败原因写在日志里，用户根本看不到。
       */
      if (siteInfo.xhsApiHint) warnings.push(`小红书自建解析器：${siteInfo.xhsApiHint}`);
      if (siteAdapterHit) {
        log.debug('站点适配器命中，跳过通用页面数据兜底', { label: siteInfo.label, items: siteInfo.items.length });
      }

      const embedded = siteAdapterHit
        ? []
        : collectEmbeddedMediaUrls(shot.html, {
            baseUrl: shot.finalUrl || url.toString(),
            limit: Math.max(20, options.maxMediaFiles * 2),
            skipUrls: domMediaUrls,
          });

      let embeddedUsed = [];
      const appendMediaSection = (headingText, items, { captured = false } = {}) => {
        if (!items.length) return;
        const doc = root.ownerDocument;
        const section = doc.createElement('section');
        section.setAttribute('data-wc-embedded', '1');
        if (captured) section.setAttribute('data-wc-captured', '1');
        const heading = doc.createElement('h2');
        heading.textContent = headingText;
        section.appendChild(heading);
        for (const item of items) {
          // 每个媒体单独一个 <p>：否则 Turndown 会把连续的媒体挤在同一行
          const holder = doc.createElement('p');
          const node = doc.createElement(item.kind === 'video' ? 'video' : item.kind === 'audio' ? 'audio' : 'img');
          node.setAttribute('src', item.url);
          node.setAttribute('data-wc-embedded', '1');
          // 明确标出"这是从播放器网络请求里补出来的"：媒体阶段据此做同内容去重
          if (captured) node.setAttribute('data-wc-captured', '1');
          // 视频封面：媒体阶段会把它也下载到本地（<video poster> 在阅读模式里就是首帧图）
          if (item.kind === 'video' && item.cover) node.setAttribute('poster', item.cover);
          if (item.kind === 'video') node.setAttribute('controls', '');
          holder.appendChild(node);
          section.appendChild(holder);
        }
        root.appendChild(section);
      };

      if (options.recoverEmbeddedMedia && embedded.length && options.imageMode !== 'none') {
        // 只在"页面数据里的媒体明显比 DOM 里多"时补：DOM 里已经有足够媒体时，
        // 数据里那些多半是推荐位/其它文章的缩略图，补进来反而是污染。
        const domCount = domMediaUrls.size;
        const useAll = domCount === 0 || embedded.length >= domCount * 2;
        const domHosts = new Set(
          [...domMediaUrls].map((u) => {
            try {
              return new URL(u).hostname;
            } catch {
              return '';
            }
          }),
        );
        embeddedUsed = useAll
          ? embedded
          : embedded.filter((item) => {
              try {
                return domHosts.has(new URL(item.url).hostname);
              } catch {
                return false;
              }
            });

        appendMediaSection(options.embeddedMediaHeading, embeddedUsed);
      }

      /**
       * 网络层观测兜底：播放器把真实地址藏在 JS 里（字节跳动的短视频页就是这样：
       * HTML 里既没有 <video> 也没有地址，全靠 tt-videoid + 签名 token 换播放信息）。
       * 只要浏览器实际请求过可下载的音视频文件，就把它补进正文。
       * 注意：正文里存在 video/audio 节点时交给媒体阶段去填，避免重复。
       */
      let observedUsed = [];
      if (
        options.recoverEmbeddedMedia &&
        options.includeVideos &&
        options.imageMode !== 'none' &&
        shot.observed?.size &&
        root.querySelectorAll('video, audio').length === 0
      ) {
        const knownKeys = new Set([
          ...domMediaUrls,
          ...embeddedUsed.map((item) => canonicalizeUrl(item.url)),
        ]);
        // 同一段视频会被播放器从多个 CDN 镜像（同路径、不同域名）各请求一次，只留第一个
        const seenMirrorPaths = new Set();
        observedUsed = [...shot.observed.values()].filter((item) => {
          if (!item?.url) return false;
          if (knownKeys.has(canonicalizeUrl(item.url))) return false;
          if (isUiAssetUrl(item.url)) return false; // 播放器动画 / 按钮图标
          if (STREAM_MANIFEST_RE.test(item.url)) return false; // m3u8/mpd 无法存成单文件
          if (/\.(ts|m4s|cmfv|cmfa|aac)(\?|#|$)/i.test(item.url)) return false; // 分片
          let pathname = '';
          try {
            pathname = new URL(item.url).pathname;
          } catch {
            return false;
          }
          if (seenMirrorPaths.has(pathname)) return false;
          seenMirrorPaths.add(pathname);
          return true;
        });
        appendMediaSection(options.observedMediaHeading, observedUsed, { captured: true });
        if (observedUsed.length) {
          warnings.push(
            `有 ${observedUsed.length} 个音视频地址只出现在播放器的网络请求里（页面 HTML 中没有），已补到正文末尾的「${options.observedMediaHeading}」小节`,
          );
        }
      }

      /**
       * 站点适配器兜底（抖音 / 小红书这类"媒体地址只在页面 JS 数据里"的站点）。
       *
       * 与上面的"页面数据捞媒体"不同：这类站点的正文 DOM 里连占位 <img> 都没有，
       * 只有一个空壳播放器 + 一段签名接口调用，所以需要按站点结构解析页面数据，
       * 把图片/视频按原顺序补成真实节点。解析失败只是少抓几个文件，不影响正文。
       */
      let siteUsed = [];
      if (siteAdapterHit) {
        const knownKeys = new Set([
          ...domMediaUrls,
          ...embeddedUsed.map((item) => canonicalizeUrl(item.url)),
          ...observedUsed.map((item) => canonicalizeUrl(item.url)),
        ]);
        siteUsed = siteInfo.items.filter((item) => !knownKeys.has(canonicalizeUrl(item.url)));
        if (siteUsed.length) {
          const heading = `媒体（来自${siteInfo.label || '页面数据'}）`;
          appendMediaSection(heading, siteUsed);
          warnings.push(
            `已从${siteInfo.label || '页面数据'}的页面数据里解析出 ${siteUsed.length} 个媒体文件（DOM 里没有真实地址）`,
          );
        }
      }
      /**
       * 正文太薄（只有播放器，没有文案）时，用页面数据里的描述当导语。
       * 例外：自建解析器直接成文时，作品描述**已经**是正文主体了，再插一次会重复一整段。
       */
      let introFromSite = false;
      if (
        siteAdapterEnabled &&
        siteInfo.caption &&
        !siteInfo.captionInBody &&
        (extracted.article.textContent || '').replace(/\s+/g, '').length < 40
      ) {
        const doc = root.ownerDocument;
        const intro = doc.createElement('p');
        intro.setAttribute('data-wc-intro', '1');
        intro.textContent = siteInfo.caption;
        root.insertBefore(intro, root.firstChild);
        introFromSite = true;
      } else if (siteInfo.captionInBody) {
        // 描述本身就是正文：别因为"正文太短"再报一条误导性的警告
        introFromSite = true;
      }

      // 文章 id 与媒体文件夹都需要提前算出来（媒体要先落盘、再生成 Markdown 链接）
      const titleForId = pickTitle(extracted.article.title, siteInfo.title, shot.pageTitle, url.hostname);
      const createdAt = new Date().toISOString();
      const baseId = coerceArticleId(
        `${createdAt.slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}-${shortHash(
          shot.finalUrl || url.toString(),
          6,
        )}-${slugify(titleForId, { maxLength: 48, fallback: 'article' })}`,
      );
      const earlyId = options.store ? await articleStore.uniqueId(baseId) : baseId;
      // 媒体布局：normalizeOptions 已归一化，这里再兜一层，防止外部直接拼 options 时漏传
      const mediaLayout = MEDIA_LAYOUTS.has(options.mediaLayout) ? options.mediaLayout : config.storage.layout;
      /**
       * 站点目录名：媒体按网站分类（media/<站点域名>/…）。
       * 用最终 URL 的域名（短链跳转后就是真实站点），拿不到就留空、退回旧结构。
       */
      const pageUrl = shot.finalUrl || url.toString();
      const mediaGroup = config.storage.groupBySite ? siteKeyFromUrl(pageUrl) : '';
      /**
       * 「只下载视频图片」模式：媒体写进独立的目录树（默认与 DATA_DIR 同级），
       * 与主图床、文章完全分开。
       */
      const targetStore = options.mediaOnly ? await mediaOnlyStore() : mediaStore;
      // folder 布局的文件夹名：标题 slug（同名文章自动加 -2）
      const mediaFolder =
        mediaLayout === 'folder'
          ? targetStore.allocateFolder(slugify(titleForId, { maxLength: 48, fallback: 'media' }), earlyId, mediaGroup)
          : '';

      const mediaReport = await localizeMedia({
        document: root,
        pageUrl,
        store: targetStore,
        capture: shot.capture,
        observed: shot.observed,
        layout: mediaLayout,
        group: mediaGroup,
        folder: mediaFolder,
        articleId: earlyId,
        mode: options.imageMode,
        includeImages: options.includeImages,
        includeVideos: options.includeVideos,
        includeAudio: options.includeAudio,
        maxFiles: options.maxMediaFiles,
        maxFileBytes: options.maxFileBytes,
        maxVideoBytes: options.maxVideoBytes,
        maxAudioBytes: options.maxAudioBytes,
        maxBytes: options.maxBytesPerPage,
        maxVideoBytesPerPage: options.maxVideoBytesPerPage,
        cookie: shot.cookies || '',
        referer: shot.finalUrl || url.toString(),
        onError: options.onMediaError,
      });

      // 补进来的媒体可能来自同一份内容的不同 CDN 地址（内容寻址后指向同一个本地文件），
      // 本地化完成后按最终本地地址去重，避免正文里出现两条一模一样的链接。
      for (const section of [...root.querySelectorAll('section[data-wc-embedded]')]) {
        const seen = new Set();
        for (const node of [...section.querySelectorAll('img, video, audio')]) {
          const src = node.getAttribute('src') || '';
          if (!src) continue;
          if (seen.has(src)) {
            (node.closest('p') || node).remove();
            continue;
          }
          seen.add(src);
        }
        if (!section.querySelector('img, video, audio')) section.remove();
      }

      const contentHtml = root.innerHTML;
      const title = pickTitle(extracted.article.title, siteInfo.title, shot.pageTitle, url.hostname);
      const text = extracted.article.textContent || '';

      if (text.replace(/\s+/g, '').length < 40 && !introFromSite) {
        warnings.push('正文内容极少，可能是纯前端渲染页面、需要登录或被反爬拦截（可尝试 engine=browser / waitSelector / scroll）');
      }
      if (embeddedUsed.length) {
        warnings.push(
          `有 ${embeddedUsed.length} 个媒体只存在于页面数据（<script> 内嵌 JSON）里、DOM 中没渲染出来，已补到正文末尾的「${options.embeddedMediaHeading}」小节`,
        );
      }
      if (mediaReport.stats.failed) {
        warnings.push(`${mediaReport.stats.failed} 个媒体文件下载失败，已保留原始外链`);
      }
      const tooLarge = mediaReport.failures.filter((f) => f.reason === 'too_large');
      if (tooLarge.length) {
        warnings.push(
          `${tooLarge.length} 个文件超过大小上限被跳过（图片默认 25MiB / 视频 256MiB），` +
            '可调大 MAX_MEDIA_FILE_BYTES / MAX_VIDEO_BYTES 后重试',
        );
      }
      // 编码提示：H.265/AV1 在部分播放器上只有声音（只提示，不改选择）
      for (const item of mediaReport.codecWarnings || []) warnings.push(item.message);

      const id = earlyId;

      /**
       * 文章来源地址：自建解析器给了规范作品地址就用它；否则遇到登录页/跳转页时退回用户给的原始链接
       * （小红书未登录时短链会一路跳到 /login?redirectPath=…，记这个地址既难看又对不上原文）。
       */
      const sourceUrl =
        siteInfo.noteUrl ||
        (isLoginWallUrl(shot.finalUrl) ? url.toString() : shot.finalUrl || url.toString());

      const frontmatter = options.frontmatter
        ? {
            title,
            source: sourceUrl,
            author: extracted.article.byline || siteInfo.author || '',
            site: extracted.article.siteName || siteKeyFromUrl(sourceUrl) || url.hostname,
            published: extracted.metadata.published || '',
            clipped: createdAt,
            engine: options.engine,
            images: mediaReport.media.length,
          }
        : null;

      let markdown = htmlToMarkdown(contentHtml, {
        title,
        frontmatter,
        includeTitle: options.includeTitle,
        videoMarkdown: options.videoMarkdown,
      });

      if (options.includeMetaSection && mediaReport.media.length) {
        const lines = mediaReport.media.map((m) => `- ${m.localUrl || m.sourceUrl}`);
        markdown += `\n## 本地图床资源（${mediaReport.media.length}）\n\n${lines.join('\n')}\n`;
      }

      const meta = {
        id,
        url: url.toString(),
        finalUrl: shot.finalUrl || url.toString(),
        title,
        // 作者：页面里没写（小红书未登录时就是这样）就用站点适配器/自建解析器给的昵称
        author: extracted.article.byline || siteInfo.author || '',
        siteName: extracted.article.siteName || '',
        published: extracted.metadata.published || '',
        modified: extracted.metadata.modified || '',
        lang: extracted.article.lang || '',
        excerpt: extracted.article.excerpt || '',
        canonical: extracted.metadata.canonical || '',
        coverImage: extracted.metadata.image || '',
        createdAt,
        engine: options.engine,
        options: {
          imageMode: options.imageMode,
          includeImages: options.includeImages,
          includeVideos: options.includeVideos,
          includeAudio: options.includeAudio,
          filterAds: options.filterAds,
          scroll: options.scroll,
          waitSelector: options.waitSelector,
        },
        stats: {
          words: countWords(text),
          chars: text.length,
          markdownChars: markdown.length,
          media: mediaReport.stats,
          adsBlocked: options.engine === 'browser' ? shot.stats?.blocked || 0 : 0,
          imagesCaptured: options.engine === 'browser' ? shot.stats?.captured || 0 : 0,
          mediaObserved: options.engine === 'browser' ? shot.stats?.observedMedia || 0 : 0,
          lazyFixed: shot.lazyFixed || 0,
          bgImagesConverted: shot.bgConverted || 0,
          playerChromeRemoved: shot.playerChromeRemoved || 0,
          embeddedMedia: { found: embedded.length, used: embeddedUsed.length },
          observedMedia: { used: observedUsed.length },
          extract: extracted.stats,
          elapsedMs: Date.now() - started,
        },
        media: mediaReport.media.map((m) => addLocalPath(targetStore, m)),
        mediaFailures: mediaReport.failures.slice(0, 50),
        // 只下载媒体时告诉调用方文件到底落在哪个目录
        mediaOnly: options.mediaOnly ? { dir: config.mediaOnly.dir, local: !options.store } : null,
        warnings,
      };

      // 下载文件名（保存进 meta，保证之后下载始终一致）
      meta.filename = buildArticleFilename(meta, {
        template: options.filenameTemplate,
        maxLength: config.filenames.maxLength,
        maxBytes: config.filenames.maxBytes,
      });
      // 正文指纹也写进 meta，便于排查"为什么这次没重新下载"
      meta.contentHash = fingerprint.hash;

      let saved = null;
      if (options.store) {
        saved = await articleStore.save({ id, meta, markdown });
        // 正文额外在数据库里存一份（便于检索，也供下次比对）
        articleDb.upsertArticle({
          id,
          url: meta.url,
          finalUrl: meta.finalUrl,
          title,
          markdown,
          contentHash: fingerprint.hash,
          textLength: fingerprint.textLength,
          mediaCount: mediaReport.media.length,
          filename: meta.filename,
          meta,
          createdAt,
        });
        // 图床容量治理
        if (config.storage.pruneOnWrite) {
          const keep = new Set(mediaReport.media.map((m) => m.hash).filter(Boolean));
          mediaStore
            .prune({ keepHashes: keep })
            .catch((err) => log.warn('图床容量治理失败', { err: err.message }));
        }
      }

      // 网址记录：抓取次数 / 正文是否变化（键与查询一致，都用规范化 URL）
      const changed = !knownUrl?.contentHash || knownUrl.contentHash !== fingerprint.hash;
      articleDb.recordFetch({
        url: urlKey,
        articleId: options.store ? id : knownUrl?.articleId || null,
        title,
        contentHash: fingerprint.hash,
        textLength: fingerprint.textLength,
        mediaCount: mediaReport.media.length,
        optionsHash,
        status: 'ok',
        changed,
      });
      if (changed && knownUrl?.articleId && knownUrl.articleId !== id) {
        warnings.push(`该网址之前抓过（文章 ${knownUrl.articleId}），本次正文有变化，已另存为新文章 ${id}`);
      }

      const elapsedMs = Date.now() - started;
      log.info('转换完成', {
        url: meta.finalUrl,
        id,
        words: meta.stats.words,
        media: mediaReport.media.length,
        elapsedMs,
      });

      return {
        id,
        url: meta.url,
        finalUrl: meta.finalUrl,
        title,
        author: meta.author,
        siteName: meta.siteName,
        published: meta.published,
        excerpt: meta.excerpt,
        createdAt,
        engine: options.engine,
        /** 下载时建议使用的文件名（按 FILENAME_TEMPLATE 自动生成） */
        filename: meta.filename,
        markdown: options.keepMarkdownInResponse ? markdown : undefined,
        markdownUrl: saved?.markdownUrl || null,
        downloadUrl: saved?.downloadUrl || null,
        articleApiUrl: saved ? `${config.publicBaseUrl}/api/articles/${encodeURIComponent(id)}` : null,
        media: mediaReport.media.map((m) => addLocalPath(targetStore, m)),
        mediaFailures: mediaReport.failures.slice(0, 50),
        // 只下载媒体时告诉调用方文件到底落在哪个目录
        mediaOnly: options.mediaOnly ? { dir: config.mediaOnly.dir, local: !options.store } : null,
        stats: meta.stats,
        warnings,
      };
    } catch (err) {
      if (err instanceof AppError) throw err;
      if (timer.signal.aborted || /timeout|超时/i.test(err.message || '')) {
        throw timeoutError(`转换超时（>${options.timeoutMs}ms）: ${url.toString()}`, { cause: err.message });
      }
      throw new AppError(`转换失败: ${err.message}`, { status: 500, code: 'convert_failed' });
    } finally {
      timer.clear();
    }
  });
}

export { countWords };
