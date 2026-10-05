import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { sha256 } from '../utils/text.js';
import { logger } from '../utils/logger.js';

const log = logger.child({ mod: 'media-store' });

/**
 * 本地图床。
 *
 * 两种目录布局（MEDIA_LAYOUT / mediaLayout 选项）：
 *
 *  folder（默认，像"标题命名的相册文件夹"）：
 *    DATA_DIR/media/<标题 slug>/01.jpg、02.png、03.mp4 …
 *    —— 同一篇文章的媒体放在一起，按正文出现顺序编号，一眼能看出哪张是哪张
 *
 *  flat（旧行为，内容寻址）：
 *    DATA_DIR/media/<内容哈希><扩展名>
 *    —— 同一份内容只存一份、跨文章共用，磁盘最省
 *
 *   DATA_DIR/media-index.ndjson  ← 索引（放在 media 目录之外，避免被静态服务暴露）
 *
 * 公共特性：容量超限后按最久未使用淘汰；删除文章时可连带清理（folder 模式直接删整个文件夹）
 */
export class MediaStore {
  constructor({
    dir = config.data.mediaDir,
    indexPath = path.join(config.data.dir, 'media-index.ndjson'),
    publicBaseUrl = config.publicBaseUrl,
    maxTotalBytes = config.storage.maxTotalBytes,
    /** 对外 URL 前缀：默认 /media；「只下载媒体」模式用另一棵目录树时换成 /media-only */
    urlPrefix = '/media',
  } = {}) {
    this.dir = dir;
    this.indexPath = indexPath;
    this.publicBaseUrl = publicBaseUrl.replace(/\/+$/, '');
    this.urlPrefix = `/${String(urlPrefix || '/media').replace(/^\/+|\/+$/g, '')}`;
    this.maxTotalBytes = maxTotalBytes;
    /** 全部记录：相对路径 → record（两种布局都用它做权威列表） */
    this.byFile = new Map();
    /** 内容哈希 → record（flat 模式是一一对应；folder 模式指向其中一份） */
    this.byHash = new Map();
    /** 源 URL → record（只维护 flat 模式，用于"重复抓取零下载"） */
    this.byUrl = new Map();
    this.totalBytes = 0;
    this._writeQueue = Promise.resolve();
    /** hash → 正在写盘的 Promise：同一份内容并发落盘时排队，避免抢同一个文件名 */
    this._flatWrites = new Map();
  }

  get size() {
    return this.byFile.size;
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.mkdir(config.data.articlesDir, { recursive: true });
    await fs.mkdir(config.data.tmpDir, { recursive: true });
    await this._loadIndex();
    log.info('图床已就绪', {
      dir: this.dir,
      files: this.byFile.size,
      urls: this.byUrl.size,
      bytes: this.totalBytes,
    });
    return this;
  }

