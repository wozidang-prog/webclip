import { Router } from 'express';
import { config } from '../config.js';
import { convertUrl } from '../pipeline/convert.js';
import { mediaStore } from '../storage/media.js';
import { articleStore } from '../storage/articles.js';
import { articleDb } from '../storage/db.js';
import { badRequest, notFound } from '../utils/errors.js';
import { deleteArticle, deleteArticles, deleteMedia, gcOrphanMedia } from '../storage/maintenance.js';
import { rulesSummary } from '../adblock/rules.js';
import { mapLimit } from '../utils/pool.js';
import {
  safeFilename,
  contentDisposition,
  buildArticleFilename,
  asciiFallbackName,
} from '../utils/filename.js';
import { canonicalizeUrl, shortHash } from '../utils/text.js';
import { sendWebhookTest } from '../utils/webhook.js';
import { logger } from '../utils/logger.js';

const log = logger.child({ mod: 'api' });

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** 宽松布尔解析：?force=1 / true / yes / on 都算真 */
function isTruthy(value) {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null || value === '') return false;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

/** 规范化 URL 作为数据库主键（与抓取时用的键保持一致） */
function canonicalOrRaw(raw) {
  try {
    return canonicalizeUrl(raw);
  } catch {
    return String(raw);
  }
}

function wantsRawMarkdown(req) {
  const format = String(req.query.format || '').toLowerCase();
  if (format === 'markdown' || format === 'md' || format === 'text') return true;
  const accept = String(req.headers.accept || '');
  return accept.includes('text/markdown') && !accept.includes('application/json');
}

function pickUrl(req) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const raw = body.url || body.uri || body.link || req.query.url;
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

function pickOptions(req) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const options = body.options && typeof body.options === 'object' ? { ...body.options } : {};
  // 允许把常用开关直接放在顶层
  for (const key of [
    'engine',
    'imageMode',
    'mediaMode',
    // 媒体目录布局：folder（标题文件夹 + 顺序编号）/ flat（内容寻址去重）
    'mediaLayout',
    'layout',
    'includeImages',
    'includeVideos',
    'includeAudio',
    'filterAds',
    'frontmatter',
    'includeTitle',
    'includeMetaSection',
    'store',
    'force',
    'scroll',
    'scrollSteps',
    'waitSelector',
    'waitMs',
    'timeoutMs',
    'maxMediaFiles',
    'maxFileBytes',
    'maxVideoBytes',
    'maxAudioBytes',
    'maxBytesPerPage',
    'maxVideoBytesPerPage',
    'filenameTemplate',
    'videoMarkdown',
    'recoverEmbeddedMedia',
    'embeddedMediaHeading',
    'observedMediaHeading',
    'removeSelectors',
    'headers',
    'cookies',
    'userAgent',
    'returnMarkdown',
    'onMediaError',
    // 只下载视频图片：媒体落到独立的媒体目录（默认与 DATA_DIR 同级），默认不落文章
    'mediaOnly',
    'onlyMedia',
    // webhook：显式开关；不传时"只下载媒体 + 配了 WEBHOOK_URL"会自动发
    'webhook',
    // 单次请求覆盖 webhook 地址
    'webhookUrl',
    // 单次请求覆盖小红书自建解析器地址（留空用服务端 XIAOHONGSHU_API）
    'xhsApiUrl',
    // 小红书是否"只用解析器、不抓网页"（默认跟随 XIAOHONGSHU_PARSER_ONLY）
    'xhsParserOnly',
  ]) {
    if (body[key] !== undefined) options[key] = body[key];
  }
  for (const [key, value] of Object.entries(req.query)) {
    if (key === 'url' || key === 'format' || key === 'token') continue;
    options[key] = value;
  }
  return options;
}

export const apiRouter = Router();

/* ------------------------------------------------------------------ *
 * 转换
 * ------------------------------------------------------------------ */

apiRouter.post(
  '/webhook/test',
  ah(async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const url = typeof body.url === 'string' && body.url.trim() ? body.url.trim() : undefined;
    const format = typeof body.format === 'string' && body.format.trim() ? body.format.trim().toLowerCase() : undefined;
    const text = typeof body.text === 'string' ? body.text.slice(0, 1000) : '';
    const result = await sendWebhookTest({ url, format, text });
    res.json({ ok: true, data: result });
  }),
);

