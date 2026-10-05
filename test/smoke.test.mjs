/**
 * 端到端冒烟测试（不需要外网）：
 *   1. 本地起一个"带广告的博客页面"夹具站点
 *   2. 用 fetch 引擎跑完整流程：抓取 → 过滤 → Markdown → 本地图床
 *   3. 启动 Express 应用，验证 REST 接口与 /media 静态服务
 *   4. 若设置 TEST_BROWSER=1，则额外验证无头 Chromium 引擎
 *
 * 运行：npm test
 * 带浏览器：$env:TEST_BROWSER='1'; $env:BROWSER_CHANNEL='chrome'; npm test   （Windows）
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';
import fs from 'node:fs/promises';
import path from 'node:path';

/* ---------------- 环境准备（必须在导入 src 之前） ---------------- */

const TMP_ROOT = path.join(process.cwd(), '.tmp-test');
await fs.rm(TMP_ROOT, { recursive: true, force: true });
await fs.mkdir(TMP_ROOT, { recursive: true });

async function reservePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const apiPort = await reservePort();

process.env.ALLOW_PRIVATE_NETWORK = 'true';
process.env.DATA_DIR = path.join(TMP_ROOT, 'data');
process.env.PUBLIC_BASE_URL = `http://127.0.0.1:${apiPort}`;
process.env.LOG_LEVEL = process.env.TEST_VERBOSE === '1' ? 'debug' : 'warn';
process.env.BROWSER_WARMUP = '0';
process.env.CONVERT_CONCURRENCY = '2';
// 站点 Cookie 配置（必须在导入 src 之前设好：config 在导入时读取环境变量）
process.env.DOUYIN_COOKIE = 'douyin_session=dy-test';
process.env.XIAOHONGSHU_COOKIE = 'web_session=xhs-test';
process.env.SITE_COOKIES = JSON.stringify({ 'example.com': 'ex=1', 'sub.test': 'st=1' });

/* ---------------- PNG 生成（避免依赖外部图片） ---------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

function makePng(width, height, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const p = rowStart + 1 + x * 3;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const PHOTO = makePng(24, 16, [80, 140, 255]);
const SECOND = makePng(16, 24, [40, 200, 120]);
const THIRD = makePng(12, 12, [230, 120, 60]);
const FOURTH = makePng(30, 20, [120, 80, 200]);
const FIFTH = makePng(3, 3, [10, 10, 10]);
const PLACEHOLDER_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');

/* ---------------- 夹具站点（模拟真实博客 + 广告） ---------------- */

const ARTICLE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>测试文章：无头浏览器抓取 | 示例站</title>
  <meta property="og:title" content="测试文章：无头浏览器抓取">
  <meta name="author" content="张三">
  <meta property="article:published_time" content="2024-05-06T07:08:09Z">
  <meta name="description" content="这是一篇用于验证抓取流水线的测试文章。">
  <link rel="stylesheet" href="/style.css">
  <script src="/ad.js"></script>
  <script>document.write('<div id="scriptjunk">SCRIPTJUNK</div>')</script>
  <style>.hidden-ad { display: none }</style>
</head>
<body>
  <header class="site-header"><a href="/">首页</a><nav class="main-nav">NAVJUNK 导航</nav></header>

  <div class="ad-container" id="ad-top"><span>ADVERTISEMENT CLICK HERE</span></div>
  <ins class="adsbygoogle" data-ad-client="ca-pub-1234567890"></ins>
  <div class="newsletter-signup">SUBSCRIBEJUNK 订阅我们的邮件</div>
  <div class="cookie-consent">COOKIEJUNK 我们使用 Cookie</div>

  <aside class="sidebar-widget"><h3>热门推荐</h3><ul><li><a href="/1">SIDEBARJUNK</a></li></ul></aside>

  <main>
    <article class="post-content">
      <h1>测试文章：无头浏览器抓取</h1>
      <p>第一段正文内容，用来验证正文抽取是否保留有效信息。这一段应当完整出现在 Markdown 中。</p>
      <figure>
        <img src="/img/placeholder.gif" data-src="/img/photo.png" alt="示例配图" width="480" height="320">
        <figcaption>图注文字：这是一张配图</figcaption>
      </figure>
      <p>第二段正文内容，包含一个<a href="https://example.com/ref">外部链接</a>与<strong>加粗文字</strong>。</p>
      <h2><a href="#anchor-jie">小节标题</a></h2>
      <ul><li>列表项一</li><li>列表项二</li></ul>
      <img src="/img/placeholder.gif" srcset="/img/placeholder.gif 1x, /img/second.png 2x" alt="响应式配图">
      <p>下面这张图没有 alt（真实站点很常见，必须保留图片语法）：</p>
      <img src="/img/third.png">
      <div class="pgc-img" style="background-image:url('/img/fourth.png'); width:480px; height:320px"></div>
      <div class="sprite-icon" style="background-image:url('/img/fifth.png'); width:16px; height:16px"></div>
      <pre><code class="language-js">const answer = 42;
console.log(answer);</code></pre>
      <table>
        <thead><tr><th>字段</th><th>说明</th></tr></thead>
        <tbody><tr><td>url</td><td>目标网址</td></tr><tr><td>engine</td><td>抓取引擎</td></tr></tbody>
      </table>
      <img src="/track/pixel.png" width="1" height="1" alt="">
      <iframe src="https://ads.example.com/frame.html" width="300" height="250"></iframe>
      <iframe src="https://www.youtube.com/embed/abc123" width="560" height="315" title="演示视频"></iframe>
      <div class="tt-video-box xgplayer" data-poster="/img/fourth.png">
        <video src="/media/clip.mp4" poster="/img/photo.png" controls></video>
        <div class="xgplayer-controls"><span class="xgplayer-play">暂停</span><span class="xgplayer-time">00:09 / 00:25</span></div>
        <xg-prompt class="xgplayer-prompt">点击按住可拖动视频</xg-prompt>
      </div>
    </article>

    <section class="related-posts">
      <h2>Related Posts</h2>
      <ul><li><a href="/a">RELATEDJUNK A</a></li><li><a href="/b">RELATEDJUNK B</a></li><li><a href="/c">RELATEDJUNK C</a></li></ul>
    </section>
    <div class="social-share">SHAREJUNK 分享到微博</div>
    <div id="comments" class="comments-area"><h2>Comments</h2><p>COMMENTJUNK 第一条评论</p></div>
  </main>

  <footer class="site-footer">FOOTERJUNK 版权所有</footer>
</body>
</html>`;

/** 模拟微信"图片消息"：正文里没有 <img>，图片地址只在 <script> 的数据里 */
function galleryHtml(origin) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>图片消息测试</title>
  <meta property="og:title" content="图片消息测试">
  <meta property="og:description" content="第一段描述文案\\x0a\\x0a第二段描述文案">
</head>
<body>
  <div id="app"><h1>图片消息测试</h1><div id="img_list"></div></div>
  <script>
    window.__DATA__ = {
      picture_page_info_list: [
        { cdn_url: '${origin}/img/photo.png?wx_fmt=jpeg' },
        { cdn_url: '${origin}/img/second.png' },
        { cdn_url: '${origin}/img/third.png' },
        { cdn_url: '${origin}/img/fourth.png' },
        { cdn_url: '${origin}/img/photo-copy.png' }
      ],
      round_head_img: '${origin}/img/avatar-icon.png',
      track_pixel: 'https://hm.baidu.com/track.png',
      noise_url: '${origin}/img/logo-badge.png'
    };
    var escaped = '${origin.replace('http:', 'http:\\/\\/').replace('http:\\/\\/', 'http://')}/img/fifth.png';
    window.__VIDEO__ = { play_url: '${origin}/media/clip.mp4' };
  </script>
</body>
</html>`;
}

/** 标题里带 "......"（头条这类标题很常见）——曾经因为 id 检查太粗暴而整次转换 400 */
function dottedTitleHtml() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>1993年上海 看看以前的老西門是否和记忆中...... - 今日头条</title>
<meta property="og:title" content="1993年上海 看看以前的老西門是否和记忆中...... - 今日头条">
<meta name="description" content="带省略号的标题测试。">
</head><body><article class="post-content">
<h1>1993年上海 看看以前的老西門是否和记忆中...... - 今日头条</h1>
<p>这是一篇标题里带连续省略号的文章，用来验证文章 id 不会因为标题里的点而变成非法。</p>
<p>第二段正文内容，确保正文抽取有足够长度，不会退化成描述兜底。</p>
</article></body></html>`;
}

/** 同一个网址、正文会变的页面（用 utm_ 参数控制内容，规范化后 URL 相同） */
function mutableHtml(version) {
  const body =
    version === '2'
      ? '第二版正文：内容已经更新了，多了一段全新的说明文字，用来验证指纹能识别变化。'
      : '第一版正文：这是初始内容，用来验证重复抓取时会被判定为未变化。';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>会变的文章 - 示例站</title>
<meta property="og:title" content="会变的文章">
<meta property="og:site_name" content="示例站">
</head><body><article class="post-content">
<h1>会变的文章</h1>
<p>${body}</p>
<p>这里是固定的一段说明文字，两版都一样，确保正文长度足够、不会走描述兜底。</p>
<img src="/img/mutable.png" alt="配图">
</article></body></html>`;
}

/** 数据库功能测试专用页面：带一张图，正文可用 utm_v 切换 */
function dbArticleHtml(version) {
  const body =
    version === '2'
      ? '第二版正文：内容已经更新了，多了一段全新的说明文字，用来验证指纹能识别变化。'
      : '第一版正文：这是初始内容，用来验证重复抓取时会被判定为未变化。';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>网址记录测试 - 示例站</title>
<meta property="og:title" content="网址记录测试">
<meta property="og:site_name" content="示例站">
</head><body><article class="post-content">
<h1>网址记录测试</h1>
<p>${body}</p>
<p>这里是固定的一段说明文字，两版都一样，确保正文长度足够、不会走描述兜底。</p>
<img src="/db-image.png" alt="配图">
</article></body></html>`;
}

/** webhook 桩收到的通知（用例里断言用） */
const webhookCalls = [];

/** 自建小红书解析器桩收到的请求（用例里断言契约用） */
const xhsApiCalls = [];

const fixtureServer = http.createServer((req, res) => {  const url = new URL(req.url, 'http://127.0.0.1');
  const send = (status, type, body, extra = {}) => {
    res.writeHead(status, { 'content-type': type, ...extra });
    res.end(body);
  };
  const origin = `http://127.0.0.1:${fixtureServer.address().port}`;
  switch (url.pathname) {
    case '/':
    case '/article':
      return send(200, 'text/html; charset=utf-8', ARTICLE_HTML);
    case '/gallery':
      return send(200, 'text/html; charset=utf-8', galleryHtml(origin));
    case '/dotted':
      return send(200, 'text/html; charset=utf-8', dottedTitleHtml());
    case '/db-article':
      // 数据库相关测试专用地址，避免和其它用例互相干扰
      return send(200, 'text/html; charset=utf-8', dbArticleHtml(url.searchParams.get('v') || url.searchParams.get('utm_v') || '1'));
    case '/db-image.png':
      return send(200, 'image/png', PHOTO, { 'content-length': String(PHOTO.length) });
    case '/mutable':
      // 用 utm_ 参数（会被规范化掉）来控制正文内容：同一个"规范化 URL"、不同正文
      return send(200, 'text/html; charset=utf-8', mutableHtml(url.searchParams.get('v') || url.searchParams.get('utm_v') || '1'));
    case '/img/photo.png':
      return send(200, 'image/png', PHOTO, { 'content-length': String(PHOTO.length) });
    case '/img/photo-copy.png':
      // 同一份内容、不同地址（模拟字节跳动那种多 CDN 同文件）
      return send(200, 'image/png', PHOTO, { 'content-length': String(PHOTO.length) });
    case '/img/mutable.png':
      return send(200, 'image/png', FOURTH, { 'content-length': String(FOURTH.length) });
    case '/img/cdn':
      /**
       * 模拟小红书 CDN（ci.xiaohongshu.com）：
       * **认得 `?imageView2/format/png` 才给转好的 PNG，认不出就原样返回上传时的 HEIC**。
       * 用来盯住"规范化 URL 时把 CDN 指令编码坏、结果存下打不开的 HEIC"这个坑。
       */
      if (/imageView2\/format\/png/.test(url.search || '')) {
        return send(200, 'image/png', PHOTO, { 'content-length': String(PHOTO.length) });
      }
      return send(200, 'image/heic', Buffer.from('00000024667479706865696300000000', 'hex'));
    case '/img/second.png':
      return send(200, 'image/png', SECOND);
    case '/img/third.png':
      return send(200, 'image/png', THIRD);
    case '/img/fourth.png':
      return send(200, 'image/png', FOURTH);
    case '/img/fifth.png':
      return send(200, 'image/png', FIFTH);
    case '/img/placeholder.gif':
      return send(200, 'image/gif', PLACEHOLDER_GIF);
    case '/track/pixel.png':
      return send(200, 'image/png', PLACEHOLDER_GIF);
    case '/media/clip.mp4':
      return send(200, 'video/mp4', Buffer.alloc(4096, 7));
    case '/webhook':
      // 接收 webhook 通知的桩：把 body 收集起来供用例断言
      // 群晖 Chat 那种表单编码（payload=<JSON>）也要能解出来
      return void (() => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          const type = String(req.headers['content-type'] || '');
          let body = null;
          try {
            if (type.includes('x-www-form-urlencoded')) {
              const params = new URLSearchParams(raw);
              body = { __form: true, payload: JSON.parse(params.get('payload') || 'null') };
            } else {
              body = JSON.parse(raw);
            }
          } catch {
            body = null;
          }
          webhookCalls.push({ headers: req.headers, body, raw, contentType: type });
          send(200, 'application/json', '{"success":true}');
        });
      })();
    case '/xhs/detail':
      /**
       * 自建小红书解析器桩（模拟 XHS-Downloader 的 /xhs/detail）。
       * 故意把真实实现实测到的几个坑都复现出来：
       *   · 只收 POST JSON {url}：GET → 405，缺 url → 422
       *   · 认不出链接 → 200 +「提取小红书作品链接失败」+ data:null
       *   · 作品取不到 → 200 + data:{}（**空对象**，不能用真假判断当成功）
       */
      return void (() => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let body = null;
          try {
            body = JSON.parse(raw);
          } catch {
            body = null;
          }
          xhsApiCalls.push({ method: req.method, contentType: String(req.headers['content-type'] || ''), body, raw });
          if (req.method !== 'POST') {
            return send(405, 'application/json', '{"detail":"Method Not Allowed"}');
          }
          if (!body?.url) {
            return send(422, 'application/json', '{"detail":[{"type":"missing","loc":["body","url"]}]}');
          }
          if (!/xiaohongshu\.com/.test(body.url)) {
            return send(
              200,
              'application/json',
              JSON.stringify({ message: '提取小红书作品链接失败', params: body, data: null }),
            );
          }
          if (body.url.includes('missing')) {
            return send(200, 'application/json', JSON.stringify({ message: '获取小红书作品数据失败', params: body, data: {} }));
          }
          if (body.url.includes('short-title')) {
            // 实测案例：作品标题只有两个字「龙湾」——曾经被 4 字下限误判成占位标题
            return send(
              200,
              'application/json',
              JSON.stringify({
                message: '获取小红书作品数据成功',
                params: body,
                data: {
                  作品ID: '6a9ec6a10000000026019ad1',
                  作品类型: '图文',
                  作品标题: '龙湾',
                  作品描述: '两个字标题的笔记',
                  作者昵称: '再眯一会',
                  发布时间: '2026-09-18_11:20:00',
                  下载地址: [`${origin}/img/photo.png`],
                },
              }),
            );
          }
          if (body.url.includes('notitle')) {
            // 真实案例：图文笔记可以没有标题，但有发布时间 —— 标题应退化成"作品发布日期"
            return send(
              200,
              'application/json',
              JSON.stringify({
                message: '获取小红书作品数据成功',
                params: body,
                data: {
                  作品ID: '6aaa07f90000000028000fdd',
                  作品类型: '图文',
                  作品标题: '',
                  作品描述: '#人类高质量睡眠[话题]# 真的是越上年纪睡眠时间越少吗',
                  作者昵称: 'Y_Y',
                  发布时间: '2026-09-16_03:07:37',
                  下载地址: [`${origin}/img/photo.png`],
                },
              }),
            );
          }
          if (body.url.includes('video-note')) {
            return send(
              200,
              'application/json',
              JSON.stringify({
                message: '获取小红书作品数据成功',
                params: body,
                data: {
                  作品ID: '68f0videonote',
                  作品类型: '视频',
                  作品标题: '解析器给的视频标题',
                  作品描述: '解析器给的视频正文',
                  作者昵称: '解析器作者',
                  视频封面: 'https://sns-img-bd.xhscdn.com/cover-note',
                  下载地址: [
                    'https://sns-video-bd.xhscdn.com/stream/110/259/01e8video.mp4',
                    'https://sns-img-bd.xhscdn.com/cover-note',
                  ],
                },
              }),
            );
          }
          return send(
            200,
            'application/json',
            JSON.stringify({
              message: '获取小红书作品数据成功',
              params: body,
              data: {
                作品ID: '6aad17f90000000026023c7d',
                作品类型: '图文',
                作品标题: '解析器给的标题',
                作品描述: '解析器给的正文',
                作者昵称: '解析器作者',
                // 指向测试夹具：这样"只走解析器"的整条链路（含图片落图床）都能离线跑。
                // 第一条带小红书那种 `?imageView2/format/png` 指令，验证下载时不会被编码坏。
                下载地址: [`${origin}/img/cdn?imageView2/format/png`, `${origin}/img/second.png`],
              },
            }),
          );
        });
      })();
    case '/style.css':
      return send(200, 'text/css', 'body{color:#000}');
    case '/ad.js':
      return send(200, 'application/javascript', 'window.__ad=true;');
    default:
      return send(404, 'text/plain', 'not found');
  }
});