  async _loadIndex() {
    let raw = '';
    try {
      raw = await fs.readFile(this.indexPath, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn('读取图床索引失败', { err: err.message });
      return;
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let rec;
      try {
        rec = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!rec?.h || !rec?.f) continue;
      this.byFile.set(rec.f, rec);
      if (!this.byHash.has(rec.h)) this.byHash.set(rec.h, rec);
      // 只有 flat 布局的记录才进 URL 索引（folder 布局是按文章分开存的，不该跨文章命中）
      if (rec.u && !rec.p) this.byUrl.set(rec.u, rec.f);
    }
    this.totalBytes = [...this.byFile.values()].reduce((acc, r) => acc + (r.b || 0), 0);
  }

  _persist(record) {
    const line = JSON.stringify(record) + '\n';
    this._writeQueue = this._writeQueue
      .then(() => fs.appendFile(this.indexPath, line, 'utf8'))
      .catch((err) => log.warn('写入图床索引失败', { err: err.message }));
    return this._writeQueue;
  }

  localUrl(record) {
    // folder 布局的文件名里带子目录（<标题>/01.jpg），逐段编码
    const encoded = String(record.f)
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    return `${this.publicBaseUrl}${this.urlPrefix}/${encoded}`;
  }

  localPath(record) {
    return path.join(this.dir, record.f);
  }

  /** 按源 URL 查询（只有 flat 布局做这个缓存；folder 布局按文章各存各的） */
  get(sourceUrl) {
    const file = this.byUrl.get(sourceUrl);
    if (file) return this.byFile.get(file) || null;
    return null;
  }

  getByHash(hash) {
    return this.byHash.get(hash) || null;
  }

  getByFile(file) {
    return this.byFile.get(file) || null;
  }

  /** 支持用完整 hash / hash 前缀 / 文件名（<hash24>.<ext>）/ 相对路径查找 */
  findByRef(ref) {
    const value = String(ref || '').trim();
    if (!value) return null;
    const bare = value.split('/').pop().split('.')[0];
    if (this.byFile.has(value)) return this.byFile.get(value);
    if (this.byHash.has(value)) return this.byHash.get(value);
    if (this.byHash.has(bare)) return this.byHash.get(bare);
    for (const record of this.byFile.values()) {
      if (record.f === value || record.f.split('/').pop().split('.')[0] === bare) return record;
    }
    if (bare.length >= 8) {
      for (const record of this.byFile.values()) {
        if (record.h.startsWith(bare)) return record;
      }
    }
    return null;
  }

  /** 重写索引文件（压缩），删文件后调用 */
  async _rewriteIndex() {
    const tmp = `${this.indexPath}.tmp`;
    const records = [...this.byFile.values()];
    const body = records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
    await fs.writeFile(tmp, body, 'utf8');
    await fs.rename(tmp, this.indexPath);
  }

  /** 从内存索引里摘掉一条记录 */
  _forget(record) {
    this.byFile.delete(record.f);
    if (this.byHash.get(record.h) === record) this.byHash.delete(record.h);
    if (record.u && this.byUrl.get(record.u) === record.f) this.byUrl.delete(record.u);
    this.totalBytes = Math.max(0, this.totalBytes - (record.b || 0));
  }

  /** 删除单个文件（按相对路径） */
  async removeFile(file) {
    const record = this.byFile.get(file);
    if (!record) return { removed: false, reason: 'not_found', file };
    try {
      await fs.unlink(this.localPath(record));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        log.warn('删除媒体文件失败', { file: record.f, err: err.message });
        return { removed: false, reason: err.code || 'unlink_failed', file };
      }
    }
    this._forget(record);
    await this._removeEmptyDirs(path.dirname(this.localPath(record)));
    await this._rewriteIndex();
    return { removed: true, hash: record.h, file: record.f, freedBytes: record.b || 0 };
  }

  /** 删除单个文件（按内容 hash，flat 布局用） */
  async removeByHash(hash) {
    const record = this.byHash.get(hash);
    if (!record) return { removed: false, reason: 'not_found', hash };
    return this.removeFile(record.f);
  }

  /**
   * 删掉某篇文章的整个媒体文件夹（folder 布局用）。
   * @param {string} articleId
   * @param {{files?: Set<string>|null}} [options]
   *   只删这些相对路径（= 这篇文章正文真正引用的那些）。
   *   必须带上的原因：store=false 的预览转换会提前用掉一个 id，同一秒内落盘的正式文章
   *   可能拿到同一个 id；只按 p 匹配就会把预览遗留的文件也算进这篇文章的账上删掉。
   */
  async removeArticleMedia(articleId, { files = null } = {}) {
    const records = [...this.byFile.values()].filter(
      (record) => record.p === articleId && (!files || files.has(record.f)),
    );
    let removed = 0;
    let freedBytes = 0;
    for (const record of records) {
      const result = await this.removeFile(record.f);
      if (result.removed) {
        removed += 1;
        freedBytes += result.freedBytes || 0;
      }
    }
    return { candidates: records.length, removed, freedBytes };
  }

  /**
   * 删空目录：逐级往上收，直到媒体根目录。
   * 按网站分类后每个文件在 media/<站点>/<文章>/ 下，删掉最后一个文件会留下两层空目录，
   * 这里一并收掉（只删空的，不会碰到还有内容的目录）。
   */
  async _removeEmptyDirs(dir) {
    const root = path.resolve(this.dir);
    let current = path.resolve(dir);
    while (current !== root && current.startsWith(root)) {
      try {
        const entries = await fs.readdir(current);
        if (entries.length) return;
        await fs.rmdir(current);
      } catch {
        return;
      }
      current = path.dirname(current);
    }
  }

