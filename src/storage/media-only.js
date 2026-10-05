/**
 * 「只下载视频图片」模式（API 参数 mediaOnly=1）专用的媒体存储。
 *
 * 与主图床完全分开：文件落在 config.mediaOnly.dir（默认与 DATA_DIR 同级的大文件夹），
 * 索引也单独一份，删/清不影响主图床，方便单独挂载、同步或整体清理。
 */
import path from 'node:path';
import { config } from '../config.js';
import { MediaStore } from './media.js';

let store = null;

/** 懒加载：第一次用到时才建目录、（重新）读索引 */
export async function mediaOnlyStore() {
  if (store) return store;
  store = new MediaStore({
    dir: config.mediaOnly.dir,
    // 索引放在 DATA_DIR 里，别放进会被静态服务暴露的目录
    indexPath: path.join(config.data.dir, 'media-only-index.ndjson'),
    urlPrefix: '/media-only',
  });
  await store.init();
  return store;
}

/** 供 /healthz 与日志展示 */
export function mediaOnlyDir() {
  return config.mediaOnly.dir;
}
