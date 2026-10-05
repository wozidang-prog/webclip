import { articleStore, hashesOf } from './articles.js';
import { mediaStore } from './media.js';
import { articleDb } from './db.js';
import { badRequest, notFound } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const log = logger.child({ mod: 'maintenance' });

/**
 * 删除一篇文章；withMedia=true 时顺带清理它引用的图床文件。
 *
 * 两种布局：
 *  - folder：文件归文章所有（media/<标题>/NN.ext），按文章 id 直接删；
 *    同内容的两份副本分属不同文章，不能只看 hash 引用计数，否则会互相"保命"。
 *  - flat：内容寻址、跨文章共用，删前必须确认这些 hash 没有别的文章在用，
 *    否则会把其它文章里的图片链接打成死链。
 *
 * 同时删掉数据库里的正文副本和对应的网址记录 —— 删干净之后重新抓取会完整重新下载。
 */
export async function deleteArticle({ id, withMedia = false, keepUrlRecords = false }) {
  const meta = await articleStore.getMeta(id).catch(() => null);
  const removed = await articleStore.remove(id); // 不存在会抛 404

  const removedBodies = articleDb.deleteStoredArticle(id);
  const removedUrls = keepUrlRecords ? 0 : articleDb.deleteUrlsByArticle(id);
  if (removedBodies || removedUrls) log.info('已清理数据库记录', { id, removedBodies, removedUrls });

  if (!withMedia || !meta) {
    return { ...removed, withMedia: false, media: null, database: { removedBodies, removedUrls } };
  }

  const hashes = hashesOf(meta);
  // 这篇文章正文真正引用的文件（folder 布局下就是它自己那个文件夹里的文件）
  const ownFiles = new Set((meta.media || []).map((m) => m?.file).filter(Boolean));

  /**
   * 两条清理路径，缺一不可：
   *  1) folder 布局：记录里带归属文章 id（p），直接按文章清，整目录一起删。
   *     不能只靠 hash 引用计数 —— 两篇文章可能有内容完全相同的图（同 hash 各存一份），
   *     只要还有一篇文章在用这个 hash，另一篇的副本就会被判定为"仍被引用"而残留。
   *  2) flat 布局：记录是内容寻址、跨文章共用的，按 hash + 引用计数清理。
   */
  const owned = await mediaStore.removeArticleMedia(id, { files: ownFiles.size ? ownFiles : null });
  const stillReferenced = await articleStore.referencedMediaHashes({ excludeIds: [id] });
  const shared = hashes.length
    ? await mediaStore.removeUnreferenced(stillReferenced, new Set(hashes))
    : { candidates: 0, removed: 0, kept: 0, freedBytes: 0 };

  const result = {
    candidates: owned.candidates + shared.candidates,
    removed: owned.removed + shared.removed,
    kept: shared.kept || 0,
    freedBytes: owned.freedBytes + shared.freedBytes,
  };

  log.info('文章与图床文件已删除', { id, owned: owned.removed, shared: shared.removed, ...result });
  return {
    ...removed,
    withMedia: true,
    media: {
      candidates: result.candidates,
      removed: result.removed,
      keptBecauseShared: result.kept,
      freedBytes: result.freedBytes,
    },
    database: { removedBodies, removedUrls },
  };
}

/** 批量删除文章 */
export async function deleteArticles({ ids = [], withMedia = false, keepUrlRecords = false }) {
  const list = [...new Set(ids.map((v) => String(v || '').trim()).filter(Boolean))];
  if (!list.length) throw badRequest('需要提供 ids 数组');
  if (list.length > 200) throw badRequest(`单次最多删除 200 篇（当前 ${list.length}）`);

  const deleted = [];
  const failed = [];
  let mediaRemoved = 0;
  let mediaKept = 0;
  let freedBytes = 0;
  let removedUrls = 0;

  for (const id of list) {
    try {
      const result = await deleteArticle({ id, withMedia, keepUrlRecords });
      deleted.push(id);
      removedUrls += result.database?.removedUrls || 0;
      if (result.media) {
        mediaRemoved += result.media.removed;
        mediaKept += result.media.keptBecauseShared || 0;
        freedBytes += result.media.freedBytes || 0;
      }
    } catch (err) {
      failed.push({ id, code: err.code || 'error', message: err.message });
    }
  }

  return {
    requested: list.length,
    deleted: deleted.length,
    failed,
    media: withMedia ? { removed: mediaRemoved, keptBecauseShared: mediaKept, freedBytes } : null,
    database: { removedUrls },
  };
}

