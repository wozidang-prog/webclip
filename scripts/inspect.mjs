#!/usr/bin/env node
/**
 * 抓取诊断工具：打开一个网址，告诉你"媒体为什么没抓到 / 正文为什么是空的"。
 *
 *   node scripts/inspect.mjs https://example.com/post
 *   node scripts/inspect.mjs <url> --no-scroll --wait-ms 3000 --wait-selector article
 *
 * 输出四段：
 *   1. 网络层：拦截的请求、捕获到的图片字节
 *   2. 页面 DOM：img / video / picture / 自定义播放器元素 的属性分布
 *   3. 懒加载扶正后：还有多少 img 没有可用 src
 *   4. 抽取结果：正文长度与媒体本地化统计
 */
import process from 'node:process';
import { browserPool } from '../src/browser/pool.js';
import { fixLazyMediaInPage } from '../src/browser/lazyload.js';
import { extractArticle } from '../src/pipeline/extract.js';
import { collectMediaTargets, localizeMedia, normalizeMediaAttributes } from '../src/pipeline/media.js';
import { mediaStore } from '../src/storage/media.js';
import { config } from '../src/config.js';
import { isInlinePlaceholder } from '../src/utils/text.js';

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith('--'));
const flag = (name, def = false) => {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return def;
  const [, value] = hit.split('=');
  return value === undefined ? true : value;
};

if (!url) {
  console.error('用法: node scripts/inspect.mjs <url> [--no-scroll] [--wait-ms 2000] [--wait-selector CSS] [--engine fetch]');
  process.exit(1);
}

const engine = flag('engine', 'browser');
const scroll = flag('no-scroll') ? false : true;
const waitMs = Number(flag('wait-ms', 0)) || 0;
const waitSelector = flag('wait-selector', '') || '';

// 在页面里统计媒体元素，尽量覆盖各种自定义播放器写法
function collectDomFacts() {
  const info = (el, attrs) => {
    const out = {};
    for (const a of attrs) {
      const v = el.getAttribute(a);
      if (v) out[a] = v.length > 160 ? `${v.slice(0, 160)}…(${v.length})` : v;
    }
    return out;
  };
  const imgs = [...document.querySelectorAll('img')];
  const videos = [...document.querySelectorAll('video')];
  const sources = [...document.querySelectorAll('source')];
  const iframes = [...document.querySelectorAll('iframe')];
  const customPlayers = [...document.querySelectorAll('*')].filter((el) =>
    /video|player|media|xg-|artplayer|dplayer|prism/i.test(el.tagName) && el.tagName.includes('-'),
  );
  const bg = [...document.querySelectorAll('[style*="background-image"]')].length;

  const srcKinds = (list, attr) => {
    const kinds = {};
    for (const el of list) {
      const v = el.getAttribute(attr) || '';
      const kind = !v
        ? '(空)'
        : v.startsWith('data:')
          ? 'data:URI'
          : v.startsWith('blob:')
            ? 'blob:'
            : /^https?:/.test(v)
              ? 'http(s)'
              : '相对路径';
      kinds[kind] = (kinds[kind] || 0) + 1;
    }
    return kinds;
  };

  return {
    counts: {
      img: imgs.length,
      video: videos.length,
      source: sources.length,
      iframe: iframes.length,
      'bg-image': bg,
      customPlayers: customPlayers.length,
      canvas: document.querySelectorAll('canvas').length,
      script: document.querySelectorAll('script').length,
    },
    imgSrc: srcKinds(imgs, 'src'),
    imgDataSrc: srcKinds(imgs, 'data-src'),
    imgSrcset: imgs.filter((i) => i.getAttribute('srcset')).length,
    imgSamples: imgs.slice(0, 6).map((i) => info(i, ['src', 'data-src', 'data-original', 'srcset', 'class'])),
    videoSamples: videos.slice(0, 5).map((v) => info(v, ['src', 'poster', 'class', 'id'])),
    sourceSamples: sources.slice(0, 6).map((s) => ({ tag: s.parentElement?.tagName, ...info(s, ['src', 'type', 'srcset']) })),
    customPlayerSamples: customPlayers.slice(0, 8).map((el) => ({
      tag: el.tagName.toLowerCase(),
      ...info(el, ['src', 'data-src', 'poster', 'vid', 'data-vid', 'class']),
      html: el.outerHTML.slice(0, 200),
    })),
    iframeSamples: iframes.slice(0, 5).map((f) => info(f, ['src', 'class'])),
    bodyTextLength: (document.body?.innerText || '').length,
  };
}

console.log(`URL: ${url}\n引擎: ${engine}  滚动: ${scroll}  waitMs: ${waitMs}  waitSelector: ${waitSelector || '-'}\n`);

let html = '';
let finalUrl = url;
let capture = new Map();
let cookies = '';
let shotStats = {};