await new Promise((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve));
const fixtureBase = `http://127.0.0.1:${fixtureServer.address().port}`;

// webhook 接收桩：必须在这之前（导入 src 之前）配好，config 是导入时读环境变量的
process.env.WEBHOOK_URL = `${fixtureBase}/webhook`;

/* ---------------- 载入被测模块 ---------------- */

const { convertUrl, normalizeOptions } = await import('../src/pipeline/convert.js');
const { mediaStore } = await import('../src/storage/media.js');
const { articleStore } = await import('../src/storage/articles.js');
const { createApp } = await import('../src/server.js');
const { isBlockedUrl, looksLikeJunkToken } = await import('../src/adblock/rules.js');
const { isPrivateIP, assertUrlAllowed } = await import('../src/utils/net.js');
const { siteCookieFor, configuredCookieSites } = await import('../src/utils/cookies.js');
const { config } = await import('../src/config.js');
const { slugify } = await import('../src/utils/text.js');

await mediaStore.init();
await articleStore.init();

const app = createApp();
const apiServer = await new Promise((resolve) => {
  const srv = app.listen(apiPort, '127.0.0.1', () => resolve(srv));
});
const apiBase = `http://127.0.0.1:${apiPort}`;

after(async () => {
  await new Promise((resolve) => apiServer.close(resolve));
  await new Promise((resolve) => fixtureServer.close(resolve));
  // 必须显式关掉 Chromium，否则子进程会让事件循环一直存活
  const { browserPool } = await import('../src/browser/pool.js');
  await browserPool.close().catch(() => {});
  // SQLite 连接不关的话，Windows 上删不掉 .tmp-test 目录（EBUSY）
  const { articleDb } = await import('../src/storage/db.js');
  articleDb.close();
  await mediaStore.flush();
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

/* ---------------- 1. 规则单测 ---------------- */

test('广告域名规则命中常见广告/追踪域名', () => {
  assert.equal(isBlockedUrl('https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js', { resourceType: 'script' }), true);
  assert.equal(isBlockedUrl('https://www.googletagmanager.com/gtm.js', { resourceType: 'script' }), true);
  assert.equal(isBlockedUrl('https://cdn.taboola.com/libtrc/x.js', { resourceType: 'script' }), true);
  assert.equal(isBlockedUrl('https://hm.baidu.com/hm.js', { resourceType: 'script' }), true);
  assert.equal(isBlockedUrl('https://cdn.example.com/app.js', { resourceType: 'script' }), false);
  // 主文档永不拦截
  assert.equal(isBlockedUrl('https://pagead2.googlesyndication.com/', { resourceType: 'document' }), false);
});

test('class/id 词元判定不会误伤正常命名', () => {
  assert.equal(looksLikeJunkToken('ad-container'), true);
  assert.equal(looksLikeJunkToken('sidebar-widget'), true);
  assert.equal(looksLikeJunkToken('article-body'), false);
  assert.equal(looksLikeJunkToken('download-button'), false);
  assert.equal(looksLikeJunkToken('header-image'), false);
  assert.equal(looksLikeJunkToken('adaptive-layout'), false);
});

test('站点 Cookie 配置：抖音/小红书按域名自动注入，其它站点走 SITE_COOKIES', () => {
  // 抖音：主域、子域、分享短链都要命中
  assert.equal(siteCookieFor('https://www.douyin.com/video/123'), 'douyin_session=dy-test');
  assert.equal(siteCookieFor('https://v.douyin.com/abc'), 'douyin_session=dy-test');
  assert.equal(siteCookieFor('https://www.iesdouyin.com/share/video/123'), 'douyin_session=dy-test');
  // 小红书：主域与短链（.com 和 .cn 两个短链域名都要认）
  assert.equal(siteCookieFor('https://www.xiaohongshu.com/explore/abc'), 'web_session=xhs-test');
  assert.equal(siteCookieFor('https://xhslink.com/xyz'), 'web_session=xhs-test');
  assert.equal(siteCookieFor('https://xhslink.cn/o/VaMdRMLxyg'), 'web_session=xhs-test');
  // 自定义站点
  assert.equal(siteCookieFor('https://example.com/post/1'), 'ex=1');
  assert.equal(siteCookieFor('https://news.example.com/post/1'), 'ex=1');
  // 不匹配就什么都不注入（尤其别把别人的 Cookie 发过去）
  assert.equal(siteCookieFor('https://notexample.com/'), '');
  assert.equal(siteCookieFor('https://example.com.evil.test/'), '');
  assert.equal(siteCookieFor('https://www.zhihu.com/question/1'), '');
  assert.equal(siteCookieFor('不是 URL'), '');
  // 已配置站点清单不泄露 Cookie 内容
  const sites = configuredCookieSites();
  assert.ok(sites.includes('douyin.com') && sites.includes('xiaohongshu.com') && sites.includes('example.com'));
  assert.ok(!sites.join(' ').includes('dy-test'));
});

test('webhook 报文格式：json / text / feishu / dingtalk 各自组装正确', async () => {
  const { buildWebhookPayload, formatWebhookBody } = await import('../src/utils/webhook.js');
  const payload = buildWebhookPayload({
    title: '示例标题',
    finalUrl: 'https://example.com/a',
    media: [
      { kind: 'video', file: 'example.com/示例/01.mp4', bytes: 2 * 1048576, localUrl: 'http://h/media-only/x', localPath: '/data/x' },
      { kind: 'image', file: 'example.com/示例/02.jpg', bytes: 1024 },
    ],
    mediaOnly: { dir: '/media-only' },
    warnings: ['一条提示'],
  });

  assert.match(payload.text, /示例标题/);
  assert.match(payload.text, /视频 1 \/ 图片 1/);
  assert.equal(payload.data.count, 2);
  assert.equal(payload.data.videos, 1);
  assert.equal(payload.data.bytes, 2 * 1048576 + 1024);
  assert.equal(payload.data.files[0].localPath, '/data/x');

  const json = formatWebhookBody(payload, 'json');
  assert.equal(json.text, payload.text);
  assert.equal(json.count, 2, 'json 格式应把结构化字段摊平');

  assert.deepEqual(formatWebhookBody(payload, 'text'), { text: payload.text });
  assert.deepEqual(formatWebhookBody(payload, 'slack'), { text: payload.text });
  // 群晖 Chat：报文是表单编码的 payload=<JSON>（{"text"}），且文本里必须带可点的下载直链
  assert.deepEqual(formatWebhookBody(payload, 'synology'), { text: payload.text });
  assert.match(payload.text, /下载地址：/);
  assert.match(payload.text, /1\. 视频 2\.00MB http:\/\/h\/media-only\/x/);
  assert.ok(!payload.text.includes(']('), '不要用 markdown 链接语法，避免平台不渲染时露出原文');
  assert.deepEqual(formatWebhookBody(payload, 'feishu'), { msgtype: 'text', content: { text: payload.text } });
  assert.deepEqual(formatWebhookBody(payload, 'dingtalk'), { msgtype: 'text', text: { content: payload.text } });
  assert.deepEqual(formatWebhookBody(payload, 'wecom'), { msgtype: 'text', text: { content: payload.text } });
});

test('只下载视频图片：媒体落到独立目录、默认不落文章、并发 webhook 通知', async () => {
  const mediaOnlyDir = path.join(TMP_ROOT, 'media-only');
  assert.equal(config.mediaOnly.dir, mediaOnlyDir, '同一份 .env 下媒体目录应取 DATA_DIR 的同级目录');

  webhookCalls.length = 0;
  const before = (await fs.readdir(path.join(process.env.DATA_DIR, 'articles'))).length;

  const result = await convertUrl(`${fixtureBase}/article`, {
    engine: 'fetch',
    imageMode: 'local',
    mediaOnly: true,
  });

  // 1) 结果里给出了素材目录，并带上磁盘绝对路径（自动化需要）
  assert.equal(result.mediaOnly.dir, mediaOnlyDir);
  assert.ok(result.media.length >= 4, `应有媒体：${result.media.length}`);
  for (const item of result.media) {
    assert.ok(item.localPath?.startsWith(mediaOnlyDir), `localPath 应在素材目录下：${item.localPath}`);
    assert.ok(item.localUrl.startsWith(`${process.env.PUBLIC_BASE_URL}/media-only/`), `链接应是 /media-only：${item.localUrl}`);
  }

  // 2) 文件真的落在那棵独立的目录树里（按网站分类 + 标题文件夹）
  for (const item of result.media) {
    const stat = await fs.stat(item.localPath);
    assert.ok(stat.size > 40, `文件应存在且非空：${item.localPath}`);
  }
  assert.ok(
    result.media[0].localPath.includes(`${path.sep}127.0.0.1${path.sep}`),
    `应按网站分目录：${result.media[0].localPath}`,
  );
  // 主图床里不应出现这些文件
  assert.equal(
    mediaStore.list({ limit: 10000 }).items.filter((i) => i.file.includes('media-only')).length,
    0,
    '主图床不该混入只下载模式的文件',
  );

  // 3) 默认不落文章
  const after = (await fs.readdir(path.join(process.env.DATA_DIR, 'articles'))).length;
  assert.equal(after, before, '只下载媒体时不应新建文章目录');
  assert.equal(result.markdownUrl, null);

  // 4) webhook 收到通知，内容包含标题、数量与文件清单
  assert.ok(webhookCalls.length >= 1, '应发出 webhook 通知');
  const call = webhookCalls.at(-1);
  assert.match(call.contentType, /application\/json/, '默认 json 格式应以 JSON 发送');
  assert.equal(call.body.event, 'media.downloaded');
  assert.match(call.body.text, /媒体：共 \d+ 个/);
  assert.equal(call.body.count, result.media.length);
  assert.ok(call.body.files.length === result.media.length);
  assert.equal(result.webhook?.ok, true, `webhook 应发送成功：${JSON.stringify(result.webhook)}`);
});

test('webhook：显式 webhook=false 时不发送；普通模式默认也不发', async () => {  webhookCalls.length = 0;
  await convertUrl(`${fixtureBase}/article`, { engine: 'fetch', imageMode: 'none', mediaOnly: true, webhook: false });
  assert.equal(webhookCalls.length, 0, 'webhook=false 时不应发通知');

  await convertUrl(`${fixtureBase}/article`, { engine: 'fetch', imageMode: 'none', store: false, force: true });
  assert.equal(webhookCalls.length, 0, '普通模式默认不发通知');
});

test('webhook 自检接口：往指定地址发测试消息，并把对方响应带回来', async () => {
  webhookCalls.length = 0;
  const res = await fetch(`${apiBase}/api/webhook/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: `${fixtureBase}/webhook`, format: 'synology', text: '自定义测试文本' }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.data.ok, true, `自检应成功：${JSON.stringify(body.data)}`);
  assert.equal(body.data.status, 200);
  assert.equal(body.data.format, 'synology');
  assert.equal(body.data.url, `${fixtureBase}/webhook`);

  assert.equal(webhookCalls.length, 1, '应真的发出一次请求');
  const call = webhookCalls[0];
  // 群晖 Chat 要的是表单编码 + payload=<JSON>（直接发 JSON 会被回 407 payload empty）
  assert.match(call.contentType, /x-www-form-urlencoded/, '群晖格式应以表单编码发送');
  assert.ok(call.raw.startsWith('payload='), `原始请求体应是 payload=<JSON>：${call.raw.slice(0, 40)}`);
  assert.equal(call.body.__form, true);
  assert.deepEqual(Object.keys(call.body.payload), ['text'], 'payload 里只放 text 字段');
  assert.match(call.body.payload.text, /下载地址：/);
  assert.match(call.body.payload.text, /\/media-only\//);

  // 不可达地址应返回 ok=false 而不是抛错
  const bad = await fetch(`${apiBase}/api/webhook/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'http://127.0.0.1:1/nope', format: 'text' }),
  });
  const badBody = await bad.json();
  assert.equal(badBody.data.ok, false);
  assert.ok(badBody.data.error, '应带上失败原因');
});

test('webhook 分条：长消息按平台上限切成多条，链接不被切断', async () => {
  const { splitWebhookText, webhookTextLimit } = await import('../src/utils/webhook.js');

  const limit = webhookTextLimit('synology');
  assert.equal(limit, 1900, '群晖 Chat 的单条上限应取 1900（实测平台为 2000）');

  // 造一条 60 个媒体的长消息（每个都带一条不算短的下载直链）
  const lines = ['【WebClip】标题', '来源：https://example.com/x', '媒体：共 60 个', '下载地址：'];
  for (let i = 1; i <= 60; i += 1) {
    lines.push(`${i}. 图片 0.50MB http://192.168.1.10:3000/media-only/example.com/%E7%A4%BA%E4%BE%8B/${String(i).padStart(2, '0')}.png`);
  }
  const text = lines.join('\n');
  const { parts } = splitWebhookText(text, limit);

  assert.ok(parts.length > 1, `长消息应被切成多条，实际 ${parts.length}`);
  for (const [index, part] of parts.entries()) {
    assert.ok(part.length <= limit, `第 ${index + 1} 条超长：${part.length} > ${limit}`);
    assert.match(part, new RegExp(`（${index + 1}/${parts.length}）`), '每条应带分片标记');
  }
  // 链接必须完整（不能被截断）
  const all = parts.join('\n');
  for (const i of [1, 30, 60]) {
    assert.match(all, new RegExp(`/media-only/example.com/%E7%A4%BA%E4%BE%8B/${String(i).padStart(2, '0')}\\.png`), `第 ${i} 条链接应完整`);
  }
  // 短消息不切
  assert.deepEqual(splitWebhookText('短消息', limit).parts, ['短消息']);
});

test('SSRF 防护拦截内网地址', () => {
  assert.equal(isPrivateIP('127.0.0.1'), true);
  assert.equal(isPrivateIP('10.1.2.3'), true);
  assert.equal(isPrivateIP('192.168.1.1'), true);
  assert.equal(isPrivateIP('169.254.169.254'), true);
  assert.equal(isPrivateIP('::1'), true);
  assert.equal(isPrivateIP('fd00::1'), true);
  assert.equal(isPrivateIP('93.184.216.34'), false);
});

test('slug 生成：任意标题都能得到合法的文章目录名', async () => {
  const { slugify } = await import('../src/utils/text.js');
  const ID_RE = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,180}$/u;
  const titles = [
    '少数派,高效工作，品质生活',
    '测试文章：无头浏览器抓取 | 示例站',
    'Rust 1.80 发布（含 <em>标签</em> 与 "引号"）',
    'a/b\\c:d*e?f"g<h>i|j',
    '../../etc/passwd',
    '   ...   ',
    '',
    '你好世界'.repeat(40),
  ];
  for (const title of titles) {
    const slug = slugify(title, { maxLength: 48, fallback: 'article' });
    const id = `20240911-120000-abcdef-${slug}`;
    assert.match(id, ID_RE, `标题 ${JSON.stringify(title)} 生成了非法 id: ${id}`);
    assert.ok(!id.includes('..'), `id 不应包含 ..: ${id}`);
    assert.ok(!id.includes('/') && !id.includes('\\'), `id 不应包含路径分隔符: ${id}`);
  }
});

