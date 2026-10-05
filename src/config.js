import 'dotenv/config';
import path from 'node:path';
import os from 'node:os';

function envStr(name, def) {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}

function envBool(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(v).toLowerCase());
}

function envInt(name, def) {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) ? v : def;
}

function envNum(name, def) {
  const v = Number.parseFloat(process.env[name] ?? '');
  return Number.isFinite(v) ? v : def;
}

const DATA_DIR = path.resolve(envStr('DATA_DIR', path.join(process.cwd(), 'data')));
const PORT = envInt('PORT', 3000);

export const config = {
  env: envStr('NODE_ENV', 'development'),
  port: PORT,
  host: envStr('HOST', '0.0.0.0'),

  /**
   * 生成的 Markdown 中，本地图床资源的公开访问前缀。
   * 必须是对 Markdown 阅读者（浏览器/GitHub/笔记软件）可达的地址。
   */
  publicBaseUrl: envStr('PUBLIC_BASE_URL', `http://localhost:${PORT}`).replace(/\/+$/, ''),

  /** 可选：设置后所有 /api/* 接口都需要 Bearer Token。/media/* 始终公开。 */
  apiToken: envStr('API_TOKEN', ''),

  data: {
    dir: DATA_DIR,
    mediaDir: path.join(DATA_DIR, 'media'),
    articlesDir: path.join(DATA_DIR, 'articles'),
    tmpDir: path.join(DATA_DIR, 'tmp'),
  },

  storage: {
    /**
     * 媒体目录布局：
     *   folder（默认）DATA_DIR/media/<标题 slug>/01.jpg、02.png、03.mp4 …
     *                 同一篇的媒体放一起，按正文出现顺序编号
     *   flat          DATA_DIR/media/<内容哈希>.<ext>（内容寻址，跨文章共用、最省磁盘）
     */
    layout: (() => {
      const value = String(envStr('MEDIA_LAYOUT', 'folder')).toLowerCase();
      return ['folder', 'flat'].includes(value) ? value : 'folder';
    })(),
    /**
     * 媒体再按网站分一层目录（默认开）：
     *   DATA_DIR/media/<站点域名>/<标题 slug>/01.jpg
     *   DATA_DIR/media/<站点域名>/<内容哈希>.ext
     * 关掉就退回旧的扁平结构（media/<标题 slug>/… 或 media/<哈希>.ext）。
     * 老文章不受影响：每条记录都存着自己的相对路径，改写后依然按原路径读取。
     */
    groupBySite: envBool('MEDIA_GROUP_BY_SITE', true),
    /** 单个图片文件最大体积（超过则跳过下载，保留原始外链） */
    maxFileBytes: envInt('MAX_MEDIA_FILE_BYTES', 25 * 1024 * 1024),
    /** 单个视频文件上限：视频动辄几十上百 MB，默认给到 256MiB */
    maxVideoBytes: envInt('MAX_VIDEO_BYTES', 256 * 1024 * 1024),
    /** 单个音频文件上限 */
    maxAudioBytes: envInt('MAX_AUDIO_BYTES', 64 * 1024 * 1024),
    /** 单个页面最多保存多少个媒体文件 */
    maxFilesPerPage: envInt('MAX_MEDIA_FILES_PER_PAGE', 80),
    /** 单个页面图片+音频总字节上限 */
    maxBytesPerPage: envInt('MAX_MEDIA_BYTES_PER_PAGE', 80 * 1024 * 1024),
    /** 单个页面视频总字节上限 */
    maxVideoBytesPerPage: envInt('MAX_VIDEO_BYTES_PER_PAGE', 512 * 1024 * 1024),
    /** 图床总容量上限，超出后按时间从旧到新淘汰 */
    maxTotalBytes: envInt('MAX_MEDIA_TOTAL_BYTES', 5 * 1024 * 1024 * 1024),
    /** 是否清理被淘汰/失联的记录 */
    pruneOnWrite: envBool('MEDIA_PRUNE_ON_WRITE', true),
  },

  /** 网址记录 + 正文副本（SQLite，用 Node 内置 node:sqlite） */
  database: {
    enabled: envBool('DATABASE_ENABLED', true),
    file: path.resolve(envStr('DATABASE_FILE', path.join(DATA_DIR, 'webclip.db'))),
    /** 重新抓取同一网址时，正文字节指纹一致就复用已有文章、不再下载媒体 */
    skipUnchanged: envBool('SKIP_UNCHANGED_REFRESH', true),
  },

  /** Markdown 输出细节 */
  markdown: {
    /**
     * 视频/音频在 Markdown 里的表示：
     *   html（默认）<video src="…" controls></video> —— 支持 HTML 的阅读器可直接播放
     *   link        [▶ 视频](…) —— 兼容不支持 HTML 的渲染器
     *   both        两者都给
     */
    video: envStr('VIDEO_MARKDOWN', 'html'),
  },

  /** 下载文件自动命名 */
  filenames: {
    /**
     * 模板占位符：{date} {clipdate} {time} {datetime} {title} {site} {host}
     *            {author} {id} {words} {lang}
     * 默认带日期，便于归档排序且不会重名；想回到"只用标题"就设成 {title}
     */
    template: envStr('FILENAME_TEMPLATE', '{date}-{title}'),
    maxLength: envInt('FILENAME_MAX_LENGTH', 100),
    /** 文件名字节上限：ext4/NTFS 单个文件名最多 255 字节，中文一个字 3 字节 */
    maxBytes: envInt('FILENAME_MAX_BYTES', 200),
  },

  /**
   * 站点 Cookie：需要登录才能看的站点（抖音、小红书…）把浏览器里的 Cookie 字符串配在这里，
   * 抓取对应站点时自动带上；单次请求里的 cookies 参数优先级更高，会覆盖这里的配置。
   * 站点 Cookie 也会随媒体下载请求一起发出去（抖音/小红书的 CDN 都是它们自家域名）。
   */
  cookies: {
    douyin: envStr('DOUYIN_COOKIE', ''),
    xiaohongshu: envStr('XIAOHONGSHU_COOKIE', ''),
    /**
     * 其它站点：JSON，值是 Cookie 字符串。键写域名（example.com 或 .example.com 都行）。
     * 例：SITE_COOKIES={"zhihu.com":"z_c0=xxx","bilibili.com":"SESSDATA=xxx"}
     */
    sites: (() => {
      const raw = envStr('SITE_COOKIES', '').trim();
      if (!raw) return {};
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        console.warn('[config] SITE_COOKIES 需要是 JSON 对象，已忽略');
      } catch (err) {
        console.warn(`[config] SITE_COOKIES 不是合法 JSON，已忽略：${err.message}`);
      }
      return {};
    })(),
  },

  /**
   * 「只下载视频图片」模式（API 参数 mediaOnly=1）的文件根目录。
   * 默认放在 DATA_DIR **同级**的大文件夹里（例如 /data → /media-only），
   * 这样素材与文章、图床索引分开放，方便单独挂载/同步/清理。
   */
  mediaOnly: {
    dir: path.resolve(envStr('MEDIA_ONLY_DIR', path.join(path.dirname(DATA_DIR), 'media-only'))),
  },

  /**
   * webhook 通知：抓取完成后 POST 一条消息出去。
   * 各平台报文格式不同，用 WEBHOOK_FORMAT 选：
   *   json（默认，完整 JSON，含 text 摘要）/ text / slack / feishu / dingtalk / wecom
   */
  webhook: {
    url: envStr('WEBHOOK_URL', ''),
    format: (() => {
      const value = String(envStr('WEBHOOK_FORMAT', 'json')).toLowerCase();
      return ['json', 'text', 'slack', 'synology', 'feishu', 'dingtalk', 'wecom'].includes(value) ? value : 'json';
    })(),
    /** 附加请求头（JSON），例如 {"Authorization":"Bearer xxx"} */
    headers: (() => {
      const raw = envStr('WEBHOOK_HEADERS', '').trim();
      if (!raw) return {};
      try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } catch (err) {
        console.warn(`[config] WEBHOOK_HEADERS 不是合法 JSON，已忽略：${err.message}`);
        return {};
      }
    })(),
    timeoutMs: envInt('WEBHOOK_TIMEOUT_MS', 10000),
    /** 消息超过平台上限时自动分条，这是每条之间的间隔（群晖有限流 create post too fast） */
    partDelayMs: envInt('WEBHOOK_PART_DELAY_MS', 1500),
    /** 手动覆盖单条消息的字数上限（0 = 用各平台的默认上限，群晖约 2000 字） */
    maxChars: envInt('WEBHOOK_MAX_CHARS', 0),
    /**
     * 是否校验 webhook 地址的 TLS 证书。群晖/NAS 常用自签名证书，
     * 这时设成 false 才能发出去（只影响 webhook 这一个请求，不影响抓取）。
     */
    tlsVerify: envBool('WEBHOOK_TLS_VERIFY', true),
  },

  /**
   * 小红书解析 API 地址（可选）：如自建 XHS-Downloader 服务，填这里即可自动切换。
   * 示例：http://xhs-parser.example.com:5556/xhs/detail
   * 留空则使用内置网页抓取逻辑。
   */
  xiaohongshuApi: envStr('XIAOHONGSHU_API', ''),
  /** 自建解析器单次请求超时（解析视频笔记偏慢，默认 30s） */
  xiaohongshuApiTimeoutMs: envInt('XIAOHONGSHU_API_TIMEOUT_MS', 30_000),
  /**
   * 配了解析器时，小红书是否「只用解析器、完全不抓网页」（默认开）。
   * 网页端未登录/被风控只会返回「安全限制」这类页面，抓它没意义还容易招验证；
   * 想保留"先抓网页、解析器只当兜底"的老行为就设 false。
   */
  xhsParserOnly: envBool('XIAOHONGSHU_PARSER_ONLY', true),

  /**
   * HTTP 抓取配置（fetch 引擎用）
   */
  fetch: {
    timeoutMs: envInt('FETCH_TIMEOUT_MS', 20_000),
    maxRedirects: envInt('FETCH_MAX_REDIRECTS', 5),
    userAgent: envStr(
      'USER_AGENT',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    ),
  },

  browser: {
    /** 'chromium' | 'chrome' | 'msedge' 或 chrome 可执行文件绝对路径 */
    channel: envStr('BROWSER_CHANNEL', ''),
    /**
     * 浏览器上下文的 UA：留空（默认）= 用浏览器自己的真实 UA。
     * 别乱设成和真实浏览器不符的值（例如在 Linux 容器里设 Windows UA），
     * 抖音这类站点的风控会因为身份矛盾直接返回空数据。
     */
    userAgent: envStr('BROWSER_USER_AGENT', ''),
    executablePath: envStr('BROWSER_EXECUTABLE_PATH', ''),
    headless: envBool('BROWSER_HEADLESS', true),
    /** 容器内通常需要 --no-sandbox（见 README 安全说明） */
    noSandbox: envBool('CHROMIUM_NO_SANDBOX', false),
    /** 空闲多少毫秒后关闭浏览器，节省内存 */
    idleCloseMs: envInt('BROWSER_IDLE_CLOSE_MS', 5 * 60_000),
    maxContexts: envInt('BROWSER_MAX_CONTEXTS', 4),
    launchTimeoutMs: envInt('BROWSER_LAUNCH_TIMEOUT_MS', 60_000),
    navigationTimeoutMs: envInt('NAVIGATION_TIMEOUT_MS', 45_000),
    /** 页面加载后额外静置时间，等待前端渲染 */
    settleMs: envInt('PAGE_SETTLE_MS', 800),
    /**
     * 触发播放器后等待多久再收网（毫秒）。
     * MSE 播放器（抖音等）的视频/音频流只有开始播放才会发请求，这段时间用来等它们出现。
     */
    playNudgeMs: envInt('PAGE_PLAY_NUDGE_MS', 4000),
    /** 是否自动滚动以触发懒加载 */
    scroll: envBool('PAGE_AUTO_SCROLL', true),
    scrollSteps: envInt('PAGE_SCROLL_STEPS', 12),
    /** 附加的启动参数 */
    extraArgs: envStr('BROWSER_EXTRA_ARGS', '')
      .split(/\s+/)
      .filter(Boolean),
  },

  /**
   * 媒体处理（DASH 分离音视频的合流需要 ffmpeg）。
   * 留空时自动找：PATH 上的 ffmpeg → Playwright 自带的 ffmpeg。
   */
  media: {
    ffmpegPath: envStr('FFMPEG_PATH', ''),
  },

  convert: {
    /** 同时处理的抓取任务上限 */
    concurrency: envInt('CONVERT_CONCURRENCY', 3),
    /** 单次转换的总超时 */
    jobTimeoutMs: envInt('CONVERT_JOB_TIMEOUT_MS', 120_000),
    /** 批量接口单次最多 URL 数 */
    maxBatchSize: envInt('CONVERT_MAX_BATCH', 10),
    /** 速率限制：每 IP 每分钟请求数（0 = 关闭） */
    rateLimitPerMinute: envInt('RATE_LIMIT_PER_MINUTE', 0),
  },

  security: {
    /** 允许抓取内网/回环地址（默认禁止，防 SSRF） */
    allowPrivateNetwork: envBool('ALLOW_PRIVATE_NETWORK', false),
    /** 允许抓取的非 http(s) 协议（默认仅 http/https） */
    allowFileProtocol: envBool('ALLOW_FILE_PROTOCOL', false),
  },

  logging: {
    level: envStr('LOG_LEVEL', 'info'),
  },

  /** 供日志/接口返回的版本信息 */
  version: '1.0.0',
  platform: `${os.platform()}/${os.arch()}`,
};

export function ensureConfig() {
  if (config.publicBaseUrl.includes('localhost') && config.env === 'production') {
    // 仅提示，不阻断：生产环境必须显式设置，否则 Markdown 里的图片链接在别的机器上打不开
    // eslint-disable-next-line no-console
    console.warn(
      '[config] PUBLIC_BASE_URL 仍为 localhost，生成 Markdown 中的图片链接在其它设备上可能无法访问。',
    );
  }
}