apiRouter.post(
  '/convert',
  ah(async (req, res) => {
    const url = pickUrl(req);
    if (!url) throw badRequest('请求体需要包含 url 字段，例如 {"url":"https://example.com"}');
    const options = pickOptions(req);
    const result = await convertUrl(String(url), options);

    if (wantsRawMarkdown(req)) {
      if (!result.markdown) throw badRequest('result.markdown 不可用，请设置 returnMarkdown=true 或改用 JSON 响应');
      return sendMarkdown(res, result);
    }
    res.json({ ok: true, data: result });
  }),
);

apiRouter.get(
  '/convert',
  ah(async (req, res) => {
    const url = pickUrl(req);
    if (!url) throw badRequest('缺少 url 查询参数，例如 /api/convert?url=https://example.com');
    const options = pickOptions(req);
    const result = await convertUrl(String(url), options);
    if (wantsRawMarkdown(req)) {
      if (!result.markdown) throw badRequest('result.markdown 不可用，请设置 returnMarkdown=true');
      return sendMarkdown(res, result);
    }
    res.json({ ok: true, data: result });
  }),
);

apiRouter.post(
  '/convert/batch',
  ah(async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const urls = Array.isArray(body.urls) ? body.urls : [];
    if (!urls.length) throw badRequest('请求体需要包含 urls 数组');
    if (urls.length > config.convert.maxBatchSize) {
      throw badRequest(`单次最多处理 ${config.convert.maxBatchSize} 个 URL（当前 ${urls.length}）`);
    }
    const options = pickOptions(req);
    // 批量模式下默认不返回正文，避免响应体过大
    if (options.returnMarkdown === undefined) options.returnMarkdown = false;

    const results = await mapLimit(urls, Math.min(2, config.convert.concurrency), async (raw) => {
      try {
        return { url: String(raw), ok: true, data: await convertUrl(String(raw), options) };
      } catch (err) {
        return { url: String(raw), ok: false, error: { code: err.code || 'error', message: err.message } };
      }
    });
    res.json({ ok: true, data: { total: results.length, succeeded: results.filter((r) => r?.ok).length, results } });
  }),
);

/** 取文章的文件名：优先用保存时算好的，老数据按当前模板现算 */
function filenameOf(meta, fallbackId = '') {
  if (meta?.filename) return meta.filename;
  return buildArticleFilename(meta || { id: fallbackId }, {
    template: config.filenames.template,
    maxLength: config.filenames.maxLength,
    maxBytes: config.filenames.maxBytes,
  });
}

/**
 * 给不支持 filename* 的客户端准备可读的 ASCII 兜底名。
 * 全部由文章自身信息推导：文件名里已有的 ASCII 单词 → 日期 + 站点 + 标题短哈希。
 */
function asciiFallbackFor(filename, meta = {}) {
  const host = (() => {
    try {
      return new URL(meta.finalUrl || meta.url || '').hostname;
    } catch {
      return '';
    }
  })();
  const date = String(meta.createdAt || meta.published || '').slice(0, 10);
  const hash = shortHash(`${meta.title || ''}${meta.id || ''}`, 8);
  return asciiFallbackName(filename, { host, date, hash });
}

function sendMarkdown(res, result) {
  const filename = result.filename || buildArticleFilename(result, {
    template: config.filenames.template,
    maxLength: config.filenames.maxLength,
    maxBytes: config.filenames.maxBytes,
  });
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    contentDisposition(filename, { type: 'inline', asciiFallback: asciiFallbackFor(filename, result) }),
  );
  // HTTP 头只能是 latin1，所以 id 做百分号编码（与 URL 路径中的写法一致）
  res.setHeader('X-Article-Id', encodeURIComponent(result.id));
  res.setHeader('X-Article-Source', encodeURIComponent(result.finalUrl || result.url || ''));
  res.setHeader('X-Article-Filename', encodeURIComponent(filename));
  if (result.markdownUrl) res.setHeader('X-Article-Url', result.markdownUrl);
  res.send(result.markdown);
}

/* ------------------------------------------------------------------ *
 * 文章
 * ------------------------------------------------------------------ */

apiRouter.get(
  '/articles',
  ah(async (req, res) => {
    const limit = Math.min(Number.parseInt(req.query.limit, 10) || 20, 200);
    const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
    const data = await articleStore.list({ limit, offset, q: String(req.query.q || '') });
    // 老数据没有 filename，按当前模板现算，保证客户端拿到的名字始终可用
    data.items = data.items.map((item) => ({
      ...item,
      filename: item.filename || filenameOf(item, item.id),
    }));
    res.json({ ok: true, data });
  }),
);