/* ---------------- 2. 参数校验 ---------------- */

test('参数校验：非法 engine / imageMode 直接报错', () => {
  assert.throws(() => normalizeOptions({ engine: 'curl' }), /engine/);
  assert.throws(() => normalizeOptions({ imageMode: 'cloud' }), /imageMode/);
  assert.equal(normalizeOptions({}).engine, 'browser');
  assert.equal(normalizeOptions({ engine: 'fetch' }).engine, 'fetch');
});

/* ---------------- 3. fetch 引擎完整流程 ---------------- */

let firstResult = null;

test('fetch 引擎：过滤广告、转 Markdown、媒体落本地图床', async () => {
  const result = await convertUrl(`${fixtureBase}/article`, {
    engine: 'fetch',
    imageMode: 'local',
    store: true,
  });
  firstResult = result;

  const md = result.markdown;
  assert.ok(md.length > 200, 'Markdown 长度应当大于 200');

  // 正文保留
  assert.match(md, /第一段正文内容/);
  assert.match(md, /第二段正文内容/);
  assert.match(md, /图注文字/);

  // 广告 / 无关内容被过滤
  for (const junk of [
    'ADVERTISEMENT',
    'NAVJUNK',
    'SIDEBARJUNK',
    'SUBSCRIBEJUNK',
    'COOKIEJUNK',
    'SHAREJUNK',
    'RELATEDJUNK',
    'COMMENTJUNK',
    'FOOTERJUNK',
    'SCRIPTJUNK',
  ]) {
    assert.ok(!md.includes(junk), `不应包含被过滤内容: ${junk}`);
  }
  assert.ok(!md.includes('ads.example.com'), '广告 iframe 应被删除');

  // 元信息
  assert.match(md, /^---\n/);
  assert.match(md, /title: "测试文章/);
  assert.match(md, /author: "张三"/);
  assert.match(md, /# 测试文章/);

  // 代码块与表格
  assert.match(md, /```js\nconst answer = 42;/);
  assert.match(md, /\| 字段 \| 说明 \|/);

  // 标题里的永久链接要被展开
  assert.match(md, /^## 小节标题$/m, '标题内的 <a> 应被展开为纯文本');
  assert.ok(!/^## \[/m.test(md), '不应出现 ## [标题](url) 形式');

  // 列表缩进收敛
  assert.match(md, /^- 列表项一$/m, '列表标记后应为单个空格');

  // 正文里的 h1 与「# 标题」重复时应只保留一个
  assert.equal((md.match(/^#+ 测试文章：无头浏览器抓取/gm) || []).length, 1, '标题不应重复出现');

  // 白名单嵌入保留
  assert.match(md, /youtube\.com\/embed\/abc123/);

  // 媒体改写为本地图床
  assert.ok(result.media.length >= 4, `应至少保存 4 个媒体文件，实际 ${result.media.length}`);
  for (const item of result.media) {
    assert.ok(item.localUrl.startsWith(`http://127.0.0.1:${apiPort}/media/`), `本地链接异常: ${item.localUrl}`);
    assert.match(md, new RegExp(item.localUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `Markdown 中应引用本地资源 ${item.localUrl}`);
  }
  // 无 alt 的图片不能被"空链接清理"吃掉
  assert.match(
    md,
    /!\[\]\(http:\/\/127\.0\.0\.1:\d+\/media\/(?:[^/)]+\/){0,2}[^/)]+\.png\)/,
    '无 alt 图片应保留 ![](本地地址) 语法',
  );
  assert.ok(!md.includes('\n!\n'), '不应出现只剩感叹号的残缺图片语法');
  assert.ok(!md.includes('/img/placeholder.gif'), '占位图不应出现在结果中');
  assert.ok(!md.includes('/track/pixel.png'), '追踪像素不应出现在结果中');

  // 正文配图用 CSS 背景图实现的（今日头条那种），必须被转成真实图片
  assert.ok(
    result.media.some((m) => m.sourceUrl.includes('/img/fourth.png')),
    '背景图 div 里的配图应被抓到（今日头条正文就是这种写法）',
  );
  // 但装饰性小图（雪碧图/图标）不应抓
  assert.ok(
    !result.media.some((m) => m.sourceUrl.includes('/img/fifth.png')),
    '装饰性背景小图不应被抓',
  );

  // 播放器自带的 UI 文字不能混进正文
  for (const ui of ['暂停', '00:09 / 00:25', '进入全屏', '点击按住可拖动视频']) {
    assert.ok(!md.includes(ui), `播放器 UI 文字不应出现在正文里: ${ui}`);
  }

  // 视频也保存了
  const video = result.media.find((m) => m.kind === 'video');
  assert.ok(video, '视频应被保存到本地图床');
  assert.equal(video.mime, 'video/mp4');

  // 视频在 Markdown 里用 HTML 标签（阅读模式可直接播放），并带上封面
  assert.match(md, new RegExp(`<video src="${escapeRegExp(video.localUrl)}"[^>]*controls`), '视频应输出为 <video> 标签');
  assert.ok(md.includes('</video>'), '应有闭合标签');
  assert.ok(!md.includes(`[▶ 视频](${video.localUrl})`), 'HTML 模式下不应再输出链接形式');

  // 落盘
  const saved = await articleStore.get(result.id);
  assert.equal(saved.markdown, md);
  assert.equal(saved.meta.title, '测试文章：无头浏览器抓取');
  assert.ok(saved.meta.stats.words > 20);
});

test('本地图床：文件确实落盘且可通过 HTTP 读取', async () => {
  assert.ok(firstResult, '依赖上一个测试的结果');
  const item = firstResult.media[0];
  const mediaPath = item.localUrl.replace(`http://127.0.0.1:${apiPort}`, '');
  const res = await fetch(`${apiBase}${mediaPath}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /^image\//);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.ok(bytes.length > 40);
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');

  const list = mediaStore.list({ limit: 10 });
  assert.ok(list.total >= 2);
});

/* ---------------- 2c. folder 布局：站点目录 + 标题命名的文件夹 + 顺序编号 ---------------- */

/** 把 /media/<站点>/<文件夹>/NN.ext 形式的本地地址换算成磁盘路径 */
function mediaDiskPath(localUrl) {
  const rel = decodeURIComponent(new URL(localUrl).pathname.replace(/^\/media\//, ''));
  return path.join(process.env.DATA_DIR, 'media', ...rel.split('/'));
}

/** 从本地地址里取出 <文件夹> 段（按网站分类后它是倒数第二段） */
function folderOf(localUrl) {
  const segments = new URL(localUrl).pathname.split('/').filter(Boolean);
  return decodeURIComponent(segments[segments.length - 2]);
}

/** 从本地地址里取出 <站点> 段（media/<站点>/… 的第一段） */
function groupOf(localUrl) {
  return decodeURIComponent(new URL(localUrl).pathname.split('/').filter(Boolean)[1] || '');
}

test('folder 布局：媒体存进以标题命名的文件夹，并按正文出现顺序编号', async () => {
  const result = await convertUrl(`${fixtureBase}/article`, { engine: 'fetch', imageMode: 'local', store: false });
  assert.ok(result.media.length >= 4, `应抓到多个媒体：${result.media.length}`);

  const folders = new Set();
  for (const item of result.media) {
    const m = /\/media\/([^/]+)\/([^/]+)\/(\d{2,})\.([a-z0-9]+)$/i.exec(item.localUrl);
    assert.ok(m, `folder 布局的地址应是 /media/<站点>/<文件夹>/NN.ext：${item.localUrl}`);
    folders.add(decodeURIComponent(m[2]));
    // 报告里的 file 就是 localUrl 去掉 /media/ 前缀后的相对路径（含站点目录）
    const relFromUrl = decodeURIComponent(new URL(item.localUrl).pathname.replace(/^\/media\//, ''));
    assert.equal(item.file, relFromUrl, '报告里的 file 应与链接一致');
  }
  assert.equal(folders.size, 1, `同一篇文章的媒体应在同一个文件夹里：${[...folders].join(' , ')}`);
  const folder = [...folders][0];
  assert.ok(folder.includes('测试文章'), `文件夹名应来自文章标题：${folder}`);
  // 按网站分类：站点目录是 localUrl 的第一段，且同一个页面的媒体共用一个站点目录
  const groups = new Set(result.media.map((m) => groupOf(m.localUrl)));
  assert.equal(groups.size, 1, `同一篇文章的媒体应在同一个站点目录里：${[...groups].join(' , ')}`);
  assert.equal([...groups][0], '127.0.0.1', `站点目录应来自页面域名：${[...groups][0]}`);

  // 顺序编号：从 01 起、连续、不重复，且与报告顺序（正文出现顺序）一致
  const indexes = result.media.map((m) => Number(/(\d{2,})\.[a-z0-9]+$/i.exec(m.localUrl)[1]));
  assert.deepEqual(indexes, indexes.map((_, i) => i + 1), `应按正文顺序连续编号：${indexes.join(',')}`);
  assert.ok(result.media[0].sourceUrl.includes('photo.png'), `01 应是正文里的第一张图，实际 ${result.media[0].sourceUrl}`);
  assert.equal(result.media.at(-1).kind, 'video', '视频按出现位置排在最后');

  // 真的落盘了，并且带中文的文件夹名能通过 URL 访问到
  const first = result.media[0];
  const bytes = await fs.readFile(mediaDiskPath(first.localUrl));
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', '磁盘上应是一张 PNG');
  const res = await fetch(first.localUrl);
  assert.equal(res.status, 200, '中文文件夹名必须能通过 URL 编码正常访问');
  assert.match(res.headers.get('content-type') || '', /^image\//);
  assert.match(result.markdown, new RegExp(escapeRegExp(first.localUrl)), 'Markdown 里应引用本地地址');

  // 视频也进了同一个文件夹
  const video = result.media.find((m) => m.kind === 'video');
  assert.equal(folderOf(video.localUrl), folder, '视频与图片共用同一篇文章文件夹');
});

test('folder 布局：同名标题的两篇文章各自一个文件夹，互不覆盖', async () => {
  // force：确保落成两篇独立文章（否则第二次会被"正文未变"复用）
  const a = await convertUrl(`${fixtureBase}/article`, { engine: 'fetch', imageMode: 'local', store: true, force: true });
  const b = await convertUrl(`${fixtureBase}/article`, { engine: 'fetch', imageMode: 'local', store: true, force: true });
  assert.notEqual(a.id, b.id, 'force 时应落成两篇独立文章');

  const fa = folderOf(a.media[0].localUrl);
  const fb = folderOf(b.media[0].localUrl);
  assert.notEqual(fa, fb, `两篇文章的媒体文件夹不能重名：${fa}`);
  // 两个文件夹都来自同一个标题 slug，只是重名时加了后缀
  const wanted = slugify(a.title, { maxLength: 48, fallback: 'media' });
  assert.ok(fa.startsWith(wanted), `文件夹名应来自标题：${fa} vs ${wanted}`);
  assert.ok(fb.startsWith(wanted), `文件夹名应来自标题：${fb} vs ${wanted}`);

  // 两边的文件都还在，说明没有互相覆盖
  for (const result of [a, b]) {
    for (const item of result.media) {
      const stat = await fs.stat(mediaDiskPath(item.localUrl));
      assert.ok(stat.size > 40, `文件应存在且非空：${item.localUrl}`);
    }
  }

  for (const result of [a, b]) {
    await fetch(`${apiBase}/api/articles/${encodeURIComponent(result.id)}?withMedia=1`, { method: 'DELETE' });
  }
});

test('folder 布局：删除文章会连它的媒体文件夹一起清掉', async () => {
  const article = await convertUrl(`${fixtureBase}/article`, { engine: 'fetch', imageMode: 'local', store: true, force: true });
  const group = groupOf(article.media[0].localUrl);
  const folder = folderOf(article.media[0].localUrl);
  // 媒体在 media/<站点>/<文章文件夹>/ 下
  const dir = path.join(process.env.DATA_DIR, 'media', group, folder);
  assert.ok((await fs.readdir(dir)).length >= 4, '删除前文件夹里应有媒体文件');

  const res = await fetch(`${apiBase}/api/articles/${encodeURIComponent(article.id)}?withMedia=1`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(
    body.data.media.removed >= 4,
    `应删掉这篇文章的全部媒体，实际 ${JSON.stringify(body.data.media)}`,
  );
  await assert.rejects(fs.stat(dir), '媒体文件夹应被整个清掉');
  assert.equal(
    mediaStore.list({ limit: 10000 }).items.filter((i) => i.articleId === article.id).length,
    0,
    '图床索引里不应残留这篇文章的文件',
  );
});

test('重复抓取同一页面（flat 布局）：媒体命中索引，不再重新下载', async () => {
  // 内容寻址的去重缓存只在 flat 布局下生效，所以这里显式指定布局，
  // 连抓两次保证"第二次完全命中缓存"这件事本身被验证到。
  const opts = { engine: 'fetch', imageMode: 'local', store: false, mediaLayout: 'flat' };
  const first = await convertUrl(`${fixtureBase}/article`, opts);
  const again = await convertUrl(`${fixtureBase}/article`, opts);
  const stats = again.stats.media;
  assert.equal(stats.saved, 0, '不应有新增下载');
  assert.ok(stats.reusedFromCache >= 2, `应命中缓存，实际 ${stats.reusedFromCache}`);
  assert.equal(again.media.length, first.media.length);
  for (const item of again.media) {
    assert.match(
      item.localUrl,
      /\/media\/(?:[^/]+\/)?[a-f0-9]{16,}\.[a-z0-9]+$/i,
      `flat 布局应是内容寻址文件名（可带站点目录）：${item.localUrl}`,
    );
  }
});

test('imageMode=remote：保留外链不改写', async () => {
  const result = await convertUrl(`${fixtureBase}/article`, { engine: 'fetch', imageMode: 'remote', store: false });
  assert.match(result.markdown, /\/img\/photo\.png/);
  assert.ok(
    !result.markdown.includes(`http://127.0.0.1:${apiPort}/media/`),
    'remote 模式不应出现本地图床链接',
  );
});

test('imageMode=none：删除所有媒体', async () => {
  const result = await convertUrl(`${fixtureBase}/article`, { engine: 'fetch', imageMode: 'none', store: false });
  assert.equal(result.media.length, 0);
  assert.ok(!result.markdown.includes('!['), '不应有图片语法');
});

test('视频用独立的大小上限：不会被图片上限误伤', async () => {
  const result = await convertUrl(`${fixtureBase}/article`, {
    engine: 'fetch',
    store: false,
    includeImages: false,
    maxFileBytes: 1024, // 图片上限 1KB：4KB 的 clip.mp4 按图片标准会被挡
    maxVideoBytes: 1024 * 1024,
  });
  const video = result.media.find((m) => m.kind === 'video');
  assert.ok(video, '视频不应被图片的单文件上限挡住');
  assert.equal(result.stats.media.failed, 0);
});

test('超过视频上限的文件会被跳过并给出可操作的告警', async () => {
  const result = await convertUrl(`${fixtureBase}/article`, {
    engine: 'fetch',
    store: false,
    includeImages: false,
    maxVideoBytes: 1024, // 比 4KB 的 clip.mp4 小
  });
  assert.equal(result.media.length, 0);
  const failure = result.mediaFailures.find((f) => f.reason === 'too_large');
  assert.ok(failure, '应报告 too_large');
  assert.ok(
    result.warnings.some((w) => w.includes('MAX_VIDEO_BYTES')),
    '告警里应告诉用户调哪个环境变量',
  );
});

test('下载文件名自动生成：默认带日期、清洗非法字符、可自定义模板', async () => {
  const { buildArticleFilename, sanitizeSegment } = await import('../src/utils/filename.js');

  const meta = {
    id: '20240911-120000-abcdef-测试文章',
    title: '测试文章：无头浏览器抓取 | 示例站',
    siteName: '示例站',
    author: '张三',
    createdAt: '2025-03-04T05:06:07.000Z',
    published: '',
    url: 'https://www.example.com/a',
    stats: { words: 1234 },
  };

  // 默认模板：{date}-{title}
  const def = buildArticleFilename(meta);
  assert.match(def, /^\d{4}-\d{2}-\d{2}-/, `默认应带日期：${def}`);
  assert.ok(def.endsWith('.md'), `应带扩展名：${def}`);
  assert.ok(!/[\\/:*?"<>|]/.test(def), `不应包含非法字符：${def}`);
  assert.ok(def.includes('测试文章'), `应包含标题：${def}`);

  // 自定义模板与占位符
  const custom = buildArticleFilename(meta, { template: '{site}_{author}_{words}_{host}' });
  assert.equal(custom, '示例站_张三_1234_example.com.md');

  // 只用标题：全角冒号/竖线经 NFKC + 清洗后变成空格（Windows 上 : 和 | 都非法）
  assert.equal(buildArticleFilename(meta, { template: '{title}' }), '测试文章 无头浏览器抓取 示例站.md');

  // 模板里的路径分隔符必须被清理掉
  const withSlash = buildArticleFilename(meta, { template: '{site}/{date} {title}' });
  assert.ok(!withSlash.includes('/'), `模板里的 / 应被清理：${withSlash}`);

  // 标题缺失时用域名兜底，绝不能退化成文章 id（那是"时间戳-哈希"，看起来像按时间戳命名）
  const emptyTitle = buildArticleFilename({ id: '20260914-080657-abc123-x', title: '', createdAt: '2025-03-04T00:00:00Z' });
  assert.equal(emptyTitle, '2025-03-04-untitled.md');
  const noTitleWithUrl = buildArticleFilename({
    id: '20260914-080657-abc123-x',
    title: '',
    url: 'https://m.toutiao.com/article/1',
    createdAt: '2025-03-04T00:00:00Z',
  });
  assert.equal(noTitleWithUrl, '2025-03-04-m.toutiao.com.md');
  assert.ok(!/20260914/.test(noTitleWithUrl), '兜底名里不应出现文章 id 的时间戳部分');

  // 超长标题按上限截断且不留尾部分隔符
  const long = buildArticleFilename({ title: '很长的标题'.repeat(40), createdAt: '2025-03-04T00:00:00Z' }, { maxLength: 40 });
  assert.ok(long.length <= 44, `应被截断：${long.length}`);
  assert.ok(!/[-_.\s]\.md$/.test(long), `截断后不应残留分隔符：${long}`);

  // Windows 保留名
  assert.equal(buildArticleFilename({ title: 'con' }, { template: '{title}' }), 'con_.md');
  // 控制字符与换行
  assert.equal(sanitizeSegment('a\u0000b\nc'), 'a b c');
});

test('下载接口返回自动生成的文件名（ASCII 兜底 + RFC5987）', async () => {
  const converted = await convertUrl(`${fixtureBase}/article`, { engine: 'fetch', imageMode: 'none' });
  assert.match(converted.filename, /^\d{4}-\d{2}-\d{2}-.*\.md$/, `转换结果应带 filename：${converted.filename}`);

  const res = await fetch(`${apiBase}/api/articles/${encodeURIComponent(converted.id)}/download`);
  assert.equal(res.status, 200);
  const disposition = res.headers.get('content-disposition') || '';
  assert.match(disposition, /^attachment;/, '下载接口应为 attachment');
  assert.match(disposition, /filename="[\x20-\x7e]+\.md"/, `应带 ASCII 兜底名：${disposition}`);
  assert.match(disposition, /filename\*=UTF-8''/, '应带 UTF-8 文件名');
  const ascii = /filename="([^"]+)"/.exec(disposition)[1];
  assert.ok(
    !/__/.test(ascii),
    `中文标题的 ASCII 兜底名不应是一串下划线：${ascii}`,
  );
  assert.ok(
    (ascii.match(/[A-Za-z0-9]/g) || []).length >= 8,
    `ASCII 兜底名应可读（例如来自文章 id）：${ascii}`,
  );
  const encoded = /filename\*=UTF-8''([^;]+)/.exec(disposition)[1];
  assert.equal(decodeURIComponent(encoded), converted.filename, 'filename* 应与结果里的 filename 一致');

  const headerName = res.headers.get('x-article-filename');
  assert.equal(decodeURIComponent(headerName), converted.filename);

  // 列表里也带 filename
  const list = await (await fetch(`${apiBase}/api/articles?limit=50`)).json();
  const item = list.data.items.find((i) => i.id === converted.id);
  assert.ok(item, '列表里应能找到刚转换的文章');
  assert.equal(item.filename, converted.filename);

  // 元数据接口同样带 filename
  const metaRes = await (await fetch(`${apiBase}/api/articles/${encodeURIComponent(converted.id)}`)).json();
  assert.equal(metaRes.data.filename, converted.filename);

  // 按请求覆盖模板
  const custom = await convertUrl(`${fixtureBase}/article`, {
    engine: 'fetch',
    imageMode: 'none',
    filenameTemplate: '{host}-{title}',
  });
  assert.match(custom.filename, /^127\.0\.0\.1-测试文章/, `自定义模板未生效：${custom.filename}`);

  await fetch(`${apiBase}/api/articles/${encodeURIComponent(converted.id)}`, { method: 'DELETE' });
  await fetch(`${apiBase}/api/articles/${encodeURIComponent(custom.id)}`, { method: 'DELETE' });
});

test('页面数据兜底：只存在于 <script> 数据里的媒体也要抓下来（微信图片消息那种）', async () => {
  // flat 布局：本节第 7 条要验证"同一份内容的不同 CDN 地址合并成一条"，
  // 那是内容寻址的特性（folder 布局按出现位置各存一份，不做内容合并）
  const result = await convertUrl(`${fixtureBase}/gallery`, {
    engine: 'fetch',
    imageMode: 'local',
    store: false,
    mediaLayout: 'flat',
  });

  // 1) 数据里的图片被找到了
  assert.ok(result.stats.embeddedMedia.found >= 5, `应从页面数据里找到媒体：${JSON.stringify(result.stats.embeddedMedia)}`);
  assert.ok(result.stats.embeddedMedia.used >= 5, '应把它们补进正文');

  // 2) 真的下载并本地化了
  for (const name of ['photo.png', 'second.png', 'third.png', 'fourth.png', 'fifth.png']) {
    assert.ok(
      result.media.some((m) => m.sourceUrl.includes(name)),
      `应抓到 ${name}（实际：${result.media.map((m) => m.sourceUrl).join(' , ')}）`,
    );
    assert.ok(
      result.media.some((m) => m.sourceUrl.includes(name) && m.localUrl.includes('/media/')),
      `${name} 应被改写为本地地址`,
    );
  }

  // 3) 头像 / 图标 / 统计像素不能被抓（噪音与广告过滤）
  assert.ok(
    !result.media.some((m) => /avatar-icon|logo-badge|hm\.baidu/.test(m.sourceUrl)),
    `头像/图标/统计地址不应被抓：${result.media.map((m) => m.sourceUrl).join(' , ')}`,
  );

  // 4) 视频也能从数据里补出来
  assert.ok(result.media.some((m) => m.kind === 'video' && m.sourceUrl.includes('clip.mp4')), '数据里的视频也应抓到');

  // 5) 每张图独占一行，且带出来源小节
  assert.match(result.markdown, /## 图片（来自页面数据）/);
  assert.ok(!/\)!\[/.test(result.markdown), '图片之间应有换行，不能挤在一行');

  // 6) 正文几乎为空时用 description 兜底当导语（且解码了 \\x0a 字面量）
  assert.match(result.markdown, /第一段描述文案/);
  assert.match(result.markdown, /第二段描述文案/);
  assert.ok(result.warnings.some((w) => w.includes('页面数据')), '应有告警说明媒体来自页面数据');

  // 7) 同一份内容的不同地址（photo.png / photo-copy.png）应合并成一条记录
  const photo = result.media.find((m) => m.file && m.sourceUrl.includes('photo.png'));
  assert.ok(photo, '应保留 photo.png 的记录');
  assert.deepEqual(
    [...(photo.sourceUrls || [])].sort(),
    [`${fixtureBase}/img/photo.png?wx_fmt=jpeg`, `${fixtureBase}/img/photo-copy.png`].sort(),
    `两条 CDN 地址应合并到同一条记录：${JSON.stringify(photo)}`,
  );
  assert.equal(
    result.media.filter((m) => m.localUrl === photo.localUrl).length,
    1,
    '同一个本地文件在报告里只应出现一次',
  );
  assert.equal(
    result.markdown.split(photo.localUrl).length - 1,
    1,
    '正文里同一张图只应出现一次',
  );
  assert.ok(result.stats.media.mergedDuplicateUrls >= 1, '应记录合并掉的重复地址数');
});

test('页面数据捞媒体：跳过噪音键、广告域名与重复项，并处理转义', async () => {
  const { collectEmbeddedMediaUrls } = await import('../src/pipeline/embedded.js');
  const html = `<html><body><script>
    window.__DATA__ = {
      a: "https:\\/\\/cdn.example.com\\/img\\/one.jpg?x=1&amp;y=2",
      b: "//cdn.example.com/img/two.png",
      c: "/img/three.webp",
      d: "https://hm.baidu.com/track.gif",
      avatar_url: "https://cdn.example.com/img/avatar-big.jpg",
      logo: "https://cdn.example.com/img/logo.png",
      dup: "https://cdn.example.com/img/one.jpg?x=1&y=2",
      video: "https://cdn.example.com/v/clip.mp4",
      page: "https://example.com/article/123",
      bareHost: "https://mmbiz.qpic.cn/",
      uiAsset: "https://res.wx.qq.com/mmbizappmsg/zh_CN/htmledition/js/audios/empty80a357.mp3",
      uiIcon: "https://res.wx.qq.com/mmbizappmsg/zh_CN/htmledition/js/images/pic/pic_like_44f9e9.png"
    };
  </script></body></html>`;

  const found = collectEmbeddedMediaUrls(html, { baseUrl: 'https://example.com/a/' });
  const urls = found.map((f) => f.url);

  assert.ok(urls.includes('https://cdn.example.com/img/one.jpg?x=1&y=2'), '应解码 \\/ 与 &amp; 并还原 URL');
  assert.ok(urls.includes('https://cdn.example.com/img/two.png'), '协议相对地址应补全');
  assert.ok(urls.includes('https://example.com/img/three.webp'), '相对地址应基于 baseUrl 解析');
  assert.equal(urls.filter((u) => u.includes('one.jpg')).length, 1, '重复地址应去重');
  assert.ok(!urls.some((u) => u.includes('hm.baidu.com')), '广告/统计域名应被过滤');
  assert.ok(!urls.some((u) => u.includes('avatar-big')), '头像键应被过滤');
  assert.ok(!urls.some((u) => u.includes('logo.png')), '图标应被过滤');
  assert.ok(!urls.some((u) => u.includes('/article/123')), '普通页面地址不应被当成媒体');
  assert.ok(!urls.some((u) => /qpic\.cn\/$/.test(u)), '纯域名（dns-prefetch 那种）不应被当成媒体');
  assert.ok(!urls.some((u) => u.includes('empty80a357')), '站点 UI 音效不应被当成媒体');
  assert.ok(!urls.some((u) => u.includes('pic_like')), '站点 UI 图标不应被当成媒体');
  assert.equal(found.find((f) => f.url.includes('clip.mp4')).kind, 'video', '应识别视频类型');
  assert.equal(found.find((f) => f.url.includes('one.jpg')).kind, 'image');
});

test('下载文件名：不支持 filename* 的客户端也要拿到可读的 ASCII 名', async () => {
  const { asciiFallbackName, contentDisposition, sanitizeSegment } = await import('../src/utils/filename.js');

  // 中文标题 → 日期-站点-短哈希（而不是"时间戳-哈希"那种文章 id）
  const cjk = asciiFallbackName('2026-09-14-保丰产、护生态 “绿色田管+全链条服务” - 今日头条.md', {
    host: 'www.toutiao.com',
    date: '2026-09-14',
    hash: 'a1b2c3d4',
  });
  assert.equal(cjk, '2026-09-14-toutiao-a1b2c3.md');
  assert.ok(!/^\d{8}-\d{6}-/.test(cjk), `不应是时间戳样式的名字：${cjk}`);

  // 文件名里本来就有 ASCII 词时保留它们
  assert.equal(
    asciiFallbackName('2026-09-14-Rust 1.80 发布：新特性一览.md', { host: 'blog.rust-lang.org', date: '2026-09-14', hash: 'x' }),
    '2026-09-14-Rust-1.80.md',
  );
  // 只有数字不算可读
  assert.ok(asciiFallbackName('2026-09-14.md', { host: 'm.example.com', date: '2026-09-14', hash: 'abc123' }).includes('example'));

  // 头部同时给出 ASCII 兜底名与 UTF-8 名，两者扩展名都正确
  const header = contentDisposition('2026-09-14-中文标题.md', { type: 'attachment', asciiFallback: cjk });
  assert.match(header, /^attachment; filename="2026-09-14-toutiao-a1b2c3\.md"/);
  assert.match(header, /filename\*=UTF-8''/);

  // 合法字符不能被吃掉（C++ / C# / 100% / & 都要保留）
  assert.equal(sanitizeSegment('C++ 与 C# 教程: 100% 正确&完整'), 'C++ 与 C# 教程 100% 正确&完整');
});

test('下载文件名：中文名不能被 HTTP 头截断（回归：曾经被切到 "…- 今日"）', async () => {
  const { contentDisposition, buildArticleFilename } = await import('../src/utils/filename.js');

  const title = '保丰产、护生态 “绿色田管+全链条服务”助力希望的田野增产增收 - 今日头条';
  const name = buildArticleFilename(
    {
      title,
      finalUrl: 'https://www.toutiao.com/article/7685273065382625802/',
      url: 'https://www.toutiao.com/article/7685272625802/',
      createdAt: '2026-09-14T08:06:57.000Z',
      id: '20260914-080657-12e43e-x',
    },
    { template: '{date}-{title}', maxLength: 100, maxBytes: 200 },
  );
  assert.ok(name.endsWith('今日头条.md'), `名字应完整保留标题：${name}`);

  const header = contentDisposition(name, { type: 'attachment', asciiFallback: '2026-09-14-toutiao-68d973.md' });
  const encoded = /filename\*=UTF-8''([^;]+)/.exec(header)?.[1] || '';
  let decoded = '';
  assert.doesNotThrow(() => {
    decoded = decodeURIComponent(encoded);
  }, '文件名被切在多字节字符中间会导致解码失败');
  assert.equal(decoded, name, 'filename* 必须与文件名完全一致');
  assert.ok(decoded.endsWith('.md'), `解码后应以 .md 结尾：${decoded}`);

  // 超长中文标题：按字节收缩，仍要是合法的 UTF-8 且以 .md 结尾
  const longName = buildArticleFilename(
    { title: '这是一个非常长的中文标题'.repeat(12), createdAt: '2026-09-14T00:00:00Z' },
    { template: '{date}-{title}', maxLength: 100, maxBytes: 200 },
  );
  assert.ok(Buffer.byteLength(longName, 'utf8') <= 200, `字节数应 <= 200：${Buffer.byteLength(longName, 'utf8')}`);
  assert.ok(longName.endsWith('.md'), '超长名也应以 .md 结尾');
  const longHeader = contentDisposition(longName, { asciiFallback: 'x.md' });
  const longDecoded = decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(longHeader)[1]);
  assert.equal(longDecoded, longName);
});

test('下载接口的 ASCII 兜底名必须是可读的（回归：不能是时间戳）', async () => {
  const converted = await convertUrl(`${fixtureBase}/article`, { engine: 'fetch', imageMode: 'none' });
  const res = await fetch(`${apiBase}/api/articles/${encodeURIComponent(converted.id)}/download`);
  const disposition = res.headers.get('content-disposition') || '';
  const ascii = /filename="([^"]+)"/.exec(disposition)?.[1] || '';
  assert.match(ascii, /\.md$/, `兜底名应以 .md 结尾：${ascii}`);
  assert.ok(
    (ascii.match(/[A-Za-z]/g) || []).length >= 2,
    `兜底名应是可读的（含字母）：${ascii}`,
  );
  assert.ok(!/^\d{8}-\d{6}/.test(ascii), `兜底名不应是时间戳：${ascii}`);
  assert.ok(disposition.includes('filename*=UTF-8'), '仍应带上完整的 UTF-8 文件名');
  await fetch(`${apiBase}/api/articles/${encodeURIComponent(converted.id)}?withMedia=1`, { method: 'DELETE' });
});

