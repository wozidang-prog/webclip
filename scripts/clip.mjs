#!/usr/bin/env node
/**
 * 命令行抓取工具：不用起服务也能把网页转成 Markdown。
 *
 *   node scripts/clip.mjs https://example.com/post
 *   node scripts/clip.mjs https://example.com/post --engine fetch --out post.md
 *   node scripts/clip.mjs https://example.com/post --no-video --image-mode remote --json meta.json
 *
 * 参数会映射到 convertUrl 的同名选项（见 README「请求选项」）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { config } from '../src/config.js';
import { convertUrl } from '../src/pipeline/convert.js';
import { mediaStore } from '../src/storage/media.js';
import { articleStore } from '../src/storage/articles.js';
import { browserPool } from '../src/browser/pool.js';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const [rawKey, inlineValue] = token.slice(2).split('=');
    const key = rawKey.replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
    if (inlineValue !== undefined) {
      args[key] = inlineValue;
    } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
      args[key] = argv[i + 1];
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function usage() {
  console.log(`用法: node scripts/clip.mjs <url> [选项]

选项:
  --engine <browser|fetch>   抓取引擎（默认 browser）
  --image-mode <local|remote|none>  媒体处理方式（默认 local）
  --out <file.md>            写入 Markdown 文件（默认打印到 stdout）
  --json <file.json>         同时写入完整元数据 JSON
  --no-video / --no-images   不保存视频 / 图片
  --no-scroll                不自动滚动
  --keep-ads                 关闭广告过滤
  --wait-selector <css>      等待选择器
  --wait-ms <n>              额外等待毫秒
  --limit <n>                单页最多保存媒体数
  --cookies <string>         Cookie
  --timeout <ms>             超时
  --quiet                    只输出 Markdown
`);
}

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h || args._.length === 0) {
  usage();
  process.exit(args._.length === 0 ? 1 : 0);
}

const url = args._[0];

const options = {
  engine: args.engine || 'browser',
  imageMode: args.imageMode || args.mediaMode || 'local',
  includeVideos: args.noVideo ? false : true,
  includeImages: args.noImages ? false : true,
  filterAds: args.keepAds ? false : true,
  scroll: args.noScroll ? false : undefined,
  waitSelector: typeof args.waitSelector === 'string' ? args.waitSelector : undefined,
  waitMs: args.waitMs ? Number(args.waitMs) : undefined,
  maxMediaFiles: args.limit ? Number(args.limit) : undefined,
  timeoutMs: args.timeout ? Number(args.timeout) : undefined,
  cookies: typeof args.cookies === 'string' ? args.cookies : undefined,
  frontmatter: args.frontmatter === 'false' ? false : true,
};

await mediaStore.init();
await articleStore.init();

try {
  const started = Date.now();
  const result = await convertUrl(url, { ...options, store: Boolean(args.json) });
  const elapsed = Date.now() - started;

  if (args.out) {
    const outPath = path.resolve(args.out);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, result.markdown || '', 'utf8');
  } else {
    process.stdout.write(result.markdown || '');
  }

  if (args.json) {
    const jsonPath = path.resolve(args.json);
    await fs.mkdir(path.dirname(jsonPath), { recursive: true });
    await fs.writeFile(
      jsonPath,
      JSON.stringify({ ...result, markdown: undefined }, null, 2),
      'utf8',
    );
  }

  if (!args.quiet) {
    const s = result.stats || {};
    const m = s.media || {};
    console.error('');
    console.error(`✔ ${result.title}`);
    console.error(
      `  ${result.finalUrl} · ${s.words} 字 · 媒体 ${result.media.length}（下载 ${m.saved} / 缓存 ${m.reusedFromCache} / 捕获 ${m.reusedFromCapture}）· 拦截广告请求 ${s.adsBlocked} · ${elapsed}ms`,
    );
    console.error(`  下载文件名 ${result.filename}${args.out ? `（实际写入 ${path.resolve(args.out)}）` : ''}`);
    if (args.out) console.error(`  已写入 ${path.resolve(args.out)}`);
    if (args.json) console.error(`  元数据 ${path.resolve(args.json)}`);
    for (const warning of result.warnings || []) console.error(`  ⚠ ${warning}`);
    for (const failure of (result.mediaFailures || []).slice(0, 5)) {
      console.error(`  ⚠ 媒体失败 ${failure.url} (${failure.reason})`);
    }
    if (result.media.length) {
      console.error(`  图床目录 ${config.data.mediaDir}`);
    }
  }
} catch (err) {
  console.error(`✖ ${err.message}`);
  if (err.details) console.error(`  ${JSON.stringify(err.details)}`);
  process.exitCode = 1;
} finally {
  await browserPool.close().catch(() => {});
  await mediaStore.flush();
}