/**
 * 清理「孤儿」图床文件：一次扫描所有文章，把没有任何文章引用的文件删掉。
 * 适合在批量删除文章之后跑一次，或者定期回收磁盘。
 */
export async function gcOrphanMedia({ dryRun = false } = {}) {
  const referenced = await articleStore.referencedMediaHashes();
  const liveFiles = await articleStore.referencedMediaFiles();
  const all = mediaStore.list({ limit: Number.MAX_SAFE_INTEGER });

  /**
   * folder 布局的记录带归属文章（articleId）：只要还有文章引用这个**文件路径**就不算孤儿。
   * 不能退回 hash 判断 —— 两篇文章可能有内容完全相同的图（同 hash 各存一份），
   * 只要有一篇还在用这个 hash，另一篇留下的副本就会被误判成"仍被引用"而永远清不掉。
   * flat 布局没有归属，本来就是跨文章共用的，按内容 hash 判断。
   */
  const isOrphan = (item) => (item.articleId ? !liveFiles.has(item.file) : !referenced.has(item.hash));
  const orphans = all.items.filter(isOrphan);
  const orphanBytes = orphans.reduce((acc, item) => acc + (item.bytes || 0), 0);

  if (dryRun) {
    return {
      dryRun: true,
      totalFiles: all.total,
      referencedFiles: referenced.size,
      orphanFiles: orphans.length,
      orphanBytes,
      samples: orphans.slice(0, 10).map((item) => ({ file: item.file, bytes: item.bytes, sourceUrl: item.sourceUrl })),
    };
  }

  const result = await mediaStore.removeManyFiles(orphans.map((item) => item.file));
  log.info('孤儿图床文件已清理', { ...result, referenced: referenced.size });
  return {
    dryRun: false,
    totalFiles: all.total,
    referencedFiles: referenced.size,
    removed: result.removed,
    freedBytes: result.freedBytes,
  };
}

/** 删除单个图床文件；被文章引用时默认拒绝，force=true 才强删 */
export async function deleteMedia({ ref, force = false }) {
  const record = mediaStore.findByRef(ref);
  if (!record) throw notFound(`图床里没有这个文件: ${ref}`);

  // folder 布局的记录归某一篇文章独有：判断"还在用吗"要看那篇文章的正文是否真的引用了这个文件。
  // 不能只看内容 hash —— 同内容的另一份副本属于别的文章，删掉这份并不会影响它。
  const owner = record.p ? await articleStore.getMeta(record.p).catch(() => null) : null;
  const inUse = owner
    ? (owner.media || []).some((m) => m?.file === record.f)
    : (await articleStore.referencedMediaHashes()).has(record.h);

  if (inUse && !force) {
    const users = [];
    if (owner) {
      users.push({ id: record.p, title: owner.title || '' });
    } else {
      for (const item of (await articleStore.list({ limit: Number.MAX_SAFE_INTEGER })).items) {
        const meta = await articleStore.getMeta(item.id).catch(() => null);
        if ((meta?.media || []).some((m) => m?.hash === record.h)) users.push({ id: item.id, title: item.title });
        if (users.length >= 5) break;
      }
    }
    const err = badRequest(
      `该文件仍被 ${users.length || '若干'} 篇文章引用，删除会让它们的图片链接失效；确认要删请带 force=1`,
      { file: record.f, articles: users },
    );
    err.status = 409;
    err.code = 'media_in_use';
    throw err;
  }

  const result = await mediaStore.removeFile(record.f);
  return { ...result, forced: Boolean(force && inUse) };
}