test('标题里带 "......" 的文章不能被判成非法 id（回归：曾经整次转换 400）', async () => {
  const { coerceArticleId } = await import('../src/storage/articles.js');
  const ID_RE = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,180}$/u;

  // 直击当时的现场 id
  const reported = '20260914-091055-9b88e2-1993年上海-看看以前的老西門是否和记忆中......-今日头条';
  const fixed = coerceArticleId(reported);
  assert.match(fixed, ID_RE, `规整后应合法：${fixed}`);
  assert.ok(!fixed.includes('..'), `不应残留连续点：${fixed}`);
  assert.ok(fixed.includes('记忆中'), '标题内容不应被丢掉');

  // 极端的纯点 id 也要能兜住
  assert.match(coerceArticleId('....'), ID_RE);
  assert.equal(coerceArticleId('....'), 'article');

  // 走完整流程：抓取 → 落盘 → 读回 → 下载 → 删除
  const result = await convertUrl(`${fixtureBase}/dotted`, { engine: 'fetch', imageMode: 'none' });
  assert.ok(result.id, '应生成 id');
  assert.ok(!result.id.includes('..'), `id 里不应有连续点：${result.id}`);
  assert.match(result.id, ID_RE);

  const meta = await (await fetch(`${apiBase}/api/articles/${encodeURIComponent(result.id)}`)).json();
  assert.equal(meta.ok, true, '应能读回文章元数据');
  assert.match(meta.data.title, /记忆中/);

  const res = await fetch(`${apiBase}/api/articles/${encodeURIComponent(result.id)}/download`);
  assert.equal(res.status, 200, '应能下载');

  const del = await fetch(`${apiBase}/api/articles/${encodeURIComponent(result.id)}`, { method: 'DELETE' });
  assert.equal(del.status, 200, '应能删除');
});

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 与 convertUrl 内部一致：网址记录的主键是规范化后的 URL */
function canonicalizeUrlForTest(raw) {
  const url = new URL(raw);
  url.search = '';
  return url.toString();
}