if (engine === 'browser') {
  const beforeFix = await browserPool.withPage(
    async (page, context) => {
      const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.browser.navigationTimeoutMs });
      if (waitSelector) await page.waitForSelector(waitSelector, { timeout: 20000 }).catch(() => {});
      if (waitMs) await page.waitForTimeout(waitMs);
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

      if (scroll) {
        await page.evaluate(async (steps) => {
          await new Promise((resolve) => {
            let n = 0;
            const step = () => {
              window.scrollBy(0, Math.max(window.innerHeight * 0.9, 500));
              n += 1;
              if (n >= steps) {
                window.scrollTo(0, 0);
                resolve();
                return;
              }
              setTimeout(step, 300);
            };
            step();
          });
        }, config.browser.scrollSteps);
      }

      const factsBefore = await page.evaluate(collectDomFacts);
      const fixed = await page.evaluate(fixLazyMediaInPage);
      await page.waitForTimeout(Math.max(config.browser.settleMs, 800));
      const factsAfter = await page.evaluate(collectDomFacts);

      finalUrl = page.url();
      html = await page.content();
      cookies = await context
        .cookies()
        .then((l) => l.map((c) => `${c.name}=${c.value}`).join('; '))
        .catch(() => '');
      return { factsBefore, factsAfter, fixed, status: res?.status(), title: await page.title() };
    },
    { capture, onStats: (s) => (shotStats = s) },
  );

  console.log('【1】网络层');
  console.log(`  HTTP ${beforeFix.status} · 标题 ${JSON.stringify(beforeFix.title)}`);
  console.log(`  拦截广告/追踪请求: ${shotStats.blocked} · 捕获图片字节: ${shotStats.captured}（跳过超大 ${shotStats.skippedLarge}）`);
  console.log(`  捕获字节总量: ${Math.round((shotStats.captureBytes || 0) / 1024)} KB\n`);

  console.log('【2】懒加载扶正前 DOM');
  console.log(JSON.stringify(beforeFix.factsBefore, null, 2).split('\n').map((l) => `  ${l}`).join('\n'));
  console.log(`\n【3】懒加载扶正（修复 ${beforeFix.fixed?.fixed ?? 0} 处）后的 DOM`);
  console.log(JSON.stringify(beforeFix.factsAfter, null, 2).split('\n').map((l) => `  ${l}`).join('\n'));
} else {
  const { downloadBuffer } = await import('../src/utils/net.js');
  const { decodeHtmlBuffer } = await import('../src/utils/http.js');
  const res = await downloadBuffer(url, { maxBytes: 16 * 1024 * 1024, timeoutMs: config.fetch.timeoutMs });
  html = decodeHtmlBuffer(res.buffer, res.mime);
  finalUrl = res.finalUrl;
  console.log(`【1】HTTP ${res.status} · ${res.mime} · ${res.buffer.length} bytes\n`);
}

console.log(`\n最终 URL: ${finalUrl}`);
console.log(`HTML 长度: ${html.length}\n`);

const extracted = extractArticle({ html, url: finalUrl });
console.log('【4】正文抽取');
console.log(`  标题: ${extracted.article.title}`);
console.log(`  正文纯文本: ${extracted.article.textContent.length} 字 · readability=${extracted.article.readabilityOk} · 清洗模式=${extracted.article.mode}`);
console.log(`  清洗统计: ${JSON.stringify(extracted.stats)}`);

const root = extracted.root;
const promoted = normalizeMediaAttributes(root);
const targets = collectMediaTargets(root, {});
console.log(`\n【5】清洗后正文里的媒体`);
console.log(`  normalizeMediaAttributes 修正 ${promoted} 处 · 收集到 ${targets.size} 个媒体目标`);
for (const t of [...targets.values()].slice(0, 15)) {
  console.log(`  - [${t.kind}] ${t.url.slice(0, 120)}${t.alt ? `  alt=${t.alt}` : ''}`);
}
const inlineLeft = [...root.querySelectorAll('img[src]')].filter((i) => isInlinePlaceholder(i.getAttribute('src'))).length;
console.log(`  正文里仍是占位/data URI 的 img: ${inlineLeft}`);

await mediaStore.init();
const report = await localizeMedia({
  document: root,
  pageUrl: finalUrl,
  store: mediaStore,
  capture,
  cookie: cookies,
  mode: 'local',
  includeVideos: true,
  includeAudio: true,
});
console.log(`\n【6】媒体本地化`);
console.log(`  ${JSON.stringify(report.stats)}`);
for (const f of report.failures.slice(0, 12)) {
  console.log(`  ✖ ${f.reason} · ${String(f.url).slice(0, 110)}${f.message ? ` (${f.message})` : ''}`);
}

await browserPool.close().catch(() => {});
await mediaStore.flush();
process.exit(0);