  /**
   * 批量删除「没有被任何文章引用」的文件。
   * @param {Set<string>} referenced 仍被引用的 hash 集合
   * @param {Set<string>} [only] 只在这些 hash 里考虑（不传则全库扫描）
   */
  async removeUnreferenced(referenced = new Set(), only = null) {
    const candidates = [...this.byFile.values()].filter((r) => (only ? only.has(r.h) : true));
    let removed = 0;
    let freedBytes = 0;
    let kept = 0;
    for (const record of candidates) {
      if (referenced.has(record.h)) {
        kept += 1;
        continue;
      }
      const result = await this.removeFile(record.f);
      if (result.removed) {
        removed += 1;
        freedBytes += result.freedBytes || 0;
      }
    }
    return { candidates: candidates.length, removed, kept, freedBytes };
  }

  /**
   * 按相对路径批量删除（只重写一次索引）。
   * folder 布局下"同一份内容存了两份"时 hash 无法定位到具体文件，必须按路径删。
   */
  async removeManyFiles(files = []) {
    const list = [...new Set(files.map((f) => String(f || '').trim()).filter(Boolean))];
    const dirs = new Set();
    let removed = 0;
    let freedBytes = 0;
    for (const file of list) {
      const record = this.byFile.get(file);
      if (!record) continue;
      const full = this.localPath(record);
      try {
        await fs.unlink(full);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          log.warn('删除媒体文件失败', { file, err: err.message });
          continue;
        }
      }
      this._forget(record);
      dirs.add(path.dirname(full));
      removed += 1;
      freedBytes += record.b || 0;
    }
    if (removed) {
      for (const dir of dirs) await this._removeEmptyDirs(dir);
      await this._rewriteIndex();
    }
    return { candidates: list.length, removed, freedBytes };
  }

  touch(record) {
    record.a = Date.now();
    return record;
  }

  /**
   * 保存一份媒体。buffer 为内容，sourceUrl 为原始地址。
   * 返回记录（{ h, f, m, b, u, k, t, a, p, url }）：t=创建时间，a=最后访问时间，p=归属文章（仅 folder 布局）。
   * @param {string} [group] 站点目录名（按网站分类时用，见 config.storage.groupBySite）
   */
  async put({ sourceUrl, buffer, mime, kind = 'image', ext = '', group = '' }) {
    const hash = sha256(buffer);
    const safeGroup = this._safeGroup(group);
    /**
     * 只有「内容寻址」的 flat 记录能当缓存复用。
     * folder 布局的记录归某篇文章所有（带 p），它的文件会随那篇文章一起删掉，
     * 拿它冒充 flat 布局的缓存会让别的文章指向别人的目录，文章一删就是死链。
     */
    const reusable = this._flatRecord(hash);
    if (reusable) return this._reuse(reusable, sourceUrl);

    /**
     * 同一份内容的两个地址（同一张图的不同 CDN 地址）会被并发下载，最终落到同一个文件名上。
     * 按 hash 排队写盘：否则两次 rename 会抢同一个目标路径，Windows 上直接 EPERM，
     * 那份媒体就白下载了（报告里只剩另一条地址）。
     */
    const tail = this._flatWrites.get(hash) || Promise.resolve();
    const task = tail.then(async () => {
      const done =
        this._flatRecord(hash) ||
        this._contentAddressedAt(hash, ext || '.bin', safeGroup);
      if (done) return this._reuse(done, sourceUrl);
      return this._writeFlatMedia({ hash, buffer, mime, kind, ext: ext || '.bin', sourceUrl, group: safeGroup });
    });
    const settled = task.then(
      () => {},
      () => {},
    );
    this._flatWrites.set(hash, settled);
    settled.then(() => {
      if (this._flatWrites.get(hash) === settled) this._flatWrites.delete(hash);
    });
    return task;
  }

  /** hash → 内容寻址（flat）记录；folder 布局的副本不算 */
  _flatRecord(hash) {
    const found = this.byHash.get(hash);
    return found && !found.p ? found : null;
  }

  /** 内容寻址文件名上已经有同一份内容了吗（byHash 可能被 folder 的副本占着位） */
  _contentAddressedAt(hash, ext, group = '') {
    const rel = [this._safeGroup(group), `${hash.slice(0, 24)}${ext}`].filter(Boolean).join('/');
    const record = this.byFile.get(rel);
    return record && record.h === hash ? record : null;
  }

  /** 站点目录名清洗：只留文件系统安全的字符，拿不到就返回空串（不分类） */
  _safeGroup(value) {
    return String(value || '')
      .trim()
      .replace(/[\\/]+/g, '-')
      .replace(/^[.\s-]+|[.\s-]+$/g, '')
      .slice(0, 80);
  }

  /** 命中已有记录：补上 URL 索引后返回 */
  async _reuse(record, sourceUrl) {
    this.touch(record);
    if (sourceUrl && !this.byUrl.has(sourceUrl)) {
      // 值必须是文件相对路径：get() 用 byFile 按路径反查，写 hash 会永远 miss
      this.byUrl.set(sourceUrl, record.f);
      record.u = record.u || sourceUrl;
      await this._persist(record);
    }
    return { ...record, url: this.localUrl(record), reused: true };
  }

  /** 真正落一份内容寻址的文件（调用方已按 hash 排好队） */
  async _writeFlatMedia({ hash, buffer, mime, kind, ext, sourceUrl, group = '' }) {
    const rel = [this._safeGroup(group), `${hash.slice(0, 24)}${ext}`].filter(Boolean).join('/');
    const filePath = path.join(this.dir, ...rel.split('/'));
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(tmpPath, buffer);
    await fs.rename(tmpPath, filePath);

    const record = {
      h: hash,
      f: rel,
      m: mime || 'application/octet-stream',
      b: buffer.byteLength,
      u: sourceUrl || '',
      k: kind,
      t: Date.now(),
      a: Date.now(),
    };
    // 与 putArticleMedia 一致：已有映射优先保留（folder 的副本可能先占了位），
    // flat 自己的内容寻址关系由 byFile 里的 <hash>.<ext> 路径保证。
    if (!this.byHash.has(hash)) this.byHash.set(hash, record);
    this.byFile.set(record.f, record);
    if (sourceUrl) this.byUrl.set(sourceUrl, record.f);
    this.totalBytes += record.b;
    await this._persist(record);

    return { ...record, url: this.localUrl(record), reused: false };
  }

  /**
   * folder 布局：把媒体存进某篇文章的文件夹，并按顺序编号。
   *   media/<站点域名>/<标题 slug>/01.jpg、02.png、03.mp4 …
   * 同一篇文章内同一份内容只存一份（调用方已按 URL 去重），跨文章不去重。
   */
  async putArticleMedia({
    articleId,
    folder,
    index,
    buffer,
    mime,
    kind = 'image',
    sourceUrl = '',
    ext = '.bin',
    group = '',
  }) {
    const safeFolder = String(folder || 'article').replace(/[\\/]+/g, '-').replace(/^[.\s]+|[.\s]+$/g, '') || 'article';
    const name = `${String(index).padStart(2, '0')}${ext}`;
    const safeGroup = this._safeGroup(group);
    const rel = [safeGroup, safeFolder, name].filter(Boolean).join('/');
    const filePath = path.join(this.dir, ...rel.split('/'));
    const tmpPath = path.join(path.dirname(filePath), `.${name}.${process.pid}.${Date.now()}.tmp`);

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(tmpPath, buffer);
    await fs.rename(tmpPath, filePath);

    const hash = sha256(buffer);
    const existing = this.byFile.get(rel);
    // 同一路径被内容不同的媒体重新占用时，清掉旧 hash 的反查项，避免 byHash 指向错内容
    if (existing && existing.h !== hash && this.byHash.get(existing.h) === existing) {
      this.byHash.delete(existing.h);
    }
    const record = {
      h: hash,
      f: rel,
      m: mime || 'application/octet-stream',
      b: buffer.byteLength,
      u: sourceUrl || '',
      k: kind,
      t: existing?.t || Date.now(),
      a: Date.now(), // 最后访问时间（淘汰排序用），和 flat 记录同义
      p: articleId || '', // 归属文章：folder 布局据此整目录清理
    };
    if (existing) {
      this.totalBytes = Math.max(0, this.totalBytes - (existing.b || 0));
      this.byFile.set(rel, record);
    } else {
      this.byFile.set(rel, record);
    }
    if (!this.byHash.has(hash)) this.byHash.set(hash, record);
    this.totalBytes += record.b;
    await this._persist(record);

    return { ...record, url: this.localUrl(record), reused: Boolean(existing) };
  }

  /**
   * folder 布局：给某篇文章分配一个没被占用的文件夹名（标题 slug，重名加 -2/-3）。
   * 只跟同一站点目录下的其它文章比，不同站点可以有同名文件夹。
   */
  allocateFolder(base, articleId, group = '') {
    const wanted = String(base || 'media').replace(/[\\/]+/g, '-').replace(/^[.\s]+|[.\s]+$/g, '') || 'media';
    const safeGroup = this._safeGroup(group);
    const prefix = safeGroup ? `${safeGroup}/` : '';
    const used = new Set(
      [...this.byFile.values()]
        .filter((r) => r.p && r.p !== articleId && String(r.f).startsWith(prefix))
        .map((r) => this._folderSegment(r.f)),
    );
    used.delete('');
    if (!used.has(wanted)) return wanted;
    for (let i = 2; i <= 50; i += 1) {
      const candidate = `${wanted}-${i}`;
      if (!used.has(candidate)) return candidate;
    }
    return `${wanted}-${Date.now().toString(36)}`;
  }

  /** 从相对路径里取出"文章文件夹"那一段（folder 布局是倒数第二段；flat 布局没有） */
  _folderSegment(file) {
    const parts = String(file || '').split('/');
    return parts.length >= 2 ? parts[parts.length - 2] : '';
  }

  async has(record) {
    if (!record) return false;
    try {
      await fs.access(this.localPath(record));
      return true;
    } catch {
      return false;
    }
  }

  list({ limit = 100, offset = 0, sort = 'newest' } = {}) {
    const records = [...this.byFile.values()];
    records.sort((a, b) => (sort === 'oldest' ? (a.t || 0) - (b.t || 0) : (b.t || 0) - (a.t || 0)));
    const slice = records.slice(offset, offset + limit);
    return {
      total: records.length,
      totalBytes: this.totalBytes,
      items: slice.map((r) => ({
        hash: r.h,
        file: r.f,
        articleId: r.p || null,
        mime: r.m,
        bytes: r.b,
        kind: r.k,
        sourceUrl: r.u,
        url: this.localUrl(r),
        createdAt: new Date(r.t).toISOString(),
        lastAccess: new Date(r.a || r.t).toISOString(),
      })),
    };
  }

  async stats() {
    let files = 0;
    let bytes = 0;
    const walk = async (dir) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        const stat = await fs.stat(full);
        files += 1;
        bytes += stat.size;
      }
    };
    try {
      await walk(this.dir);
    } catch (err) {
      log.warn('统计图床目录失败', { err: err.message });
    }
    return {
      dir: this.dir,
      indexed: this.byFile.size,
      files,
      bytes,
      indexBytes: this.totalBytes,
      maxTotalBytes: this.maxTotalBytes,
      publicBaseUrl: this.publicBaseUrl,
    };
  }

  /** 容量超限时按 lastAccess 从旧到新淘汰 */
  async prune({ maxTotalBytes = this.maxTotalBytes, keepHashes = new Set() } = {}) {
    if (!maxTotalBytes || maxTotalBytes <= 0) return { removed: 0, freedBytes: 0 };
    const disk = await this.stats();
    let currentBytes = Math.max(this.totalBytes, disk.bytes);
    if (currentBytes <= maxTotalBytes) return { removed: 0, freedBytes: 0 };

    const records = [...this.byFile.values()].sort((a, b) => (a.a || a.t || 0) - (b.a || b.t || 0));
    let removed = 0;
    let freedBytes = 0;
    for (const record of records) {
      if (currentBytes <= maxTotalBytes) break;
      if (keepHashes.has(record.h)) continue;
      const result = await this.removeFile(record.f);
      if (result.removed) {
        currentBytes -= record.b || 0;
        freedBytes += record.b || 0;
        removed += 1;
      }
    }

    if (removed) log.info('图床已淘汰旧文件', { removed, freedBytes });
    return { removed, freedBytes };
  }

  async flush() {
    await this._writeQueue;
  }
}

export const mediaStore = new MediaStore();
