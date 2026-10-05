import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const log = logger.child({ mod: 'db' });

/**
 * 网址记录 + 正文副本（SQLite）。
 *
 * 用 Node 内置的 node:sqlite，不引第三方依赖：
 *  · Node ≥ 24 开箱可用
 *  · Node 22.5 ~ 23.3 需要 --experimental-sqlite
 * 环境不满足时**不会让服务起不来**，只是把这些功能降级成 no-op（日志里会说明原因）。
 *
 * 两张表：
 *   urls     —— 抓过的网址记录（正文指纹、抓取次数、变更次数、对应文章）
 *   articles —— 正文副本（正文额外存一份，便于检索与"内容没变就别再下载"）
 */
export class ArticleDatabase {
  constructor({ file = config.database.file, enabled = config.database.enabled } = {}) {
    this.file = file;
    this.enabled = enabled;
    this.db = null;
    this.available = false;
    this.reason = '';
    this._initialized = false;
    this._initPromise = null;
    this._stmts = {};
  }

  /** 幂等初始化：多次调用只真正执行一次 */
  async ready() {
    if (!this._initPromise) this._initPromise = this.init();
    return this._initPromise;
  }

  async init() {
    if (this._initialized) return this;
    this._initialized = true;
    if (!this.enabled) {
      this.reason = 'DATABASE_ENABLED=false';
      log.info('数据库已禁用（DATABASE_ENABLED=false），网址记录与正文副本功能不可用');
      return this;
    }

    let DatabaseSync;
    try {
      ({ DatabaseSync } = await import('node:sqlite'));
    } catch (err) {
      this.reason = `当前 Node (${process.version}) 无法加载 node:sqlite：${err.message}；需要 Node ≥ 24，或 Node 22.5+ 加 --experimental-sqlite`;
      log.warn('数据库不可用，已降级', { reason: this.reason });
      return this;
    }

    try {
      this.db = new DatabaseSync(this.file);
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA synchronous = NORMAL');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS urls (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          url TEXT NOT NULL UNIQUE,
          article_id TEXT,
          title TEXT,
          content_hash TEXT,
          text_length INTEGER DEFAULT 0,
          media_count INTEGER DEFAULT 0,
          options_hash TEXT,
          fetch_count INTEGER DEFAULT 0,
          change_count INTEGER DEFAULT 0,
          status TEXT DEFAULT 'ok',
          last_error TEXT,
          first_seen_at TEXT,
          last_fetched_at TEXT,
          last_changed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_urls_article ON urls(article_id);
        CREATE INDEX IF NOT EXISTS idx_urls_last ON urls(last_fetched_at DESC);

        CREATE TABLE IF NOT EXISTS articles (
          id TEXT PRIMARY KEY,
          url TEXT,
          final_url TEXT,
          title TEXT,
          markdown TEXT NOT NULL,
          content_hash TEXT,
          text_length INTEGER DEFAULT 0,
          media_count INTEGER DEFAULT 0,
          filename TEXT,
          meta_json TEXT,
          created_at TEXT,
          updated_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_articles_url ON articles(url);
        CREATE INDEX IF NOT EXISTS idx_articles_hash ON articles(content_hash);
      `);
      // 老库补列（首次引入 options_hash 时用）
      const columns = this.db.prepare('PRAGMA table_info(urls)').all().map((c) => c.name);
      if (!columns.includes('options_hash')) {
        this.db.exec('ALTER TABLE urls ADD COLUMN options_hash TEXT');
        log.info('数据库迁移：urls 表新增 options_hash 列');
      }
      this._stmts = {
        getUrl: this.db.prepare('SELECT * FROM urls WHERE url = ?'),
        getUrlById: this.db.prepare('SELECT * FROM urls WHERE id = ?'),
        insertUrl: this.db.prepare(`INSERT INTO urls (url, article_id, title, content_hash, text_length, media_count, options_hash, fetch_count, change_count, status, last_error, first_seen_at, last_fetched_at, last_changed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`),
        updateUrl: this.db.prepare(`UPDATE urls SET article_id = ?, title = ?, content_hash = ?, text_length = ?, media_count = ?, options_hash = ?,
          fetch_count = fetch_count + 1, change_count = change_count + ?, status = ?, last_error = ?, last_fetched_at = ?, last_changed_at = ? WHERE url = ?`),
        listUrls: this.db.prepare('SELECT * FROM urls ORDER BY last_fetched_at DESC LIMIT ? OFFSET ?'),
        listUrlsSearch: this.db.prepare('SELECT * FROM urls WHERE url LIKE ? OR title LIKE ? ORDER BY last_fetched_at DESC LIMIT ? OFFSET ?'),
        countUrls: this.db.prepare('SELECT COUNT(*) AS n FROM urls'),
        countUrlsSearch: this.db.prepare('SELECT COUNT(*) AS n FROM urls WHERE url LIKE ? OR title LIKE ?'),
        deleteUrl: this.db.prepare('DELETE FROM urls WHERE id = ?'),
        deleteUrlsByArticle: this.db.prepare('DELETE FROM urls WHERE article_id = ?'),
        upsertArticle: this.db.prepare(`INSERT INTO articles (id, url, final_url, title, markdown, content_hash, text_length, media_count, filename, meta_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET url = excluded.url, final_url = excluded.final_url, title = excluded.title,
            markdown = excluded.markdown, content_hash = excluded.content_hash, text_length = excluded.text_length,
            media_count = excluded.media_count, filename = excluded.filename, meta_json = excluded.meta_json,
            updated_at = excluded.updated_at`),
        getArticle: this.db.prepare('SELECT * FROM articles WHERE id = ?'),
        getArticleByUrl: this.db.prepare('SELECT * FROM articles WHERE url = ? ORDER BY created_at DESC LIMIT 1'),
        searchArticles: this.db.prepare(
          'SELECT id, url, title, filename, text_length, media_count, created_at, substr(markdown, 1, 400) AS head FROM articles WHERE title LIKE ? OR markdown LIKE ? ORDER BY created_at DESC LIMIT ?',
        ),
        deleteArticle: this.db.prepare('DELETE FROM articles WHERE id = ?'),
        countArticles: this.db.prepare('SELECT COUNT(*) AS n FROM articles'),
        sumLength: this.db.prepare('SELECT COALESCE(SUM(LENGTH(markdown)), 0) AS n FROM articles'),
      };
      this.available = true;
      const size = await this._fileSize();
      log.info('数据库已就绪', {
        file: this.file,
        urls: this._stmts.countUrls.get().n,
        articles: this._stmts.countArticles.get().n,
        sizeBytes: size,
      });
    } catch (err) {
      this.reason = err.message;
      this.available = false;
      log.warn('数据库初始化失败，已降级', { err: err.message, file: this.file });
    }
    return this;
  }

  async _fileSize() {
    try {
      const fs = await import('node:fs/promises');
      const stat = await fs.stat(this.file);
      return stat.size;
    } catch {
      return 0;
    }
  }

  /* ---------------- 网址记录 ---------------- */

  getUrlRecord(url) {
    if (!this.available) return null;
    try {
      return mapUrlRecord(this._stmts.getUrl.get(url));
    } catch (err) {
      log.warn('读取网址记录失败', { err: err.message });
      return null;
    }
  }

  getUrlRecordById(id) {
    if (!this.available) return null;
    try {
      return mapUrlRecord(this._stmts.getUrlById.get(Number(id)));
    } catch {
      return null;
    }
  }

  /**
   * 记录一次抓取。
   * @param {object} params
   * @param {boolean} params.changed 正文是否与上次不同（决定是否累加 change_count）
   */
  recordFetch({ url, articleId = null, title = '', contentHash = '', textLength = 0, mediaCount = 0, optionsHash = '', status = 'ok', error = '', changed = true }) {
    if (!this.available) return null;
    const now = new Date().toISOString();
    try {
      const existing = this._stmts.getUrl.get(url);
      if (!existing) {
        this._stmts.insertUrl.run(url, articleId, title, contentHash, textLength, mediaCount, optionsHash || null, changed ? 1 : 0, status, error || null, now, now, changed ? now : null);
      } else {
        this._stmts.updateUrl.run(
          articleId ?? existing.article_id,
          title || existing.title,
          contentHash || existing.content_hash,
          textLength,
          mediaCount,
          optionsHash || existing.options_hash,
          changed ? 1 : 0,
          status,
          error || null,
          now,
          changed ? now : existing.last_changed_at,
          url,
        );
      }
      return mapUrlRecord(this._stmts.getUrl.get(url));
    } catch (err) {
      log.warn('写入网址记录失败', { err: err.message, url });
      return null;
    }
  }

  listUrls({ limit = 50, offset = 0, q = '' } = {}) {
    if (!this.available) return { total: 0, items: [] };
    try {
      const like = `%${q}%`;
      const rows = q ? this._stmts.listUrlsSearch.all(like, like, limit, offset) : this._stmts.listUrls.all(limit, offset);
      const total = q ? this._stmts.countUrlsSearch.get(like, like).n : this._stmts.countUrls.get().n;
      return { total, items: rows.map(mapUrlRecord) };
    } catch (err) {
      log.warn('列出网址记录失败', { err: err.message });
      return { total: 0, items: [] };
    }
  }

  deleteUrlRecord(id) {
    if (!this.available) return 0;
    try {
      const result = this._stmts.deleteUrl.run(Number(id));
      return Number(result.changes || 0);
    } catch (err) {
      log.warn('删除网址记录失败', { err: err.message });
      return 0;
    }
  }

  deleteUrlsByArticle(articleId) {
    if (!this.available) return 0;
    try {
      return Number(this._stmts.deleteUrlsByArticle.run(articleId).changes || 0);
    } catch {
      return 0;
    }
  }

  /* ---------------- 正文副本 ---------------- */

  upsertArticle({ id, url = '', finalUrl = '', title = '', markdown = '', contentHash = '', textLength = 0, mediaCount = 0, filename = '', meta = null, createdAt = '' }) {
    if (!this.available) return false;
    try {
      const now = new Date().toISOString();
      this._stmts.upsertArticle.run(
        id,
        url,
        finalUrl,
        title,
        markdown,
        contentHash,
        textLength,
        mediaCount,
        filename,
        meta ? JSON.stringify(meta) : null,
        createdAt || now,
        now,
      );
      return true;
    } catch (err) {
      log.warn('写入正文副本失败', { err: err.message, id });
      return false;
    }
  }

  getStoredArticle(id) {
    if (!this.available) return null;
    try {
      const row = this._stmts.getArticle.get(id);
      if (!row) return null;
      return { ...row, meta: row.meta_json ? safeParse(row.meta_json) : null };
    } catch {
      return null;
    }
  }

  getStoredArticleByUrl(url) {
    if (!this.available) return null;
    try {
      const row = this._stmts.getArticleByUrl.get(url);
      if (!row) return null;
      return { ...row, meta: row.meta_json ? safeParse(row.meta_json) : null };
    } catch {
      return null;
    }
  }

  searchArticles({ q = '', limit = 20 } = {}) {
    if (!this.available || !q) return { total: 0, items: [] };
    try {
      const like = `%${q}%`;
      return { total: 0, items: this._stmts.searchArticles.all(like, like, limit) };
    } catch (err) {
      log.warn('搜索正文失败', { err: err.message });
      return { total: 0, items: [] };
    }
  }

  deleteStoredArticle(id) {
    if (!this.available) return 0;
    try {
      return Number(this._stmts.deleteArticle.run(id).changes || 0);
    } catch {
      return 0;
    }
  }

  async stats() {
    if (!this.available) return { available: false, reason: this.reason, file: this.file };
    return {
      available: true,
      file: this.file,
      urls: this._stmts.countUrls.get().n,
      articles: this._stmts.countArticles.get().n,
      markdownBytes: this._stmts.sumLength.get().n,
      sizeBytes: await this._fileSize(),
      engine: 'node:sqlite',
    };
  }

  close() {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        /* ignore */
      }
      this.db = null;
      this.available = false;
    }
  }
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 数据库里的列是 snake_case，但 JS 侧统一用 camelCase。
 * （踩过坑：convertUrl 里判的是 knownUrl.articleId / contentHash，
 *   而 SQLite 返回的是 article_id / content_hash，导致复用判断恒为假。）
 */
export function mapUrlRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    url: row.url,
    articleId: row.article_id ?? null,
    title: row.title ?? '',
    contentHash: row.content_hash ?? '',
    textLength: row.text_length ?? 0,
    mediaCount: row.media_count ?? 0,
    optionsHash: row.options_hash ?? '',
    fetchCount: row.fetch_count ?? 0,
    changeCount: row.change_count ?? 0,
    status: row.status ?? 'ok',
    lastError: row.last_error ?? null,
    firstSeenAt: row.first_seen_at ?? null,
    lastFetchedAt: row.last_fetched_at ?? null,
    lastChangedAt: row.last_changed_at ?? null,
  };
}

export const articleDb = new ArticleDatabase();
export { path };
