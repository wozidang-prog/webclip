/**
 * 构建信息：用来回答"我容器里跑的到底是哪一版"。
 *
 * 背景：NAS 上改完代码却忘了重建镜像、或 `up -d` 没带 `--build`，是排查时最容易踩的坑
 * （现象就是"某些链接还是不行"）。镜像构建时 Dockerfile 会写入 /app/BUILD_TIME，
 * 本地直接跑源码时则退回去看 src 下最新的修改时间。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

/** src 目录下最新的修改时间（递归一层层看，文件不多，启动时扫一次足够） */
function newestSourceMtime(dir, depth = 0) {
  let newest = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < 3) newest = Math.max(newest, newestSourceMtime(full, depth + 1));
      continue;
    }
    try {
      newest = Math.max(newest, fs.statSync(full).mtimeMs);
    } catch {
      /* 单个文件读不到就跳过 */
    }
  }
  return newest;
}

let cached = null;

export function buildInfo({ refresh = false } = {}) {
  if (cached && !refresh) return cached;

  const stampFile = path.join(ROOT, 'BUILD_TIME');
  try {
    const at = fs.readFileSync(stampFile, 'utf8').trim();
    if (at) {
      cached = { source: 'image', at };
      return cached;
    }
  } catch {
    /* 不是镜像里跑的（本地开发常见），走下面的源码时间 */
  }

  const mtime = newestSourceMtime(path.join(ROOT, 'src'));
  cached = {
    source: 'source',
    at: mtime ? new Date(mtime).toISOString() : '',
  };
  return cached;
}