test('视频在 Markdown 里的表示形式：html / link / both 三种模式', async () => {
  const html = `
    <p>正文</p>
    <video src="http://h/media/a.mp4" poster="http://h/media/cover.jpg" controls></video>
    <audio src="http://h/media/b.mp3"></audio>
    <video poster="http://h/media/only-poster.jpg"></video>
    <video src="http://h/media/x.mp4?a=1&b=2"></video>
  `;

  const { htmlToMarkdown } = await import('../src/pipeline/markdown.js');

  // 默认 html：可播放的标签 + 封面 + 属性转义
  const htmlMode = htmlToMarkdown(html, { title: 'T', includeTitle: false });
  assert.match(htmlMode, /<video src="http:\/\/h\/media\/a\.mp4" controls preload="metadata" poster="http:\/\/h\/media\/cover\.jpg"><\/video>/);
  assert.match(htmlMode, /<audio src="http:\/\/h\/media\/b\.mp3" controls/);
  assert.match(htmlMode, /<video src="http:\/\/h\/media\/x\.mp4\?a=1&amp;b=2"/, '查询串里的 & 必须转义成 &amp;');
  assert.match(htmlMode, /!\[视频封面\]\(http:\/\/h\/media\/only-poster\.jpg\)/, '只有封面时应退回图片');
  assert.ok(!htmlMode.includes('[▶ 视频]'), 'html 模式不应再有链接形式');

  // link：老形式
  const linkMode = htmlToMarkdown(html, { title: 'T', includeTitle: false, videoMarkdown: 'link' });
  assert.match(linkMode, /\[▶ 视频\]\(http:\/\/h\/media\/a\.mp4\)/);
  assert.match(linkMode, /!\[视频封面\]\(http:\/\/h\/media\/cover\.jpg\)/);
  assert.ok(!linkMode.includes('<video'), 'link 模式不应输出 HTML 标签');

  // both：标签 + 链接兜底
  const bothMode = htmlToMarkdown(html, { title: 'T', includeTitle: false, videoMarkdown: 'both' });
  assert.match(bothMode, /<video /);
  assert.match(bothMode, /\[▶ 视频\]\(http:\/\/h\/media\/a\.mp4\)/);

  // 非法值回落到 html
  assert.match(htmlToMarkdown(html, { title: 'T', includeTitle: false, videoMarkdown: '乱写的' }), /<video /);
});

