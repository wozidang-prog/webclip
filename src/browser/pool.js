import { chromium } from 'playwright';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { canonicalizeUrl } from '../utils/text.js';
import { isBlockedUrl } from '../adblock/rules.js';
import { isUrlObviouslyBlocked } from '../utils/net.js';
import { upstream } from '../utils/errors.js';

const log = logger.child({ mod: 'browser' });

const CAPTURABLE_MIME = /^image\//i;
const MEDIA_MIME = /^(video|audio)\//i;
const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|avif|bmp|svg|ico|tiff?)(\?|#|$)/i;
const MEDIA_URL_RE = /\.(mp4|m4v|webm|mov|mkv|mp3|m4a|aac|ogg|oga|flac|opus|m3u8|mpd)(\?|#|$)/i;
/** 没有扩展名但明显是音视频的地址（字节跳动 CDN 就是这样：/video/tos/...?mime_type=video_mp4） */
const MEDIA_URL_HINT_RE = /(mime_type=(video|audio)|video\/tos|toutiaovod|m3u8|\.mpd(\?|#|$))/i;

function looksLikeImageRequest(url) {
  try {
    return IMAGE_EXT_RE.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function looksLikeMediaUrl(url) {
  return MEDIA_URL_RE.test(url) || MEDIA_URL_HINT_RE.test(url);
}

function mediaKindFromUrl(url) {
  if (MEDIA_URL_RE.test(url) && /\.(mp3|m4a|aac|ogg|oga|flac|opus)(\?|#|$)/i.test(url)) return 'audio';
  return /mime_type=audio/i.test(url) ? 'audio' : 'video';
}

/**
 * 无头浏览器池：单进程内复用 1 个 Chromium 实例，按任务开独立 BrowserContext。
 * 同时承担三件事：广告/追踪拦截、图片字节捕获（避免二次下载）、懒加载修复。
 */
export class BrowserPool {
  constructor() {
    this._browser = null;
    this._launching = null;
    this._idleTimer = null;
    this._active = 0;
    /** 仅在服务真正停止时为 true；空闲回收**不能**动它，否则浏览器再也起不来 */
    this._shutdown = false;
    /** 空闲多久回收浏览器，0/负数 = 不回收（可由测试或运行时调整） */
    this.idleCloseMs = config.browser.idleCloseMs;
  }

  async browser() {
    if (this._shutdown) throw upstream('浏览器已关闭（服务正在停止）');
    if (this._browser && this._browser.isConnected()) return this._browser;
    if (this._launching) return this._launching;

    const args = [
      '--disable-dev-shm-usage',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints',
      '--hide-scrollbars',
      '--mute-audio',
      '--no-first-run',
      '--no-default-browser-check',
      ...config.browser.extraArgs,
    ];
    if (config.browser.noSandbox) args.push('--no-sandbox', '--disable-setuid-sandbox');

    const launchOptions = {
      headless: config.browser.headless,
      args,
      timeout: config.browser.launchTimeoutMs,
    };
    /**
     * 默认走 Playwright 自带 Chromium。它可能没装（`npx playwright install chromium` 没跑过，
     * 或者装的版本和当前 playwright 不匹配）—— 这时不要直接失败：
     * 依次退回本机的 Chrome / Edge（Playwright 的 channel），绝大多数桌面环境都有。
     * 抖音、小红书这类站点只能靠浏览器引擎，退回失败等于"什么都抓不到"。
     */
    const attempts = [];
    if (config.browser.executablePath) attempts.push({ executablePath: config.browser.executablePath, label: config.browser.executablePath });
    else if (config.browser.channel) attempts.push({ channel: config.browser.channel, label: `channel:${config.browser.channel}` });
    else {
      attempts.push({ label: 'bundled-chromium' });
      attempts.push({ channel: 'chrome', label: 'channel:chrome' });
      attempts.push({ channel: 'msedge', label: 'channel:msedge' });
    }

    this._launching = (async () => {
      const errors = [];
      for (const attempt of attempts) {
        const options = { ...launchOptions };
        if (attempt.channel) options.channel = attempt.channel;
        if (attempt.executablePath) options.executablePath = attempt.executablePath;
        try {
          const browser = await chromium.launch(options);
          browser.on('disconnected', () => {
            log.warn('Chromium 已断开');
            this._browser = null;
          });
          this._browser = browser;
          if (attempt.label !== attempts[0].label) {
            log.warn('自带 Chromium 不可用，已退回本机浏览器', { used: attempt.label, reason: errors[0] });
          }
          log.info('Chromium 已启动', {
            headless: config.browser.headless,
            source: attempt.label,
            version: browser.version?.(),
          });
          return browser;
        } catch (err) {
          errors.push(`${attempt.label}: ${err.message.split('\n')[0]}`);
          log.warn('浏览器启动失败，尝试下一个', { attempt: attempt.label, err: err.message.split('\n')[0] });
        }
      }
      throw upstream(`启动 Chromium 失败: ${errors.join(' | ')}`, {
        hint:
          '本机没有可用的浏览器：跑一次 npx playwright install chromium，' +
          '或设置 BROWSER_CHANNEL=chrome / BROWSER_EXECUTABLE_PATH 指向已安装的 Chrome/Edge；' +
          '容器内通常还需要 CHROMIUM_NO_SANDBOX=true',
      });
    })()
      .catch((err) => {
        this._launching = null;
        throw err;
      })
      .finally(() => {
        this._launching = null;
      });

    return this._launching;
  }

  _scheduleIdleClose() {
    if (this._idleTimer) clearTimeout(this._idleTimer);
    if (!this.idleCloseMs || this.idleCloseMs <= 0) return;
    this._idleTimer = setTimeout(() => {
      if (this._active > 0) {
        // 期间又来了任务，重新计时
        this._scheduleIdleClose();
        return;
      }
      this._closeIdleBrowser().catch(() => {});
    }, this.idleCloseMs);
    this._idleTimer.unref?.();
  }

  /**
   * 空闲回收：只关掉浏览器实例，**不**把池标记为已关闭。
   * 下一个请求会通过 browser() 自动重新拉起（这是之前 NAS 上"空闲后无法启动"的根因）。
   */
  async _closeIdleBrowser() {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
    const browser = this._browser;
    this._browser = null;
    this._launching = null;
    if (!browser) return;
    log.info('浏览器空闲，关闭以释放内存（下次请求会自动重启）');
    await browser.close().catch((err) => log.debug('关闭浏览器时出错（忽略）', { err: err.message }));
  }

  /**
   * 打开一个页面执行 fn(page, ctx)，结束后无论成败都会清理 context。
   */
  async withPage(handler, options = {}) {
    const {
      capture = null,
      observed = null,
      cookies = null,
      /**
       * 上下文 UA：默认**不覆盖**，用浏览器自己的真实 UA。
       *
       * 这一点很关键：把「Windows + Chrome/131」这种 UA 强加给容器里「Linux + Chrome 153」
       * 的浏览器，身份自相矛盾，抖音这类站点的风控会直接返回空数据
       * （实测同一容器：UA 不匹配 → 页面标题变成 www.douyin.com、零视频；
       *   改成与浏览器一致的 UA → 立刻抓到 45MB 带声音的视频）。
       * 确实需要指定 UA 时用 BROWSER_USER_AGENT，并保证它与真实浏览器相符。
       */
      userAgent = config.browser.userAgent,
      viewport = { width: 1440, height: 900 },
      blockFonts = false,
      blockMedia = false,
      extraHeaders = {},
      captureLimit = config.storage.maxFilesPerPage,
      captureMaxBytes = config.storage.maxFileBytes,
      onStats = () => {},
    } = options;

    const browser = await this.browser();
    const context = await browser.newContext({
      // userAgent 留空时不传：用浏览器自己的 UA（见上面 withPage 的说明）
      ...(userAgent ? { userAgent } : {}),
      viewport,
      deviceScaleFactor: 1,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      javaScriptEnabled: true,
      ignoreHTTPSErrors: true,
      bypassCSP: true,
      extraHTTPHeaders: extraHeaders,
      serviceWorkers: 'block',
    });
    const stats = { blocked: 0, captured: 0, captureBytes: 0, skippedLarge: 0, observedMedia: 0 };

    if (cookies && Array.isArray(cookies) && cookies.length) {
      await context.addCookies(cookies).catch(() => {});
    }
    if (cookies && typeof cookies === 'string' && cookies.trim()) {
      await context.setExtraHTTPHeaders({ ...extraHeaders, cookie: cookies.trim() }).catch(() => {});
    }

    this._active += 1;
    if (this._idleTimer) clearTimeout(this._idleTimer);

    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = request.url();
      const resourceType = request.resourceType();

      if (isUrlObviouslyBlocked(url)) {
        stats.blocked += 1;
        return route.abort('blockedbyclient').catch(() => {});
      }
      if (isBlockedUrl(url, { resourceType })) {
        stats.blocked += 1;
        return route.abort('blockedbyclient').catch(() => {});
      }
      if (blockFonts && resourceType === 'font') {
        stats.blocked += 1;
        return route.abort('blockedbyclient').catch(() => {});
      }
      if (blockMedia && resourceType === 'media') {
        stats.blocked += 1;
        return route.abort('blockedbyclient').catch(() => {});
      }

      // 只记录地址、不下字节：给"播放器没把地址写进 <video src>"的情况兜底。
      // 除了 media 资源，也要看 xhr/fetch —— MSE 播放器常常用 fetch 拿 mp4。
      if (
        observed &&
        observed.size < 40 &&
        ['media', 'xhr', 'fetch', 'other'].includes(resourceType) &&
        looksLikeMediaUrl(url)
      ) {
        const key = canonicalizeUrl(url);
        if (!observed.has(key)) {
          observed.set(key, {
            url,
            kind: mediaKindFromUrl(url),
            resourceType,
            mime: '',
          });
          stats.observedMedia += 1;
        }
      }

      const wantsCapture =
        capture &&
        capture.size < captureLimit &&
        (resourceType === 'image' ||
          ((resourceType === 'fetch' || resourceType === 'xhr') && looksLikeImageRequest(url)));

      if (wantsCapture) {
        try {
          const response = await route.fetch({ timeout: config.fetch.timeoutMs });
          const headers = response.headers();
          const mime = headers['content-type'] || '';
          const declared = Number.parseInt(headers['content-length'] || '0', 10);
          if (
            CAPTURABLE_MIME.test(mime) &&
            (!declared || declared <= captureMaxBytes) &&
            response.status() >= 200 &&
            response.status() < 300
          ) {
            const body = await response.body();
            if (body && body.length > 0 && body.length <= captureMaxBytes && stats.captureBytes + body.length <= config.storage.maxBytesPerPage) {
              const key = canonicalizeUrl(url);
              if (!capture.has(key)) {
                capture.set(key, { buffer: body, mime, sourceUrl: url, fromNetwork: true });
                stats.captured += 1;
                stats.captureBytes += body.length;
              }
            } else if (body && body.length > captureMaxBytes) {
              stats.skippedLarge += 1;
            }
          }
          return await route.fulfill({ response });
        } catch (err) {
          log.debug('捕获资源失败，回退为直接放行', { url, err: err.message });
          try {
            return await route.continue();
          } catch {
            return undefined;
          }
        }
      }

      return route.continue().catch(() => {});
    });

    const page = await context.newPage();
    page.setDefaultTimeout(config.browser.navigationTimeoutMs);
    page.setDefaultNavigationTimeout(config.browser.navigationTimeoutMs);

    try {
      return await handler(page, context);
    } finally {
      onStats(stats);
      await context.close().catch(() => {});
      this._active -= 1;
      this._scheduleIdleClose();
    }
  }

  /** 服务停止时调用：此后不再允许重启浏览器 */
  async shutdown() {
    this._shutdown = true;
    await this._closeIdleBrowser();
  }

  /** 兼容旧调用名 */
  async close() {
    return this.shutdown();
  }

  get status() {
    return {
      connected: Boolean(this._browser?.isConnected()),
      activeContexts: this._active,
      idleCloseMs: this.idleCloseMs,
      shuttingDown: this._shutdown,
      executablePath: config.browser.executablePath || config.browser.channel || 'bundled-chromium',
    };
  }
}

export const browserPool = new BrowserPool();
