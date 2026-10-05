import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { config, ensureConfig } from './config.js';
import { logger } from './utils/logger.js';
import { buildInfo } from './utils/build-info.js';
import { AppError, describeError, unauthorized } from './utils/errors.js';
import { mediaStore } from './storage/media.js';
import { articleStore } from './storage/articles.js';
import { articleDb } from './storage/db.js';
import { browserPool } from './browser/pool.js';
import { apiRouter } from './routes/api.js';

const log = logger.child({ mod: 'server' });
const startedAt = Date.now();

/* ------------------------------------------------------------------ *
 * 鉴权（可选）
 * ------------------------------------------------------------------ */

function tokenMatches(provided) {
  if (!config.apiToken) return true;
  if (!provided) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(config.apiToken);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function authMiddleware(req, res, next) {
  if (!config.apiToken) return next();
  if (req.method === 'OPTIONS') return next();
  const header = req.headers.authorization || '';
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  const provided = bearer || req.headers['x-api-token'] || req.query.token;
  if (!tokenMatches(provided)) return next(unauthorized());
  return next();
}

/* ------------------------------------------------------------------ *
 * 简单速率限制（每 IP 每分钟）
 * ------------------------------------------------------------------ */

const buckets = new Map();

function rateLimitMiddleware(req, res, next) {
  const limit = config.convert.rateLimitPerMinute;
  if (!limit || limit <= 0) return next();
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + 60_000 });
    return next();
  }
  bucket.count += 1;
  res.setHeader('X-RateLimit-Limit', String(limit));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - bucket.count)));
  if (bucket.count > limit) {
    res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
    return next(new AppError('请求过于频繁，请稍后再试', { status: 429, code: 'rate_limited' }));
  }
  if (buckets.size > 10_000) buckets.clear();
  return next();
}

/* ------------------------------------------------------------------ *
 * 应用装配
 * ------------------------------------------------------------------ */

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false, limit: '256kb' }));

  app.use((req, res, next) => {
    const begin = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - begin;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'debug';
      log[level](`${req.method} ${req.originalUrl} → ${res.statusCode}`, { ms });
    });
    next();
  });

  // 图床静态资源：公开可读，长缓存，允许跨域引用
  const mediaStaticOptions = {
    index: false,
    dotfiles: 'deny',
    maxAge: '365d',
    immutable: true,
    fallthrough: false,
    setHeaders(res) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    },
  };
  app.use('/media', express.static(config.data.mediaDir, mediaStaticOptions));

  /**
   * 「只下载视频图片」模式的素材目录（默认与 DATA_DIR 同级的大文件夹）。
   * 单独挂一条路由，和主图床互不影响；目录不存在时自动建，免得静态服务报错。
   */
  try {
    fs.mkdirSync(config.mediaOnly.dir, { recursive: true });
  } catch {
    /* 建不出来就让静态中间件自己报错，别把服务拦在启动阶段 */
  }
  app.use('/media-only', express.static(config.mediaOnly.dir, mediaStaticOptions));

  app.get('/healthz', (req, res) => {
    res.json({
      status: 'ok',
      version: config.version,
      /** 这一版是哪来的：镜像构建时间（image）还是本地源码最新修改时间（source）——
       *  排查"改了代码却忘了重建镜像"时一眼就能看出来 */
      build: buildInfo(),
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      browser: browserPool.status,
      mediaDir: config.data.mediaDir,
      mediaOnlyDir: config.mediaOnly.dir,
      webhook: config.webhook.url ? { configured: true, format: config.webhook.format } : { configured: false },
      /** 小红书自建解析器（XHS-Downloader 之类）是否已配置：配了就不用页面登录态也能抓小红书 */
      xiaohongshuApi: config.xiaohongshuApi ? { configured: true } : { configured: false },
      database: { available: articleDb.available, file: articleDb.file },
    });
  });

  app.use('/api', authMiddleware, rateLimitMiddleware, apiRouter);

  app.use(
    express.static(path.join(process.cwd(), 'public'), {
      index: 'index.html',
      maxAge: '5m',
      setHeaders(res) {
        res.setHeader('Cache-Control', 'no-cache');
      },
    }),
  );

  app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) {
      return next(new AppError(`接口不存在: ${req.method} ${req.path}`, { status: 404, code: 'not_found' }));
    }
    return res
      .status(404)
      .type('text/plain')
      .send('404 Not Found\n\n可用入口：GET / · GET /healthz · POST /api/convert\n');
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    const info = describeError(err);
    if (status >= 500) log.error('请求处理失败', { path: req.originalUrl, ...info });
    else log.warn('请求被拒绝', { path: req.originalUrl, ...info });

    if (res.headersSent) return;
    res.status(status).json({
      ok: false,
      error: { code: info.code || 'error', message: info.message, ...(info.details ? { details: info.details } : {}) },
    });
  });

  return app;
}

export async function start() {
  ensureConfig();
  try {
    await mediaStore.init();
    await articleStore.init();
    await articleDb.ready();
  } catch (err) {
    if (['EACCES', 'EPERM', 'EROFS'].includes(err.code)) {
      const dir = config.data.dir;
      log.error(
        [
          `数据目录不可写（${err.code}）：${dir}`,
          '常见原因：把宿主机目录挂到了 /data，但该目录属主与容器内运行用户不一致。',
          '解决办法（任选其一）：',
          `  1) 指定 PUID/PGID 为宿主机目录属主：先执行 ls -nd ${dir} 查看，再设 PUID=<uid> PGID=<gid>（群晖常见 1026:100）`,
          `  2) 在宿主机改属主：sudo chown -R 1000:1000 ${dir}`,
          '  3) 兜底：设置 RUN_AS_ROOT=true 以 root 运行容器',
          '  4) 或改用命名卷（不映射宿主机目录）：docker volume，无需处理权限',
        ].join('\n'),
      );
    }
    throw err;
  }

  const app = createApp();
  const server = app.listen(config.port, config.host, () => {
    log.info(`WebClip 已启动 http://${config.host}:${config.port}`, {
      env: config.env,
      dataDir: config.data.dir,
      publicBaseUrl: config.publicBaseUrl,
      auth: config.apiToken ? 'api-token' : 'none',
      concurrency: config.convert.concurrency,
    });
  });

  // 预热浏览器（可用 BROWSER_WARMUP=0 关闭）
  if (process.env.BROWSER_WARMUP !== '0') {
    browserPool
      .browser()
      .then(() => log.info('浏览器预热完成'))
      .catch((err) => log.warn('浏览器预热失败，将在首次请求时重试', { err: err.message }));
  }

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`收到 ${signal}，正在关闭…`);
    server.close();
    await Promise.allSettled([browserPool.close(), mediaStore.flush()]);
    articleDb.close();
    log.info('已安全退出');
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    log.error('未处理的 Promise 拒绝', { reason: reason instanceof Error ? reason.message : String(reason) });
  });
  process.on('uncaughtException', (err) => {
    log.error('未捕获异常', { err: err.message, stack: err.stack?.split('\n').slice(0, 3).join(' | ') });
  });

  return server;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  start().catch((err) => {
    log.error('启动失败', { err: err.message, stack: err.stack });
    process.exit(1);
  });
}
