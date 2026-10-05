import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { badRequest, notFound } from '../utils/errors.js';

/**
 * id 只允许 Unicode 字母/数字与 . _ - ，且必须以字母或数字开头。
 * 注意：不要用 `id.includes('..')` 来防路径穿越 —— 标题里的 "......" 很常见，
 * 那样会把合法文章判成非法（曾经导致整次转换 400 失败）。
 * 由于字符集里没有路径分隔符、且首字符不能是点，`..` 不可能构成穿越。
 */
const ID_RE = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,180}$/u;

function assertId(id) {
  const value = typeof id === 'string' ? id.trim() : '';
  const traversal = value === '..' || value.startsWith('.') || /[\\/]/.test(value);
  if (!value || traversal || !ID_RE.test(value)) {
    throw badRequest(`非法 id: ${id}`);
  }
  return value;
}

/**
 * 把任意字符串"修复"成合法 id。
 * 用在生成 id 的路径上做保险：标题再奇怪也不该让整次转换失败。
 */
export function coerceArticleId(value, { fallback = 'article', maxLength = 160 } = {}) {
  let id = String(value ?? '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/-{2,}/g, '-')
    .replace(/^[._-]+/, '')
    .replace(/[._-]+$/, '');
  if (!id) id = fallback;
  if (!/^[\p{L}\p{N}]/u.test(id)) id = `${fallback}-${id}`.replace(/^[._-]+/, '');
  id = id.slice(0, maxLength).replace(/[._-]+$/, '');
  return id || fallback;
}

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 文章存储：每篇文章一个目录
 *   DATA_DIR/articles/<id>/index.md    ← Markdown 正文
 *   DATA_DIR/articles/<id>/meta.json   ← 元信息与统计
 */
export class ArticleStore {
  constructor({ dir = config.data.articlesDir, publicBaseUrl = config.publicBaseUrl } = {}) {
    this.dir = dir;
    this.publicBaseUrl = publicBaseUrl.replace(/\/+$/, '');
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
    return this;
  }

  articleDir(id) {
    return path.join(this.dir, assertId(id));
  }

  /**
   * 取一个没被占用的 id。
   * 生成的 id 里带秒级时间戳，同一秒内重复抓同一网址会撞车，
   * 直接落盘就会把上一篇静默覆盖 —— 这里改成自动加后缀，绝不覆盖已有文章。
   */
  async uniqueId(baseId) {
    const base = assertId(coerceArticleId(baseId));
    if (!(await pathExists(this.articleDir(base)))) return base;
    for (let i = 2; i <= 50; i += 1) {
      const candidate = `${base}-${i}`;
      if (!(await pathExists(this.articleDir(candidate)))) return candidate;
    }
    return `${base}-${crypto.randomBytes(2).toString('hex')}`;
  }

  async save({ id, meta, markdown }) {
    assertId(id);
    const dir = this.articleDir(id);
    await fs.mkdir(dir, { recursive: true });
    const mdPath = path.join(dir, 'index.md');
    const metaPath = path.join(dir, 'meta.json');
    await fs.writeFile(mdPath, markdown, 'utf8');
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');
    return {
      id,
      dir,
      markdownPath: mdPath,
      metaPath,
      markdownUrl: `${this.publicBaseUrl}/api/articles/${encodeURIComponent(id)}/markdown`,
      downloadUrl: `${this.publicBaseUrl}/api/articles/${encodeURIComponent(id)}/download`,
    };
  }

  async getMeta(id) {
    assertId(id);
    try {
      const raw = await fs.readFile(path.join(this.articleDir(id), 'meta.json'), 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      if (err.code === 'ENOENT') throw notFound(`文章不存在: ${id}`);
      throw err;
    }
  }

  async getMarkdown(id) {
    assertId(id);
    try {
      return await fs.readFile(path.join(this.articleDir(id), 'index.md'), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') throw notFound(`文章不存在: ${id}`);
      throw err;
    }
  }

  async get(id) {
    const [meta, markdown] = await Promise.all([this.getMeta(id), this.getMarkdown(id)]);
    return { meta, markdown };
  }

  async list({ limit = 20, offset = 0, q = '' } = {}) {
    let entries = [];
    try {
      entries = await fs.readdir(this.dir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return { total: 0, items: [] };
      throw err;
    }
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    const items = [];
    for (const id of dirs) {
      try {
        const meta = await this.getMeta(id);
        items.push(meta);
      } catch {
        // 跳过损坏的目录
      }
    }
    const filtered = q
      ? items.filter((m) =>
          [m.title, m.url, m.finalUrl, m.siteName, m.author]
            .filter(Boolean)
            .some((v) => String(v).toLowerCase().includes(String(q).toLowerCase())),
        )
      : items;

    filtered.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    return {
      total: filtered.length,
      limit,
      offset,
      items: filtered.slice(offset, offset + limit).map((m) => ({
        id: m.id,
        title: m.title,
        url: m.finalUrl || m.url,
        author: m.author,
        siteName: m.siteName,
        createdAt: m.createdAt,
        filename: m.filename || '',
        mediaCount: m.media?.length || 0,
        words: m.stats?.words || 0,
        markdownUrl: `${this.publicBaseUrl}/api/articles/${encodeURIComponent(m.id)}/markdown`,
        downloadUrl: `${this.publicBaseUrl}/api/articles/${encodeURIComponent(m.id)}/download`,
      })),
    };
  }

  async remove(id) {
    assertId(id);
    const dir = this.articleDir(id);
    if (!(await pathExists(dir))) throw notFound(`文章不存在: ${id}`);
    await fs.rm(dir, { recursive: true, force: true });
    return { id, removed: true };
  }

  /**
   * 收集所有文章引用的图床文件 hash（用于判断某个文件是否还有别处在用）。
   * @param {{excludeIds?: string[]}} options 排除的文章（通常是即将被删除的那些）
   */
  async referencedMediaHashes({ excludeIds = [] } = {}) {
    const excluded = new Set(excludeIds);
    const referenced = new Set();
    let entries = [];
    try {
      entries = await fs.readdir(this.dir, { withFileTypes: true });
    } catch {
      return referenced;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || excluded.has(entry.name)) continue;
      try {
        const meta = await this.getMeta(entry.name);
        for (const item of meta.media || []) {
          if (item?.hash) referenced.add(item.hash);
        }
      } catch {
        // 跳过损坏的目录
      }
    }
    return referenced;
  }

  /** 列出某篇文章用到的图床 hash */
  static hashesOf(meta) {
    return hashesOf(meta);
  }

  /**
   * 收集所有文章引用的图床文件相对路径。
   * folder 布局下每个文件只归一篇文章所有，只看 hash 会把"同内容的另一份副本"误判成仍被引用。
   */
  async referencedMediaFiles({ excludeIds = [] } = {}) {
    const excluded = new Set(excludeIds);
    const referenced = new Set();
    let entries = [];
    try {
      entries = await fs.readdir(this.dir, { withFileTypes: true });
    } catch {
      return referenced;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || excluded.has(entry.name)) continue;
      try {
        const meta = await this.getMeta(entry.name);
        for (const item of meta.media || []) {
          if (item?.file) referenced.add(item.file);
        }
      } catch {
        // 跳过损坏的目录
      }
    }
    return referenced;
  }

  async stats() {
    const { total, items } = await this.list({ limit: Number.MAX_SAFE_INTEGER });
    const byDate = {};
    for (const item of items) {
      const day = String(item.createdAt || '').slice(0, 10);
      if (day) byDate[day] = (byDate[day] || 0) + 1;
    }
    return { total, byDate };
  }
}

export const articleStore = new ArticleStore();

/** 一篇文章用到了哪些图床文件（内容 hash，去重） */
export function hashesOf(meta) {
  return [...new Set((meta?.media || []).map((m) => m?.hash).filter(Boolean))];
}