test('视频在 Markdown 里的表示形式（集成）：转换出来的正文里能直接播', async () => {
  const result = await convertUrl(`${fixtureBase}/article`, { engine: 'fetch', imageMode: 'local', store: false });
  const video = result.media.find((m) => m.kind === 'video');
  assert.ok(video, '夹具里应有视频');
  assert.match(result.markdown, new RegExp(`<video src="${escapeRegExp(video.localUrl)}"`), '正文里应是可播放的 <video> 标签');

  // 切到 link 模式时应退回链接
  const linkResult = await convertUrl(`${fixtureBase}/article`, {
    engine: 'fetch',
    imageMode: 'local',
    store: false,
    videoMarkdown: 'link',
  });
  assert.ok(!linkResult.markdown.includes('<video'), 'link 模式不应有 HTML 标签');
  assert.match(linkResult.markdown, /\[▶ 视频\]\(/);
});

test('网址记录 + 正文副本：重复抓取同一网址且正文没变时直接复用，不再下载', async () => {
  const { articleDb } = await import('../src/storage/db.js');
  assert.equal(articleDb.available, true, '测试环境应能使用 node:sqlite');

  const url = `${fixtureBase}/db-article`; // 数据库测试专用地址，规范化后不带查询参数
  const first = await convertUrl(url, { engine: 'fetch', imageMode: 'local', store: true });
  assert.ok(!first.unchanged, '第一次抓取不应命中复用');
  assert.ok(first.media.length >= 1, '第一次应下载了媒体');

  // 正文副本进了数据库
  const stored = articleDb.getStoredArticle(first.id);
  assert.ok(stored, '正文应在数据库里存了一份');
  assert.match(stored.markdown, /第一版正文/);
  assert.equal(stored.id, first.id);

  // 网址记录
  const record = articleDb.getUrlRecord(url);
  assert.ok(record, '应写入网址记录');
  assert.equal(record.fetchCount, 1);
  assert.equal(record.articleId, first.id);
  assert.equal(record.changeCount, 1);
  assert.ok(record.contentHash, '应有正文指纹');

  // 第二次抓：正文没变 → 复用，且一个字节都不下载
  const second = await convertUrl(url, { engine: 'fetch', imageMode: 'local', store: true });
  assert.equal(second.unchanged, true, '第二次应判定为未变化');
  assert.equal(second.reused, true);
  assert.equal(second.id, first.id, '应复用同一篇文章，而不是新建');
  assert.equal(second.stats.media.saved, 0, '不应重新下载媒体');
  assert.ok(second.stats.media.reusedFromCache >= 1, '媒体应标记为命中缓存');
  assert.ok(second.markdown.includes('第一版正文'), '应返回存档的正文');
  assert.ok(second.warnings.some((w) => w.includes('未发生变化')), '应提示复用了存档');

  const record2 = articleDb.getUrlRecord(url);
  assert.equal(record2.fetchCount, 2, '抓取次数应累加');
  assert.equal(record2.changeCount, 1, '未变化时不应累加变更次数');

  // 传 force 时强制完整重抓：会落成一份新快照，网址记录随之指向最新那篇
  const forced = await convertUrl(url, { engine: 'fetch', imageMode: 'local', store: true, force: true });
  assert.ok(!forced.unchanged, 'force 时应跳过复用判断');
  assert.notEqual(forced.id, first.id, 'force 重抓会生成新的文章快照');
  assert.equal(articleDb.getUrlRecord(url).articleId, forced.id, '记录应指向最新的快照');

  // /api/urls/check 能查出来
  const check = await (await fetch(`${apiBase}/api/urls/check?url=${encodeURIComponent(url)}`)).json();
  assert.equal(check.data.known, true);
  assert.equal(check.data.articleId, forced.id);
  assert.equal(check.data.wouldReuse, true);
  assert.equal(check.data.fetchCount, 3);
});

test('网址记录 + 正文副本：正文变化时另存为新文章，并记录变更次数', async () => {
  const { articleDb } = await import('../src/storage/db.js');
  // utm_ 参数会被规范化掉，所以这仍是"同一个网址"，但正文不同
  const url = `${fixtureBase}/db-article?utm_v=2`;
  const changed = await convertUrl(url, { engine: 'fetch', imageMode: 'local', store: true });

  assert.ok(!changed.unchanged, '正文变了就不该复用');
  assert.ok(changed.markdown.includes('第二版正文'), '应拿到新正文');

  const key = canonicalizeUrlForTest(url);
  const record = articleDb.getUrlRecord(key);
  assert.ok(record, '网址记录应存在');
  assert.equal(record.articleId, changed.id, '记录应指向最新文章');
  assert.ok(record.changeCount >= 2, `变更次数应累加：${record.changeCount}`);
  assert.ok(record.lastChangedAt, '应有最后变更时间');
});

test('网址记录 + 正文副本：换了选项就不该复用旧存档', async () => {
  const url = `${fixtureBase}/db-article`;
  const a = await convertUrl(url, { engine: 'fetch', imageMode: 'local', store: true });
  const b = await convertUrl(url, { engine: 'fetch', imageMode: 'local', store: true });
  assert.equal(b.unchanged, true, '同样选项 + 正文没变 → 复用');
  assert.equal(b.id, a.id);

  // imageMode 变了：即使正文没变也不能拿旧结果搪塞
  const c = await convertUrl(url, { engine: 'fetch', imageMode: 'none', store: true });
  assert.ok(!c.unchanged, '选项变化时应重新处理');
  assert.ok(!c.markdown.includes('!['), 'imageMode=none 的结果里不应有图片');

  // 再抓一次（同为新选项）→ 又可以复用
  const d = await convertUrl(url, { engine: 'fetch', imageMode: 'none', store: true });
  assert.equal(d.unchanged, true, '选项一致 + 正文没变 → 复用');
  assert.equal(d.id, c.id);

  await fetch(`${apiBase}/api/articles/${encodeURIComponent(a.id)}?withMedia=1`, { method: 'DELETE' });
  await fetch(`${apiBase}/api/articles/${encodeURIComponent(c.id)}?withMedia=1`, { method: 'DELETE' });
});

test('删除文章时同时删掉网址记录与正文副本', async () => {
  const { articleDb } = await import('../src/storage/db.js');
  const url = `${fixtureBase}/dotted`;
  const result = await convertUrl(url, { engine: 'fetch', imageMode: 'none', store: true });
  const key = canonicalizeUrlForTest(url);

  assert.ok(articleDb.getStoredArticle(result.id), '删除前数据库里应有正文副本');
  assert.ok(articleDb.getUrlRecord(key), '删除前应有网址记录');

  const del = await fetch(`${apiBase}/api/articles/${encodeURIComponent(result.id)}?withMedia=1`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  const body = await del.json();
  assert.equal(body.data.database.removedBodies, 1, '应删除正文副本');
  assert.equal(body.data.database.removedUrls, 1, '应删除网址记录');

  assert.equal(articleDb.getStoredArticle(result.id), null, '正文副本应已删除');
  assert.equal(articleDb.getUrlRecord(key), null, '网址记录应已删除');

  // 记录里能查到正文（说明确实存在过）
  const searchGone = await (await fetch(`${apiBase}/api/search?q=${encodeURIComponent('带连续省略号')}`)).json();
  assert.ok(Array.isArray(searchGone.data.items), '搜索接口应可用');
});

test('正文检索：/api/search 能在正文里搜到内容', async () => {
  const url = `${fixtureBase}/mutable`;
  const result = await convertUrl(url, { engine: 'fetch', imageMode: 'none', store: true });

  const hit = await (await fetch(`${apiBase}/api/search?q=${encodeURIComponent('固定的一段说明文字')}`)).json();
  assert.equal(hit.data.available, true, '数据库应可用');
  assert.ok(hit.data.items.some((item) => item.id === result.id), `应搜到刚存档的文章：${JSON.stringify(hit.data.items)}`);
  const item = hit.data.items.find((i) => i.id === result.id);
  assert.ok(item.snippet.length > 0, '应返回片段');
  assert.ok(item.title.includes('会变的文章'));

  const miss = await (await fetch(`${apiBase}/api/search?q=${encodeURIComponent('绝对不存在的关键词xyz')}`)).json();
  assert.equal(miss.data.items.length, 0);

  const noQuery = await fetch(`${apiBase}/api/search`);
  assert.equal(noQuery.status, 400);

  await fetch(`${apiBase}/api/articles/${encodeURIComponent(result.id)}?withMedia=1`, { method: 'DELETE' });
});

test('网址记录接口：列表、忘掉记录、以及数据库统计', async () => {
  const url = `${fixtureBase}/db-article`;
  const result = await convertUrl(url, { engine: 'fetch', imageMode: 'local', store: true });
  const key = canonicalizeUrlForTest(url);

  const list = await (await fetch(`${apiBase}/api/urls?limit=100`)).json();
  assert.equal(list.data.available, true);
  const row = list.data.items.find((item) => item.url === key);
  assert.ok(
    row,
    `网址列表里应有刚抓的地址：${key}；实际有：${list.data.items.map((i) => i.url).join(' | ')}`,
  );
  assert.equal(
    row.articleId,
    result.id,
    `记录应指向刚抓的文章；实际记录：${JSON.stringify(row)}`,
  );
  assert.ok(row.fetchCount >= 1);
  assert.ok(row.articleUrl.includes('/api/articles/'));

  // 忘掉记录（文章保留）
  const del = await fetch(`${apiBase}/api/urls/${row.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  const after = await (await fetch(`${apiBase}/api/urls/check?url=${encodeURIComponent(key)}`)).json();
  assert.equal(after.data.known, false, '记录应已删除');
  const stillThere = await fetch(`${apiBase}/api/articles/${encodeURIComponent(result.id)}`);
  assert.equal(stillThere.status, 200, '忘掉网址记录不应影响已存档的文章');

  const missing = await fetch(`${apiBase}/api/urls/99999999`, { method: 'DELETE' });
  assert.equal(missing.status, 404);

  const stats = await (await fetch(`${apiBase}/api/stats`)).json();
  assert.equal(stats.data.database.available, true);
  assert.ok(stats.data.database.urls >= 1, '统计里应有网址数量');

  const health = await (await fetch(`${apiBase}/healthz`)).json();
  assert.equal(health.database.available, true);

  await fetch(`${apiBase}/api/articles/${encodeURIComponent(result.id)}?withMedia=1`, { method: 'DELETE' });
});

test('filterAds=false：跳过激进清洗与"相关阅读"段落删除', async () => {
  const result = await convertUrl(`${fixtureBase}/article`, {
    engine: 'fetch',
    filterAds: false,
    imageMode: 'local',
    store: false,
  });
  assert.match(result.markdown, /第一段正文内容/);
  assert.equal(result.stats.extract.removedJunkSections, 0);
  assert.equal(result.stats.extract.removedByToken, 0);
  assert.ok(result.warnings.some((w) => w.includes('filterAds')));
});

/* ---------------- 6. 删除功能 ---------------- */

test('删除文章：withMedia=1 只删它独占的图床文件，共用的必须保留', async () => {
  // force：这两篇要作为"独立的两篇文章"来验证图床共用，不能被"内容未变复用"合并成一篇
  // mediaLayout=flat：本用例验证的是内容寻址下的引用计数（folder 布局按文章整目录删，另有用例覆盖）
  const first = await convertUrl(`${fixtureBase}/article`, { engine: 'fetch', imageMode: 'local', force: true, mediaLayout: 'flat' });
  const second = await convertUrl(`${fixtureBase}/article`, { engine: 'fetch', imageMode: 'local', force: true, mediaLayout: 'flat' });
  assert.notEqual(first.id, second.id, 'force 时应该落成两篇独立文章');

  const firstMeta = (await (await fetch(`${apiBase}/api/articles/${encodeURIComponent(first.id)}`)).json()).data;
  const secondMeta = (await (await fetch(`${apiBase}/api/articles/${encodeURIComponent(second.id)}`)).json()).data;
  const hashesA = new Set(firstMeta.media.map((m) => m.hash));
  const hashesB = new Set(secondMeta.media.map((m) => m.hash));
  assert.ok(hashesA.size >= 3, `应有多个媒体：${hashesA.size}`);
  assert.deepEqual([...hashesA].sort(), [...hashesB].sort(), '两个测试用例应共用同一批图床文件');

  // 造一个"独占"文件：只挂在第一篇文章的 meta 里
  const store = mediaStore;
  const unique = await store.put({
    sourceUrl: 'https://example.com/unique-delete-test.png',
    buffer: Buffer.alloc(256, 9),
    mime: 'image/png',
    kind: 'image',
    ext: '.png',
  });
  const metaA = await import('node:fs/promises').then((fs) =>
    fs.readFile(articleStore.articleDir(first.id) + `${path.sep}meta.json`, 'utf8'),
  );
  const parsedA = JSON.parse(metaA);
  parsedA.media.push({ kind: 'image', file: unique.f, hash: unique.h, bytes: unique.b, mime: unique.m, localUrl: unique.url });
  const storedArticles = await import('../src/storage/articles.js');
  await storedArticles.articleStore.save({ id: first.id, meta: parsedA, markdown: 'x' });

  const before = store.list({ limit: 1000 }).total;
  const res = await fetch(`${apiBase}/api/articles/${encodeURIComponent(first.id)}?withMedia=1`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.removed, true);
  assert.equal(body.data.media.removed, 1, `应删除 1 个独占文件，实际 ${JSON.stringify(body.data.media)}`);
  assert.ok(body.data.media.keptBecauseShared >= 2, '共用的文件应被保留');
  assert.ok(store.getByHash(unique.h) === null, '独占文件应已从图床移除');
  const after = store.list({ limit: 1000 }).total;
  assert.equal(after, before - 1);

  // 第二篇还引用着那些共用文件：删它之后，只要没有别的文章还在引用，就应该清掉
  const res2 = await fetch(`${apiBase}/api/articles/${encodeURIComponent(second.id)}?withMedia=1`, { method: 'DELETE' });
  assert.equal(res2.status, 200);
  const body2 = await res2.json();
  const stillReferenced = await articleStore.referencedMediaHashes();
  for (const hash of hashesB) {
    const record = store.getByHash(hash);
    if (stillReferenced.has(hash)) {
      assert.ok(record, `仍被其它文章引用的文件不能删：${hash}`);
    } else {
      assert.equal(record, null, `已无人引用的文件应被删除：${hash}`);
    }
  }
  // keptBecauseShared 统计的是「文件数」：同一份内容在 folder 布局下每篇文章各存一份、
  // flat 布局下另有一份内容寻址副本，所以这里按文件数比对，而不是按 hash 去重后的条数。
  const keptFiles = mediaStore
    .list({ limit: Number.MAX_SAFE_INTEGER })
    .items.filter((item) => hashesB.has(item.hash) && stillReferenced.has(item.hash)).length;
  assert.equal(
    body2.data.media.keptBecauseShared,
    keptFiles,
    '统计的"因共用而保留"数量应与实际引用情况一致',
  );
});

test('删除文章：默认不删图床文件；不存在的 id 返回 404', async () => {
  const article = await convertUrl(`${fixtureBase}/article`, { engine: 'fetch', imageMode: 'local' });
  const hashes = article.media.map((m) => m.hash);
  const res = await fetch(`${apiBase}/api/articles/${encodeURIComponent(article.id)}`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.withMedia, false);
  assert.equal(body.data.media, null);
  for (const hash of hashes) {
    assert.ok(mediaStore.getByHash(hash), `默认删除不应动图床文件：${hash}`);
  }

  const missing = await fetch(`${apiBase}/api/articles/20240101-000000-ffffff-不存在`, { method: 'DELETE' });
  assert.equal(missing.status, 404);
});

test('批量删除：/api/articles/delete 返回逐条结果', async () => {
  const a = await convertUrl(`${fixtureBase}/article`, { engine: 'fetch', imageMode: 'none', force: true });
  const b = await convertUrl(`${fixtureBase}/article`, { engine: 'fetch', imageMode: 'none', force: true });
  assert.notEqual(a.id, b.id, 'force 时应该落成两篇独立文章');
  const res = await fetch(`${apiBase}/api/articles/delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: [a.id, b.id, '20240101-000000-ffffff-不存在'], withMedia: false }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.requested, 3);
  assert.equal(body.data.deleted, 2);
  assert.equal(body.data.failed.length, 1);
  assert.match(body.data.failed[0].message, /文章不存在/);

  const empty = await fetch(`${apiBase}/api/articles/delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: [] }),
  });
  assert.equal(empty.status, 400);
});

test('删除单个图床文件：被引用时拒绝（409），force=1 才强删', async () => {
  const article = await convertUrl(`${fixtureBase}/article`, { engine: 'fetch', imageMode: 'local' });
  const hash = article.media[0].hash;
  const file = article.media[0].file;

  const refused = await fetch(`${apiBase}/api/media/${encodeURIComponent(file)}`, { method: 'DELETE' });
  assert.equal(refused.status, 409, '被引用的文件应拒绝删除');
  const refusedBody = await refused.json();
  assert.equal(refusedBody.error.code, 'media_in_use');
  assert.ok(mediaStore.getByHash(hash), '拒绝后文件应还在');

  // 用 hash 前缀也能定位
  const forced = await fetch(`${apiBase}/api/media/${hash.slice(0, 12)}?force=1`, { method: 'DELETE' });
  assert.equal(forced.status, 200);
  const forcedBody = await forced.json();
  assert.equal(forcedBody.data.removed, true);
  assert.equal(forcedBody.data.forced, true);
  assert.equal(mediaStore.getByHash(hash), null);

  const missing = await fetch(`${apiBase}/api/media/deadbeefdeadbeef`, { method: 'DELETE' });
  assert.equal(missing.status, 404);

  await fetch(`${apiBase}/api/articles/${encodeURIComponent(article.id)}?withMedia=1`, { method: 'DELETE' });
});

test('孤儿图床回收：dryRun 只统计，正式执行清掉无引用文件', async () => {
  // 造两个没有文章引用的文件
  const orphanA = await mediaStore.put({
    sourceUrl: 'https://example.com/orphan-a.png',
    buffer: Buffer.alloc(128, 1),
    mime: 'image/png',
    kind: 'image',
    ext: '.png',
  });
  const orphanB = await mediaStore.put({
    sourceUrl: 'https://example.com/orphan-b.png',
    buffer: Buffer.alloc(128, 2),
    mime: 'image/png',
    kind: 'image',
    ext: '.png',
  });

  const dry = await fetch(`${apiBase}/api/media/gc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dryRun: true }),
  });
  const dryBody = await dry.json();
  assert.equal(dryBody.data.dryRun, true);
  assert.ok(dryBody.data.orphanFiles >= 2, `应发现孤儿文件：${JSON.stringify(dryBody.data)}`);
  assert.ok(mediaStore.getByHash(orphanA.h), 'dryRun 不应删除文件');

  const real = await fetch(`${apiBase}/api/media/gc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  const realBody = await real.json();
  assert.ok(realBody.data.removed >= 2, `应删除孤儿文件：${JSON.stringify(realBody.data)}`);
  assert.equal(mediaStore.getByHash(orphanA.h), null);
  assert.equal(mediaStore.getByHash(orphanB.h), null);
});

/* ---------------- 7. REST 接口 ---------------- */

test('POST /api/convert 返回 JSON 结果', async () => {
  const res = await fetch(`${apiBase}/api/convert`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: `${fixtureBase}/article`, engine: 'fetch', includeVideos: false }),
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.match(json.data.markdown, /第一段正文内容/);
  assert.ok(json.data.markdownUrl.includes('/api/articles/'));
});

test('POST /api/convert 支持 Accept: text/markdown 直接返回正文', async () => {
  const res = await fetch(`${apiBase}/api/convert`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/markdown' },
    body: JSON.stringify({ url: `${fixtureBase}/article`, engine: 'fetch', imageMode: 'remote' }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/markdown/);
  assert.ok(res.headers.get('x-article-id'));
  const text = await res.text();
  assert.match(text, /^---/);
  assert.match(text, /第一段正文内容/);
});

test('GET /api/articles 列表与 /api/articles/:id/markdown 正文', async () => {
  const listRes = await fetch(`${apiBase}/api/articles?limit=5`);
  const list = await listRes.json();
  assert.equal(list.ok, true);
  assert.ok(list.data.total >= 1);
  const id = list.data.items[0].id;

  const mdRes = await fetch(`${apiBase}/api/articles/${id}/markdown`);
  assert.equal(mdRes.status, 200);
  assert.match(mdRes.headers.get('content-type') || '', /text\/markdown/);
  const md = await mdRes.text();
  assert.ok(md.length > 100);

  const delRes = await fetch(`${apiBase}/api/articles/${id}`, { method: 'DELETE' });
  assert.equal(delRes.status, 200);
  const missing = await fetch(`${apiBase}/api/articles/${id}`);
  assert.equal(missing.status, 404);
});

test('接口错误处理：缺 url / 非法 URL / 404', async () => {
  const noUrl = await fetch(`${apiBase}/api/convert`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(noUrl.status, 400);
  const noUrlBody = await noUrl.json();
  assert.equal(noUrlBody.ok, false);
  assert.equal(noUrlBody.error.code, 'bad_request');

  const badUrl = await fetch(`${apiBase}/api/convert`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'ftp://example.com/x' }),
  });
  assert.equal(badUrl.status, 400);

  const notFound = await fetch(`${apiBase}/api/nope`);
  assert.equal(notFound.status, 404);
});

test('SSRF：即使开启内网访问，也拒绝非 http(s) 协议', async () => {
  await assert.rejects(() => assertUrlAllowed('file:///etc/passwd'), /协议/);
});

test('GET /healthz 与 /api/stats 可用', async () => {
  const health = await (await fetch(`${apiBase}/healthz`)).json();
  assert.equal(health.status, 'ok');
  assert.ok(health.version);
  // 自建解析器是否已配置：小程序/脚本靠这个判断要不要走小红书解析
  assert.equal(health.xiaohongshuApi.configured, false, '测试环境没配 XIAOHONGSHU_API，应报 false');
  assert.equal(typeof health.webhook.configured, 'boolean');
  // 用来判断"容器里到底跑的是哪一版"（旧镜像是最常见的排查误区）
  assert.ok(health.build && ['image', 'source'].includes(health.build.source), '应报告构建来源');
  assert.ok(!Number.isNaN(Date.parse(health.build.at)), `构建时间应可解析：${health.build.at}`);

  const stats = await (await fetch(`${apiBase}/api/stats`)).json();
  assert.equal(stats.ok, true);
  assert.ok(stats.data.media.files >= 2);
});

/* ---------------- 5. 无头浏览器引擎（可选） ---------------- */

test('browser 引擎：Chromium 渲染 + 网络层广告拦截 + 图片字节捕获', { skip: process.env.TEST_BROWSER !== '1' }, async () => {
  const result = await convertUrl(`${fixtureBase}/article`, {
    engine: 'browser',
    imageMode: 'local',
    store: false,
    scroll: false,
  });
  assert.match(result.markdown, /第一段正文内容/);
  assert.ok(!result.markdown.includes('ADVERTISEMENT'));
  assert.ok(result.stats.adsBlocked >= 1, `应拦截广告请求，实际 ${result.stats.adsBlocked}`);
  assert.ok(result.media.some((m) => m.origin === 'capture' || m.origin === 'cache'), '应存在网络层捕获或缓存命中的媒体');
  assert.ok(result.media.length >= 4);
  // 背景图配图在页面内就要被转成 <img>（有布局信息，可以按尺寸过滤）
  assert.ok(result.stats.bgImagesConverted >= 1, `应转换背景图配图，实际 ${result.stats.bgImagesConverted}`);
  assert.ok(
    result.media.some((m) => m.sourceUrl.includes('/img/fourth.png')),
    '浏览器引擎也应抓到背景图 div 里的配图',
  );
});

test('浏览器空闲回收后必须能自动重启（NAS 上"空闲一段时间后抓不了"的回归测试）', { skip: process.env.TEST_BROWSER !== '1' }, async () => {
  const { browserPool } = await import('../src/browser/pool.js');
  const original = browserPool.idleCloseMs;
  browserPool.idleCloseMs = 1500;
  try {
    const first = await convertUrl(`${fixtureBase}/article`, {
      engine: 'browser',
      imageMode: 'none',
      store: false,
      scroll: false,
    });
    assert.match(first.markdown, /第一段正文内容/);
    assert.equal(browserPool.status.connected, true, '转换后浏览器应处于已启动状态');

    await new Promise((resolve) => setTimeout(resolve, 3000));
    assert.equal(browserPool.status.connected, false, '空闲超过阈值后应关闭浏览器释放内存');
    assert.equal(browserPool.status.shuttingDown, false, '空闲回收不能把浏览器池标记为已关闭');

    const second = await convertUrl(`${fixtureBase}/article`, {
      engine: 'browser',
      imageMode: 'none',
      store: false,
      scroll: false,
    });
    assert.match(second.markdown, /第一段正文内容/, '空闲关闭后必须能自动重新拉起浏览器');
    assert.equal(browserPool.status.connected, true);
  } finally {
    browserPool.idleCloseMs = original;
  }
});

/* ---------------- 9. 站点适配器（抖音 / 小红书） ---------------- */

const { collectSiteMedia, siteAdapterFor, extractSiteMedia } = await import('../src/pipeline/sites/index.js');

/** 把页面数据塞进抖音那种 window._ROUTER_DATA 里 */
function douyinHtml(data, { rawState = null } = {}) {
  const state = rawState ?? JSON.stringify(data);
  return `<!doctype html><html><head><title>抖音</title></head><body>
    <div id="app"><div class="xgplayer"></div></div>
    <script>window._ROUTER_DATA = ${state};</script>
  </body></html>`;
}

const DOUYIN_VIDEO = {
  loaderData: {
    'video_(id)/page': {
      videoInfoRes: {
        item_list: [
          {
            aweme_id: '7678328385344651819',
            desc: '这条视频的文案',
            author: { nickname: '某作者' },
            video: {
              play_addr: {
                url_list: [
                  'https://v3-web.douyinvod.com/abc123/video/tos/cn/tos-cn-ve-15/xyz789/',
                  'https://v26-web.douyinvod.com/abc123/video/tos/cn/tos-cn-ve-15/xyz789/',
                ],
              },
              cover: { url_list: ['https://p3-sign.douyinpic.com/tos-cn-i-0813/cover1~tplv-dy-aweme-images:q75.webp'] },
            },
          },
          {
            // 推荐流里的其它作品：不能被抓进来
            aweme_id: 'other-aweme',
            desc: '推荐给别人的视频',
            video: { play_addr: { url_list: ['https://v3-web.douyinvod.com/recommend/video/tos/cn/other/'] } },
          },
        ],
      },
    },
  },
};

test('站点适配器：按域名选择，短链与仿冒域名都要认对', () => {
  assert.equal(siteAdapterFor('https://www.douyin.com/video/7678328385344651819')?.id, 'douyin');
  assert.equal(siteAdapterFor('https://v.douyin.com/iRabcdef/')?.id, 'douyin');
  assert.equal(siteAdapterFor('https://www.iesdouyin.com/share/video/123')?.id, 'douyin');
  assert.equal(siteAdapterFor('https://www.xiaohongshu.com/explore/68f0abcdef')?.id, 'xiaohongshu');
  assert.equal(siteAdapterFor('https://xhslink.com/a/abcdef')?.id, 'xiaohongshu');
  assert.equal(siteAdapterFor('https://notdouyin.com.evil.example/video/1'), null, '不能被子域名后缀骗到');
  assert.equal(siteAdapterFor('https://www.toutiao.com/article/123')?.id ?? null, null, '头条不在适配列表里');
});

test('站点适配器：抖音视频页 —— 取到主视频、封面与文案，推荐流不能混进来', async () => {
  const result = await collectSiteMedia({ url: 'https://www.douyin.com/video/7678328385344651819', html: douyinHtml(DOUYIN_VIDEO) });

  assert.equal(result.adapter, 'douyin');
  assert.equal(result.items.length, 1, `只应抓到主体的那一个视频，实际 ${JSON.stringify(result.items)}`);
  const video = result.items[0];
  assert.equal(video.kind, 'video');
  assert.match(video.url, /^https:\/\/v3-web\.douyinvod\.com\/.*\/video\/tos\/cn\//);
  assert.match(video.cover, /^https:\/\/p3-sign\.douyinpic\.com\//, '应带上封面，供播放器当首帧');
  assert.equal(result.caption, '这条视频的文案');
  assert.equal(result.author, '某作者');
  assert.ok(!JSON.stringify(result.items).includes('recommend'), '推荐流里的视频不能被抓');
});

test('站点适配器：抖音图文作品 —— 按顺序取到全部图片', async () => {
  const html = douyinHtml({
    loaderData: {
      'note_(id)/page': {
        videoInfoRes: {
          item_list: [
            {
              desc: '图文作品',
              images: [
                { url_list: ['https://p3-sign.douyinpic.com/tos-cn-i-0813/a1~tplv-dy-aweme-images:q75.webp?biz=1'] },
                { url_list: ['https://p3-sign.douyinpic.com/tos-cn-i-0813/a2~tplv-dy-aweme-images:q75.webp?biz=1'] },
                { url_list: ['https://p3-sign.douyinpic.com/tos-cn-i-0813/a3~tplv-dy-aweme-images:q75.webp', 'https://p6-sign.douyinpic.com/tos-cn-i-0813/a3~tplv-dy-aweme-images:q75.webp'] },
              ],
            },
          ],
        },
      },
    },
  });
  const result = await collectSiteMedia({ url: 'https://www.douyin.com/note/123', html });

  assert.equal(result.items.length, 3);
  assert.deepEqual(result.items.map((i) => i.kind), ['image', 'image', 'image']);
  assert.ok(result.items[0].url.includes('/a1~'), '应按页面数据里的顺序');
  assert.ok(result.items[1].url.includes('/a2~'));
  assert.ok(result.items[2].url.includes('/a3~'));
  assert.ok(result.items.every((i) => /^https:\/\/p3-sign\.douyinpic\.com\//.test(i.url)), '同一张图多套 CDN 时取主域名');
});

test('站点适配器：小红书笔记 —— imageList + video.stream.h264 都要拿到', async () => {
  const html = `<!doctype html><html><body><div id="app"></div>
    <script>window.__INITIAL_STATE__ = ${JSON.stringify({
      note: {
        noteDetailMap: {
          '68f0abcdef': {
            note: {
              noteId: '68f0abcdef',
              title: '笔记标题',
              desc: '笔记正文',
              user: { nickname: '小红薯' },
              imageList: [
                { urlDefault: 'https://sns-img-bd.xhscdn.com/aaa?imageView2/2/w/1080/format/webp' },
                { urlDefault: 'https://sns-img-bd.xhscdn.com/bbb' },
              ],
              video: {
                media: {
                  stream: {
                    h264: [{ masterUrl: 'https://sns-video-bd.xhscdn.com/stream/110/259/01e8', backupUrls: [] }],
                    h265: [{ masterUrl: 'https://sns-video-bd.xhscdn.com/stream/110/259/01e8hevc' }],
                  },
                },
              },
            },
          },
        },
      },
    })};</script></body></html>`;

  const result = await collectSiteMedia({ url: 'https://www.xiaohongshu.com/explore/68f0abcdef', html });
  assert.equal(result.adapter, 'xiaohongshu');
  assert.equal(result.items.filter((i) => i.kind === 'image').length, 2, `图片应取到 2 张：${JSON.stringify(result.items)}`);
  assert.equal(result.items.filter((i) => i.kind === 'video').length, 1, '视频应取到 1 个');
  assert.ok(result.items[0].url.includes('/aaa'), '图片顺序应与 imageList 一致');
  assert.ok(result.items.some((i) => i.url.includes('/stream/110/259/01e8')), '应取到 h264 masterUrl');
  assert.equal(result.caption, '笔记正文');
  assert.equal(result.author, '小红薯');
  // 视频候选要按画质排好序返回（供"优先挑能播放的 H.264"用）
  assert.ok(Array.isArray(result.videoCandidates) && result.videoCandidates.length >= 1, '应回传视频候选列表');
});

test('自建小红书解析器：POST JSON 契约 + 图文作品映射（标题/正文/作者/图片）', async () => {
  const { collectViaXhsApi } = await import('../src/pipeline/sites/xhs-api.js');
  const saved = config.xiaohongshuApi;
  config.xiaohongshuApi = `${fixtureBase}/xhs/detail`;
  try {
    xhsApiCalls.length = 0;
    const note = 'https://www.xiaohongshu.com/explore/6aad17f90000000026023c7d?xsec_token=abc';
    const r = await collectViaXhsApi(note);

    assert.equal(r.reason, '', `解析应成功：${r.reason} ${r.message}`);
    assert.equal(r.title, '解析器给的标题');
    assert.equal(r.caption, '解析器给的正文');
    assert.equal(r.author, '解析器作者');
    assert.equal(r.noteId, '6aad17f90000000026023c7d');
    assert.equal(r.items.length, 2, `应取到 2 张图：${JSON.stringify(r.items)}`);
    assert.ok(r.items.every((i) => i.kind === 'image'), '图文作品的下载地址都是图片');

    // 契约：POST + JSON 正文 + {url, download:false}（GET 会被 405 拒绝，实测如此）
    assert.equal(xhsApiCalls.length, 1, '应该只请求解析器一次');
    const call = xhsApiCalls[0];
    assert.equal(call.method, 'POST', '解析器只收 POST');
    assert.ok(call.contentType.includes('application/json'), `content-type 应是 JSON：${call.contentType}`);
    assert.equal(call.body.url, note, 'url 参数要原样传给解析器');
    assert.equal(call.body.download, false, '不能让解析器自己下载文件（我们只取直链）');
  } finally {
    config.xiaohongshuApi = saved;
  }
});

test('自建解析器：视频作品只取视频直链，封面不当独立文件', async () => {
  const { collectViaXhsApi } = await import('../src/pipeline/sites/xhs-api.js');
  const saved = config.xiaohongshuApi;
  config.xiaohongshuApi = `${fixtureBase}/xhs/detail`;
  try {
    const r = await collectViaXhsApi('https://www.xiaohongshu.com/explore/68f0video-note');
    assert.equal(r.items.length, 1, `视频笔记应只留视频：${JSON.stringify(r.items)}`);
    assert.equal(r.items[0].kind, 'video');
    assert.ok(r.items[0].url.includes('01e8video.mp4'), '取的是视频直链');
    assert.equal(r.items[0].cover, 'https://sns-img-bd.xhscdn.com/cover-note', '封面作为 poster 附在视频上');
    assert.equal(r.kind, 'video');
    assert.equal(r.title, '解析器给的视频标题');
  } finally {
    config.xiaohongshuApi = saved;
  }
});

test('自建解析器：data 是空对象也算失败，并自动回退到页面解析', async () => {
  const saved = config.xiaohongshuApi;
  config.xiaohongshuApi = `${fixtureBase}/xhs/detail`;
  try {
    // 模拟真实返回：作品取不到时 data 是 {}（空对象），容易被误判成"成功"
    const failing = await collectSiteMedia({
      url: 'https://www.xiaohongshu.com/explore/6aad17missing',
      originalUrl: 'https://www.xiaohongshu.com/explore/6aad17missing',
      html: '<html><body><div id="app"></div></body></html>',
    });
    assert.equal(failing.items.length, 0, '解析器没结果时不该凭空造出媒体');
    assert.ok(
      (failing.failures || []).some((f) => f.startsWith('xhs_api:')),
      `失败原因里应记录解析器这一步：${JSON.stringify(failing.failures)}`,
    );

    // 解析器认不出原始链接（短链）时，同样要回退
    const unparsed = await collectSiteMedia({
      url: 'https://www.xiaohongshu.com/explore/68f0abcdef',
      originalUrl: 'https://xhslink.cn/o/unknown',
      html: '<html><body></body></html>',
    });
    assert.equal(unparsed.items.length, 0);
    assert.ok((unparsed.failures || []).some((f) => f.startsWith('xhs_api:')));

    // 解析器失败、页面数据里有媒体 → 回退这条路要真的能拿到东西
    const fallbackHtml = `<html><body><div id="app"></div><script>window.__INITIAL_STATE__ = ${JSON.stringify({
      note: {
        noteDetailMap: {
          x: {
            note: {
              noteId: 'x',
              title: '页面里的标题',
              desc: '页面里的正文',
              imageList: [{ urlDefault: 'https://sns-img-bd.xhscdn.com/fallback1' }],
            },
          },
        },
      },
    })};</script></body></html>`;
    const fell = await collectSiteMedia({
      url: 'https://www.xiaohongshu.com/explore/6aad17missing',
      originalUrl: 'https://www.xiaohongshu.com/explore/6aad17missing',
      html: fallbackHtml,
    });
    assert.equal(fell.source, 'noteDetailMap', '解析器没结果时应退回页面解析');
    assert.equal(fell.items.length, 1);
    assert.ok(fell.items[0].url.includes('fallback1'));
  } finally {
    config.xiaohongshuApi = saved;
  }
});

test('自建解析器：解析成功时优先用它，不再走页面解析', async () => {
  const saved = config.xiaohongshuApi;
  config.xiaohongshuApi = `${fixtureBase}/xhs/detail`;
  try {
    // 页面数据里放一张"假"图：解析器成功时它不该被采用
    const html = `<html><body><script>window.__INITIAL_STATE__ = ${JSON.stringify({
      note: { noteDetailMap: { x: { note: { noteId: 'x', imageList: [{ urlDefault: 'https://sns-img-bd.xhscdn.com/from-page' }] } } } },
    })};</script></body></html>`;
    const r = await collectSiteMedia({
      url: 'https://www.xiaohongshu.com/explore/6aad17f90000000026023c7d',
      originalUrl: 'https://www.xiaohongshu.com/explore/6aad17f90000000026023c7d',
      html,
    });
    assert.equal(r.source, 'xhs_api');
    assert.equal(r.title, '解析器给的标题');
    assert.equal(r.items.length, 2);
    assert.ok(!r.items.some((i) => i.url.includes('from-page')), '解析器成功时不该混入页面数据里的地址');
  } finally {
    config.xiaohongshuApi = saved;
  }
});

test('自建解析器：登录页地址与分享文案都能整理成规范笔记地址', async () => {
  const { resolveXhsNoteUrl, extractXhsLink, noteUrlFromLocation, noteIdOf } = await import(
    '../src/pipeline/sites/xhs-api.js'
  );
  const note = 'https://www.xiaohongshu.com/explore/6aad17f90000000026023c7d?xsec_token=CB8%3D';

  // 已经是规范地址：原样返回
  const direct = await resolveXhsNoteUrl(note);
  assert.equal(direct.url, note);
  assert.equal(direct.expanded, false);
  assert.equal(direct.noteId, '6aad17f90000000026023c7d');

  // 未登录时短链会一路跳到登录页，真正的笔记地址藏在 redirectPath 里（带着 xsec_token）
  const login = `https://www.xiaohongshu.com/login?redirectPath=${encodeURIComponent(note)}`;
  const resolved = await resolveXhsNoteUrl(login);
  assert.equal(resolved.expanded, true, '登录页地址应被解开');
  assert.ok(resolved.url.startsWith('https://www.xiaohongshu.com/explore/6aad17f90000000026023c7d'), `解开后的地址：${resolved.url}`);
  // redirectPath 是把整条笔记地址一起编码的，所以解开后 token 里的 %3D 会还原成字面量 =
  assert.equal(new URL(resolved.url).searchParams.get('xsec_token'), 'CB8=', 'xsec_token 必须保留，否则解析器取不到作品');
  assert.equal(resolved.noteId, '6aad17f90000000026023c7d');
  assert.equal(resolved.xsecToken, 'CB8=');

  // 整段分享文案
  const share = `77 小红薯发布了一篇小红书笔记，快来看吧！ 😆 https://xhslink.cn/o/VaMdRMLxyg 复制本条信息打开小红书`;
  assert.equal(extractXhsLink(share), 'https://xhslink.cn/o/VaMdRMLxyg');
  assert.equal(extractXhsLink('没有链接的一段话'), '');

  // 各种笔记地址形态都要认得出 ID
  assert.equal(noteIdOf('https://www.xiaohongshu.com/discovery/item/6aad17f90000000026023c7d?x=1'), '6aad17f90000000026023c7d');
  assert.equal(noteIdOf('https://www.xiaohongshu.com/explore/6aad17f90000000026023c7d'), '6aad17f90000000026023c7d');
  assert.equal(noteIdOf('https://www.xiaohongshu.com/user/profile/5eb1fff5'), '');
  assert.equal(noteUrlFromLocation(''), '');
  assert.equal(noteUrlFromLocation('https://www.xiaohongshu.com/explore/68f0abcdef1234abcd'), 'https://www.xiaohongshu.com/explore/68f0abcdef1234abcd');
});