apiRouter.get(
  '/articles/:id',
  ah(async (req, res) => {
    const meta = await articleStore.getMeta(req.params.id);
    const includeMarkdown = String(req.query.includeMarkdown || '') === '1';
    const payload = { ...meta, filename: filenameOf(meta, req.params.id) };
    if (includeMarkdown) payload.markdown = await articleStore.getMarkdown(req.params.id);
    res.json({ ok: true, data: payload });
  }),
);

apiRouter.get(
  '/articles/:id/markdown',
  ah(async (req, res) => {
    const id = req.params.id;
    const markdown = await articleStore.getMarkdown(id);
    let meta = null;
    try {
      meta = await articleStore.getMeta(id);
    } catch {
      /* ignore */
    }
    const filename = filenameOf(meta, id);
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      contentDisposition(filename, { type: 'inline', asciiFallback: asciiFallbackFor(filename, meta || {}) }),
    );
    res.setHeader('X-Article-Filename', encodeURIComponent(filename));
    res.send(markdown);
  }),
);

apiRouter.get(
  '/articles/:id/download',
  ah(async (req, res) => {
    const id = req.params.id;
    const markdown = await articleStore.getMarkdown(id);
    let meta = null;
    try {
      meta = await articleStore.getMeta(id);
    } catch {
      /* ignore */
    }
    const filename = filenameOf(meta, id);
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      contentDisposition(filename, { type: 'attachment', asciiFallback: asciiFallbackFor(filename, meta || {}) }),
    );
    res.setHeader('X-Article-Filename', encodeURIComponent(filename));
    res.send(markdown);
  }),
);

apiRouter.delete(
  '/articles/:id',
  ah(async (req, res) => {
    const data = await deleteArticle({
      id: req.params.id,
      withMedia: isTruthy(req.query.withMedia ?? req.body?.withMedia),
    });
    res.json({ ok: true, data });
  }),
);

/** 批量删除：{ ids: [...], withMedia: true } */
apiRouter.post(
  '/articles/delete',
  ah(async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const ids = Array.isArray(body.ids) ? body.ids : String(body.ids || '').split(/[\s,]+/).filter(Boolean);
    const data = await deleteArticles({ ids, withMedia: isTruthy(body.withMedia) });
    res.json({ ok: true, data });
  }),
);

/* ------------------------------------------------------------------ *
 * 图床
 * ------------------------------------------------------------------ */

apiRouter.get(
  '/media',
  ah(async (req, res) => {
    const limit = Math.min(Number.parseInt(req.query.limit, 10) || 50, 500);
    const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
    const sort = req.query.sort === 'oldest' ? 'oldest' : 'newest';
    const data = await mediaStore.list({ limit, offset, sort });
    res.json({ ok: true, data: { ...data, publicBaseUrl: config.publicBaseUrl } });
  }),
);

apiRouter.get(
  '/media/by-url',
  ah(async (req, res) => {
    const raw = String(req.query.url || '');
    if (!raw) throw badRequest('缺少 url 参数');
    let key = raw;
    try {
      key = canonicalizeUrl(raw);
    } catch {
      /* 保留原样 */
    }
    const record = mediaStore.get(key) || mediaStore.get(raw);
    if (!record) throw notFound('该 URL 尚未收录到本地图床');
    res.json({ ok: true, data: { ...record, url: mediaStore.localUrl(record) } });
  }),
);

apiRouter.post(
  '/media/prune',
  ah(async (req, res) => {
    const maxTotalBytes = Number(req.body?.maxTotalBytes) > 0 ? Number(req.body.maxTotalBytes) : undefined;
    const data = await mediaStore.prune({ maxTotalBytes });
    res.json({ ok: true, data });
  }),
);

/** 删除单个图床文件（默认拒绝删还被引用的，force=1 强删） */
apiRouter.delete(
  '/media/:ref',
  ah(async (req, res) => {
    const data = await deleteMedia({
      ref: req.params.ref,
      force: isTruthy(req.query.force ?? req.body?.force),
    });
    res.json({ ok: true, data });
  }),
);

/** 回收没有被任何文章引用的图床文件；dryRun=1 只统计不删 */
apiRouter.post(
  '/media/gc',
  ah(async (req, res) => {
    const data = await gcOrphanMedia({ dryRun: isTruthy(req.body?.dryRun ?? req.query.dryRun) });
    res.json({ ok: true, data });
  }),
);

/* ------------------------------------------------------------------ *
 * 网址记录 / 正文副本（数据库）
 * ------------------------------------------------------------------ */