test('标题挑选：登录页占位标题要让位给作品标题', async () => {
  const { pickTitle, isPlaceholderTitle, isLoginWallUrl } = await import('../src/utils/title.js');

  // 实测：小红书未登录时页面标题就是这句
  assert.equal(pickTitle('小红书 - 你的生活兴趣社区', '我被这木质小家的氛围给硬控了！'), '我被这木质小家的氛围给硬控了！');
  assert.equal(pickTitle('抖音 - 记录美好生活', '真正的视频标题'), '真正的视频标题');
  assert.equal(pickTitle('正常文章标题', '站点给的标题'), '正常文章标题', '正常标题优先级更高，不该被顶掉');
  assert.equal(pickTitle('', '', 'xhslink.cn'), 'xhslink.cn', '全都不可用时退回域名兜底');
  assert.equal(pickTitle(), '');
  assert.ok(isPlaceholderTitle('小红书 - 你的生活兴趣社区'));
  assert.ok(isPlaceholderTitle('登录'));
  assert.ok(isPlaceholderTitle('安全限制'), 'NAS 实测：小红书风控页标题就是「安全限制」，必须当占位标题');
  assert.ok(isPlaceholderTitle('访问频繁'));
  assert.ok(isPlaceholderTitle('Loading'));
  assert.ok(isPlaceholderTitle('Just a moment...'), 'Cloudflare 人机校验页');
  assert.ok(isPlaceholderTitle('OK'), '拉丁字母太短一律当噪声');
  assert.ok(!isPlaceholderTitle('我的第一篇笔记'));
  // 回归：两个字的中文标题是真标题（实测作品标题「龙湾」被 4 字下限误判，
  // 导致文章标题掉成 www.xiaohongshu.com、素材目录也变成域名）
  assert.ok(!isPlaceholderTitle('龙湾'), '2 个汉字是正经标题，绝不能当占位');
  assert.ok(!isPlaceholderTitle('周末'));
  assert.equal(pickTitle('龙湾', 'www.xiaohongshu.com'), '龙湾', '真标题优先于域名兜底');
  assert.ok(isLoginWallUrl('https://www.xiaohongshu.com/login?redirectPath=https%3A%2F%2Fwww.xiaohongshu.com%2Fexplore%2F1'));
  assert.ok(!isLoginWallUrl('https://www.xiaohongshu.com/explore/68f0abcdef'));
});

test('自建解析器：按请求覆盖地址（服务端没配 XIAOHONGSHU_API 也能用）', async () => {
  const saved = config.xiaohongshuApi;
  config.xiaohongshuApi = '';
  try {
    const { xhsApiEnabled } = await import('../src/pipeline/sites/xhs-api.js');
    assert.equal(xhsApiEnabled(), false, '先确认服务端确实没配');
    const r = await collectSiteMedia({
      url: 'https://www.xiaohongshu.com/explore/6aad17f90000000026023c7d',
      originalUrl: 'https://www.xiaohongshu.com/explore/6aad17f90000000026023c7d',
      html: '<html><body></body></html>',
      xhsApiUrl: `${fixtureBase}/xhs/detail`,
    });
    assert.equal(r.source, 'xhs_api', '请求里带了 xhsApiUrl 就该走解析器');
    assert.equal(r.items.length, 2);

    // 请求级地址不合法（非 http(s)）时不应生效
    const bad = normalizeOptions({ xhsApiUrl: 'javascript:alert(1)' });
    assert.equal(bad.xhsApiUrl, '', '只有 http(s) 地址才认');
    const good = normalizeOptions({ xhsApiUrl: `  ${fixtureBase}/xhs/detail  ` });
    assert.equal(good.xhsApiUrl, `${fixtureBase}/xhs/detail`, '应去掉首尾空格');
  } finally {
    config.xiaohongshuApi = saved;
  }
});

test('自建解析器：连不上时给出的提示要能直接照做（ENOTFOUND / 端口不通 / 证书）', async () => {
  const { explainXhsApiFailure } = await import('../src/pipeline/sites/xhs-api.js');
  const base = 'http://xhs-parser.example.com:5556/xhs/detail';

  const dns = explainXhsApiFailure('ENOTFOUND', base);
  assert.match(dns, /xhs-parser\.example\.com:5556/, '提示里要带出具体地址');
  assert.match(dns, /extra_hosts/, '要给出 extra_hosts 这种能直接抄的做法');
  assert.match(dns, /IPv6/, '要提醒"域名只有 IPv6 时容器连不通"这个实测坑');

  const refused = explainXhsApiFailure('ECONNREFUSED', base);
  assert.match(refused, /局域网 IPv4|端口/, '要给出端口/局域网地址的建议');

  const cert = explainXhsApiFailure('UNABLE_TO_VERIFY_LEAF_SIGNATURE', base);
  assert.match(cert, /证书/);

  assert.equal(explainXhsApiFailure('SOMETHING_ELSE', base), '', '认不出的错误不要硬编提示');
  assert.ok(explainXhsApiFailure('ENOTFOUND', 'not-a-url').includes('not-a-url'), '地址不合法时也要能给出文本');
});