apiRouter.get(
  '/urls',
  ah(async (req, res) => {
    await articleDb.ready();
    const limit = Math.min(Number.parseInt(req.query.limit, 10) || 50, 500);
    const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
    const { total, items } = articleDb.listUrls({ limit, offset, q: String(req.query.q || '') });
    res.json({
      ok: true,
      data: {
        total,
        limit,
        offset,
        available: articleDb.available,
        reason: articleDb.available ? undefined : articleDb.reason,
        items: items.map((row) => ({
          ...row,
          articleUrl: row.articleId ? `${config.publicBaseUrl}/api/articles/${encodeURIComponent(row.articleId)}` : null,
          markdownUrl: row.articleId
            ? `${config.publicBaseUrl}/api/articles/${encodeURIComponent(row.articleId)}/markdown`
            : null,
        })),
      },
    });
  }),
);

/** 查某个网址是否抓过（不会触发抓取） */
apiRouter.get(
  '/urls/check',
  ah(async (req, res) => {
    await articleDb.ready();
    const raw = String(req.query.url || '');
    if (!raw) throw badRequest('缺少 url 参数');
    const key = canonicalOrRaw(raw);
    const record = articleDb.getUrlRecord(key);
    if (!record) {
      return res.json({ ok: true, data: { known: false, url: key, database: articleDb.available } });
    }
    const stored = record.articleId ? articleDb.getStoredArticle(record.articleId) : null;
    res.json({
      ok: true,
      data: {
        known: true,
        url: key,
        fetchCount: record.fetchCount,
        changeCount: record.changeCount,
        contentHash: record.contentHash,
        textLength: record.textLength,
        mediaCount: record.mediaCount,
        firstSeenAt: record.firstSeenAt,
        lastFetchedAt: record.lastFetchedAt,
        lastChangedAt: record.lastChangedAt,
        articleId: record.articleId,
        article: stored ? { id: stored.id, title: stored.title, filename: stored.filename, createdAt: stored.created_at } : null,
        /** 命中这条记录时再抓一次会被直接复用（除非传 force=1） */
        wouldReuse: Boolean(stored && config.database.skipUnchanged),
      },
    });
  }),
);

/** 忘掉某条网址记录（下次抓取会完整重新下载；不影响已存档的文章） */
apiRouter.delete(
  '/urls/:id',
  ah(async (req, res) => {
    const removed = articleDb.deleteUrlRecord(req.params.id);
    if (!removed) throw notFound(`网址记录不存在: ${req.params.id}`);
    res.json({ ok: true, data: { id: Number(req.params.id), removed: true } });
  }),
);

/** 在正文副本里检索 */
apiRouter.get(
  '/search',
  ah(async (req, res) => {
    await articleDb.ready();
    const q = String(req.query.q || '').trim();
    if (!q) throw badRequest('缺少 q 参数');
    const limit = Math.min(Number.parseInt(req.query.limit, 10) || 20, 100);
    const result = articleDb.searchArticles({ q, limit });
    res.json({
      ok: true,
      data: {
        query: q,
        available: articleDb.available,
        reason: articleDb.available ? undefined : articleDb.reason,
        items: result.items.map((row) => ({
          id: row.id,
          url: row.url,
          title: row.title,
          filename: row.filename,
          createdAt: row.created_at,
          words: row.text_length,
          mediaCount: row.media_count,
          snippet: String(row.head || '').replace(/\s+/g, ' ').slice(0, 200),
          markdownUrl: `${config.publicBaseUrl}/api/articles/${encodeURIComponent(row.id)}/markdown`,
        })),
        total: result.items.length,
      },
    });
  }),
);

/* ------------------------------------------------------------------ *
 * 诊断
 * ------------------------------------------------------------------ */

apiRouter.get('/rules', (_req, res) => {
  res.json({ ok: true, data: rulesSummary() });
});

apiRouter.get(
  '/stats',
  ah(async (_req, res) => {
    const [media, articles, database] = await Promise.all([
      mediaStore.stats(),
      articleStore.stats(),
      articleDb.stats(),
    ]);
    res.json({
      ok: true,
      data: {
        media,
        articles,
        database,
        config: {
          engine: 'browser|fetch',
          publicBaseUrl: config.publicBaseUrl,
          concurrency: config.convert.concurrency,
          maxMediaFilesPerPage: config.storage.maxFilesPerPage,
          maxMediaFileBytes: config.storage.maxFileBytes,
          allowPrivateNetwork: config.security.allowPrivateNetwork,
          apiTokenRequired: Boolean(config.apiToken),
        },
      },
    });
  }),
);

log.debug('API 路由已装载');