test('小红书自建解析器：配了就只走解析器、完全不抓网页（标题/正文/图片全来自解析器）', async () => {
  const saved = config.xiaohongshuApi;
  config.xiaohongshuApi = `${fixtureBase}/xhs/detail`;
  try {
    /**
     * 这个地址是真实的小红书域名：如果代码真去抓网页，测试会因为没有页面可抓而失败/超时。
     * 能顺利跑完就证明"配了解析器就不碰网页"——NAS 上正是这样避开「安全限制」风控页的。
     */
    const r = await convertUrl('https://www.xiaohongshu.com/explore/6aad17f90000000026023c7d', {
      engine: 'fetch',
      imageMode: 'local',
      store: false,
      force: true,
    });

    assert.equal(r.title, '解析器给的标题', '标题应来自解析器，而不是页面占位标题');
    assert.equal(r.author, '解析器作者');
    assert.match(r.markdown, /解析器给的正文/, '正文应来自解析器的作品描述');
    // 回归：作品描述已经是正文了，不能再被当"导语"插一遍（短描述会踩到这条分支）
    assert.equal(
      (r.markdown.match(/解析器给的正文/g) || []).length,
      1,
      `描述不该重复出现：${JSON.stringify(r.markdown.slice(0, 200))}`,
    );
    assert.ok(
      r.warnings.some((w) => /解析器直接成文/.test(w)),
      `应提示"未抓取网页"：${JSON.stringify(r.warnings)}`,
    );
    const localized = r.media.filter((m) => m.localUrl.includes('/media/'));
    assert.equal(localized.length, 2, `解析器给的图片要落到图床：${JSON.stringify(r.media.map((m) => m.sourceUrl))}`);
    assert.ok(r.markdown.includes(localized[0].localUrl), '正文里的图片链接应改写成本地地址');
    // 回归：CDN 的 `?imageView2/format/png` 指令必须原样带出去，否则 CDN 会回原始 HEIC（打不开）
    assert.ok(
      localized.some((m) => m.sourceUrl.includes('imageView2/format/png')),
      `下载地址不能把 CDN 指令编码坏：${JSON.stringify(localized.map((m) => m.sourceUrl))}`,
    );
    assert.ok(
      localized.every((m) => m.mime !== 'image/heic'),
      `不该存下 HEIC：${JSON.stringify(localized.map((m) => [m.mime, m.bytes]))}`,
    );
  } finally {
    config.xiaohongshuApi = saved;
  }
});

test('小红书自建解析器：xhsParserOnly=false 时仍抓网页，解析器只当兜底', async () => {
  const saved = config.xiaohongshuApi;
  config.xiaohongshuApi = `${fixtureBase}/xhs/detail`;
  try {
    const r = await convertUrl(`${fixtureBase}/article`, {
      engine: 'fetch',
      store: false,
      force: true,
    });
    assert.match(r.markdown, /第一段正文内容/, '普通站点不受影响，照常抓网页');
    assert.ok(
      !r.warnings.some((w) => /解析器直接成文/.test(w)),
      `非小红书链接不该走解析器：${JSON.stringify(r.warnings)}`,
    );
  } finally {
    config.xiaohongshuApi = saved;
  }
});

test('小红书自建解析器：生成的页面结构正确（标题/段落/图片/视频/转义）', async () => {
  const { buildXhsParserHtml } = await import('../src/pipeline/sites/xhs-api.js');
  const saved = config.xiaohongshuApi;
  config.xiaohongshuApi = `${fixtureBase}/xhs/detail`;
  try {
    const built = await buildXhsParserHtml('https://www.xiaohongshu.com/explore/6aad17f90000000026023c7d');
    assert.ok(built, '解析成功时应返回页面');
    assert.equal(built.title, '解析器给的标题');
    assert.equal(built.items.length, 2);
    assert.match(built.html, /<title>解析器给的标题<\/title>/);
    assert.match(built.html, /<h1>解析器给的标题<\/h1>/);
    assert.match(built.html, /<p>解析器给的正文<\/p>/, '作品描述要成为正文段落');
    assert.equal((built.html.match(/<img /g) || []).length, 2, '两张图各一个 img');
    assert.ok(!/<script/i.test(built.html), '不该带脚本');
    assert.equal(built.noteId, '6aad17f90000000026023c7d');

    // 视频作品：写成 <video>，封面当 poster
    const video = await buildXhsParserHtml('https://www.xiaohongshu.com/explore/68f0video-note');
    assert.ok(video);
    assert.match(video.html, /<video src="[^"]*01e8video\.mp4"[^>]*poster="[^"]*cover-note"[^>]*controls>/);

    // 无标题笔记：标题退化成作品发布日期，且不带网页上的占位标题
    const noTitle = await buildXhsParserHtml('https://www.xiaohongshu.com/explore/6aaa07f90000000028000fdd-notitle');
    assert.ok(noTitle);
    assert.equal(noTitle.rawTitle, '', '这条笔记解析器确实没给标题');
    assert.equal(noTitle.title, '2026-09-16 03:07', '没有标题就用作品发布日期（到分钟，避免同日互撞）');
    assert.equal(noTitle.published, '2026-09-16 03:07:37');
    assert.match(noTitle.html, /<title>2026-09-16 03:07<\/title>/);
    assert.match(noTitle.html, /article:published_time" content="2026-09-16 03:07:37"/, '发布时间要带进页面，front matter 才有 published');

    // 解析器给不出内容时必须返回 null（调用方据此回退抓网页）
    const none = await buildXhsParserHtml('https://www.xiaohongshu.com/explore/6aad17missing');
    assert.equal(none, null);
  } finally {
    config.xiaohongshuApi = saved;
  }
});

test('小红书自建解析器：没有标题的笔记用发布日期当标题（不在文件名里出现冒号）', async () => {
  const saved = config.xiaohongshuApi;
  config.xiaohongshuApi = `${fixtureBase}/xhs/detail`;
  try {
    const r = await convertUrl('https://www.xiaohongshu.com/explore/6aaa07f90000000028000fdd-notitle', {
      engine: 'fetch',
      imageMode: 'local',
      store: false,
      force: true,
    });
    assert.equal(r.title, '2026-09-16 03:07', '标题应退化成发布日期');
    assert.notEqual(r.title, '小红书', '不能退化成站点名/占位标题');
    // front matter 里的时间由管线规范成 ISO（跟本机时区无关地比同一时刻）
    const published = r.markdown.match(/published: "([^"]+)"/)?.[1];
    assert.ok(published, 'front matter 应带上发布时间');
    assert.equal(new Date(published).toISOString(), new Date('2026-09-16T03:07:37+08:00').toISOString());
    assert.ok(r.media.length >= 1, '这条笔记的图片仍要正常落图床');
    // 冒号不能出现在路径里（Windows/SMB 非法）：slug 会把 03:07 变成 03-07
    assert.ok(
      r.media[0].localUrl.includes('2026-09-16-03-07'),
      `落盘路径应是无冒号的 slug：${r.media[0].localUrl}`,
    );
  } finally {
    config.xiaohongshuApi = saved;
  }
});

test('小红书自建解析器：发布时间缺失/格式怪时退回"今天"，不抛异常', async () => {
  const { xhsDateTitle, xhsPublishedAt } = await import('../src/pipeline/sites/xhs-api.js');
  assert.equal(xhsPublishedAt({ 发布时间: '刚刚' }), '', '认不出来就返回空串');
  assert.equal(xhsPublishedAt({}), '');
  assert.equal(xhsPublishedAt({ 发布时间: '2026-09-16T03:07:37' }), '2026-09-16 03:07:37', 'ISO 写法也要认');
  assert.equal(xhsPublishedAt({ 发布时间: '2026-9-6_3:07' }), '2026-09-06 03:07:00', '单位数要补零');
  assert.equal(xhsDateTitle({}, new Date('2026-09-21T10:05:00')), '2026-09-21 10:05');
  assert.equal(xhsDateTitle({ 发布时间: '坏数据' }, new Date('2026-09-21T10:05:00')), '2026-09-21 10:05');
});

test('自建解析器：链接缺 xsec_token 时要明确告诉用户怎么办', async () => {
  const mod = await import('../src/pipeline/sites/xhs-api.js');
  assert.equal(mod.hasXsecToken('https://www.xiaohongshu.com/explore/abc?xsec_token=XY%3D'), true);
  assert.equal(mod.hasXsecToken('https://www.xiaohongshu.com/discovery/item/abc'), false, '没 token = false');
  assert.equal(mod.hasXsecToken('https://www.xiaohongshu.com/explore/abc?xsec_token='), false, '空 token 也算没有');
  assert.equal(mod.hasXsecToken('not-a-url?xsec_token=XY'), true, '不是合法 URL 时退回正则判断');

  const r = await collectSiteMedia({
    url: 'https://www.xiaohongshu.com/explore/6aad17missing',
    originalUrl: 'https://www.xiaohongshu.com/explore/6aad17missing',
    html: '<html><body></body></html>',
    xhsApiUrl: `${fixtureBase}/xhs/detail`,
  });
  assert.equal(r.items.length, 0);
  assert.match(r.xhsApiHint, /xsec_token/, '缺 token 时必须给出"怎么拿带 token 的链接"的提示');
  assert.match(r.xhsApiHint, /分享/, '要告诉用户用 App 分享复制链接');
});

test('小红书自建解析器：两个字的中文标题必须保住（不能被当占位标题）', async () => {
  const saved = config.xiaohongshuApi;
  config.xiaohongshuApi = `${fixtureBase}/xhs/detail`;
  try {
    // 桩里 short-title 这条返回 作品标题: '龙湾'（实测案例）
    const r = await convertUrl('https://www.xiaohongshu.com/explore/6a9ec6a10000000026019ad1-short-title', {
      engine: 'fetch',
      imageMode: 'local',
      store: false,
      force: true,
    });
    assert.equal(r.title, '龙湾', '2 个汉字的标题不能掉成域名');
    assert.ok(!/xiaohongshu\.com/.test(r.title), '绝不能把域名当标题');
    assert.match(r.markdown, /# 龙湾/, '正文标题也要是作品标题');
    assert.ok(r.media.length >= 1);
    assert.ok(
      decodeURIComponent(r.media[0].localUrl).includes('龙湾'),
      `素材目录应用真标题（而不是域名）：${decodeURIComponent(r.media[0].localUrl)}`,
    );
  } finally {
    config.xiaohongshuApi = saved;
  }
});

test('URL 规范化：不能改动 CDN 的图片处理指令（否则会拿到原始 HEIC）', async () => {
  const { canonicalizeUrl } = await import('../src/utils/text.js');
  const xhs = 'https://ci.xiaohongshu.com/notes_pre_post/abc?imageView2/format/png';
  assert.equal(canonicalizeUrl(xhs), xhs, 'imageView2 指令必须原样保留（曾经被编码成 %2F…= 导致存成 HEIC）');
  assert.equal(
    canonicalizeUrl('https://ci.xiaohongshu.com/n/abc?imageView2/2/w/1080/format/jpg'),
    'https://ci.xiaohongshu.com/n/abc?imageView2/2/w/1080/format/jpg',
  );
  // 追踪参数仍然要删掉
  assert.equal(canonicalizeUrl('https://x.com/a.jpg?utm_source=wechat&id=5'), 'https://x.com/a.jpg?id=5');
  assert.equal(canonicalizeUrl('https://mmbiz.qpic.cn/x/y?wx_fmt=png&from=appmsg'), 'https://mmbiz.qpic.cn/x/y?wx_fmt=png');
  assert.equal(canonicalizeUrl('https://x.com/a.jpg?sig=a%2Fb%3D'), 'https://x.com/a.jpg?sig=a%2Fb%3D', '已编码的参数保持原样');
});

test('mp4 编码识别：能认出 H.264 / H.265，读不出来就返回空', async () => {
  const { mp4VideoCodec } = await import('../src/utils/mp4.js');

  // 造一个最小可用的 MP4 结构：moov > trak > mdia > (hdlr=vide, minf > stbl > stsd > sampleEntry)
  const box = (type, payload) => {
    const size = Buffer.alloc(4);
    size.writeUInt32BE(payload.length + 8, 0);
    return Buffer.concat([size, Buffer.from(type, 'ascii'), payload]);
  };
  const makeMp4 = (fourcc) => {
    const stsdHeader = Buffer.alloc(8); // version/flags + entry_count
    stsdHeader.writeUInt32BE(1, 4);
    const sampleEntry = Buffer.alloc(16); // size(4) + format(4) + 预留 8 字节
    sampleEntry.writeUInt32BE(16, 0);
    sampleEntry.write(fourcc, 4, 'ascii');
    const stbl = box('stbl', box('stsd', Buffer.concat([stsdHeader, sampleEntry])));
    const hdlr = box('hdlr', Buffer.concat([Buffer.alloc(8), Buffer.from('vide', 'ascii')]));
    const minf = box('minf', stbl);
    const mdia = box('mdia', Buffer.concat([hdlr, minf]));
    const trak = box('trak', mdia);
    return box('moov', trak);
  };

  assert.equal(mp4VideoCodec(makeMp4('avc1')), 'h264', 'avc1 应识别为 h264');
  assert.equal(mp4VideoCodec(makeMp4('hvc1')), 'h265', 'hvc1 应识别为 h265');
  assert.equal(mp4VideoCodec(makeMp4('av01')), 'av1', 'av01 应识别为 av1');
  assert.equal(mp4VideoCodec(Buffer.from('not an mp4 at all, just some bytes that are long enough to pass')), '');
  assert.equal(mp4VideoCodec(Buffer.alloc(0)), '');
});

test('站点适配器：URI 编码的 RENDER_DATA 与 undefined 字面量都要能解析', async () => {
  // 小红书老版：整个 JSON 被 URI 编码塞进 script#RENDER_DATA
  const encoded = `<script id="RENDER_DATA" type="application/json">${encodeURIComponent(
    JSON.stringify({ note: { noteDetailMap: { n1: { note: { desc: '编码数据', imageList: [{ urlDefault: 'https://sns-img-bd.xhscdn.com/enc' }] } } } } }),
  )}</script>`;
  const encodedResult = await collectSiteMedia({
    url: 'https://www.xiaohongshu.com/explore/n1',
    html: `<!doctype html><html><body>${encoded}</body></html>`,
  });
  assert.equal(encodedResult.items.length, 1);
  assert.ok(encodedResult.items[0].url.includes('/enc'));

  // 抖音真实页面里会出现 undefined 字面量（严格 JSON 解析会失败）
  const raw = '{"loaderData":{"video_(id)/page":{"videoInfoRes":{"item_list":[{"desc":"未定义字面量","video":{"play_addr":{"url_list":["https://v3-web.douyinvod.com/x/video/tos/cn/1/"]}}}],"cursor":"1"}}},"extra": undefined}';
  const undefinedResult = await collectSiteMedia({
    url: 'https://www.douyin.com/video/1',
    html: douyinHtml(null, { rawState: raw }),
  });
  assert.equal(undefinedResult.items.length, 1, `undefined 字面量不应让整段数据解析失败：${JSON.stringify(undefinedResult)}`);
  assert.equal(undefinedResult.caption, '未定义字面量');
});

test('站点适配器：非适配站点与空数据都安全返回', async () => {
  const other = await collectSiteMedia({ url: `${fixtureBase}/article`, html: '<html><body><p>普通网页</p></body></html>' });
  assert.equal(other.adapter, null);
  assert.deepEqual(other.items, []);

  const empty = await collectSiteMedia({ url: 'https://www.douyin.com/video/1', html: '<html><body>没有页面数据</body></html>' });
  assert.equal(empty.adapter, 'douyin');
  assert.deepEqual(empty.items, []);
  assert.ok(Array.isArray(empty.failures), '应记录尝试过的数据位置，便于排查');

  assert.deepEqual(extractSiteMedia(null).items, []);
  assert.deepEqual(extractSiteMedia({}).items, []);
});

