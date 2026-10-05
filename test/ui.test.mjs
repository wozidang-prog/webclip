/**
 * Web UI（public/index.html）的自动化测试。
 *
 * 用 jsdom 真实加载页面并执行其中的脚本，把 fetch / clipboard 换成桩，
 * 验证「API 测试」视图：接口列表、参数表单、发送请求、响应渲染、
 * curl 生成、请求历史、一键自检。
 *
 * 运行：node test/ui.test.mjs
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const HTML_PATH = path.join(process.cwd(), 'public', 'index.html');
const html = await fs.readFile(HTML_PATH, 'utf8');

const ARTICLE_ID = '20250101-120000-abcdef-测试文章';
const MARKDOWN =
  '# 测试标题\n\n正文第一段。\n\n![配图](http://localhost:3000/media/abc123.png)\n\n' +
  '<video src="http://localhost:3000/media/clip.mp4" controls preload="metadata" poster="http://localhost:3000/media/cover.jpg"></video>\n';

function makeResponse({ status = 200, body = '', headers = {} } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => lower[String(name).toLowerCase()] ?? null },
    text: async () => text,
  };
}

/** 桩路由：记录每个请求，返回与真实服务一致的响应形状 */
function handleRequest(method, rawUrl, body) {
  // 绝对地址按当前页面 origin 处理，等价于同源请求
  const normalized = rawUrl.replace(/^https?:\/\/[^/]+/, '');
  const [pathname, query = ''] = normalized.split('?');
  const json = (data) => makeResponse({ status: 200, body: { ok: true, data }, headers: { 'content-type': 'application/json' } });

  if (pathname === '/healthz') {
    return makeResponse({
      status: 200,
      body: { status: 'ok', version: '1.0.0', uptimeSec: 12, browser: { connected: true, activeContexts: 0 }, mediaDir: '/data/media' },
      headers: { 'content-type': 'application/json' },
    });
  }
  if (pathname === '/api/stats') {
    return json({
      media: { files: 3, bytes: 4096, publicBaseUrl: 'http://localhost:3000' },
      articles: { total: 2 },
      config: { apiTokenRequired: false, publicBaseUrl: 'http://localhost:3000', concurrency: 3 },
    });
  }
  if (pathname === '/api/rules') {
    return json({ disabled: false, hostPatterns: 96, pathPatterns: 11, removeSelectors: 130, keepEmbedHosts: 19 });
  }
  if (pathname === '/api/articles' && method === 'GET') {
    const params = new URLSearchParams(query);
    const offset = Number(params.get('offset') || 0);
    const items = [
      { id: ARTICLE_ID, title: '测试文章', siteName: '示例站', author: '张三', words: 12, mediaCount: 1, createdAt: '2025-01-01T12:00:00.000Z', filename: '2025-01-01-测试文章.md' },
      { id: '20250102-120000-abcdef-第二篇', title: '第二篇文章', siteName: '示例站', words: 20, mediaCount: 0, createdAt: '2025-01-02T12:00:00.000Z', filename: '2025-01-02-第二篇文章.md' },
    ];
    return json({ total: 2, limit: Number(params.get('limit') || 20), offset, q: params.get('q') || '', items: offset > 0 ? [] : items });
  }
  if (pathname.startsWith('/api/articles/') && method === 'GET' && pathname.endsWith('/markdown')) {
    return makeResponse({ status: 200, body: MARKDOWN, headers: { 'content-type': 'text/markdown; charset=utf-8' } });
  }
  if (pathname.startsWith('/api/articles/') && method === 'GET') {
    const withMarkdown = query.includes('includeMarkdown=1');
    return json({
      id: ARTICLE_ID,
      title: '测试文章',
      siteName: '示例站',
      author: '张三',
      createdAt: '2025-01-01T12:00:00.000Z',
      finalUrl: 'https://example.com/a',
      filename: '2025-01-01-测试文章.md',
      stats: { words: 12 },
      media: [
        { kind: 'image', file: 'abc123.png', mime: 'image/png', bytes: 2048, localUrl: 'http://localhost:3000/media/abc123.png' },
      ],
      ...(withMarkdown ? { markdown: MARKDOWN } : {}),
    });
  }
  if (pathname === '/api/urls' && method === 'GET') {
    return json({
      total: 1,
      available: true,
      items: [
        {
          id: 7,
          url: 'https://example.com/a',
          title: '测试文章',
          articleId: ARTICLE_ID,
          contentHash: 'abcdef1234567890',
          textLength: 123,
          mediaCount: 2,
          fetchCount: 3,
          changeCount: 1,
          status: 'ok',
          firstSeenAt: '2025-01-01T00:00:00.000Z',
          lastFetchedAt: '2025-01-02T00:00:00.000Z',
          lastChangedAt: '2025-01-01T00:00:00.000Z',
          articleUrl: `/api/articles/${encodeURIComponent(ARTICLE_ID)}`,
          markdownUrl: `/api/articles/${encodeURIComponent(ARTICLE_ID)}/markdown`,
        },
      ],
    });
  }
  if (pathname.startsWith('/api/urls/') && method === 'DELETE') {
    return json({ id: Number(pathname.split('/').pop()), removed: true });
  }
  if (pathname === '/api/search' && method === 'GET') {
    return json({ query: 'x', available: true, items: [], total: 0 });
  }
  if (pathname.startsWith('/api/articles/') && method === 'DELETE') {
    const withMedia = query.includes('withMedia=1');
    return json({ id: ARTICLE_ID, removed: true, withMedia, media: withMedia ? { candidates: 2, removed: 1, keptBecauseShared: 1, freedBytes: 2048 } : null });
  }
  if (pathname === '/api/articles/delete' && method === 'POST') {
    const ids = JSON.parse(body || '{}').ids || [];
    return json({ requested: ids.length, deleted: ids.length, failed: [], media: null });
  }
  if (pathname === '/api/media/gc' && method === 'POST') {
    const dryRun = JSON.parse(body || '{}').dryRun === true;
    return json(
      dryRun
        ? { dryRun: true, totalFiles: 5, referencedFiles: 3, orphanFiles: 2, orphanBytes: 4096, samples: [] }
        : { dryRun: false, totalFiles: 5, referencedFiles: 3, removed: 2, freedBytes: 4096 },
    );
  }
  if (pathname.startsWith('/api/media/') && method === 'DELETE') {
    return json({ removed: true, hash: 'abc123', file: 'abc123.png', freedBytes: 2048, forced: query.includes('force=1') });
  }
  if (pathname === '/api/convert' && method === 'POST') {
    const parsed = JSON.parse(body || '{}');
    if (!parsed.url) {
      return makeResponse({
        status: 400,
        body: { ok: false, error: { code: 'bad_request', message: '缺少 url 参数' } },
        headers: { 'content-type': 'application/json' },
      });
    }
    return makeResponse({
      status: 200,
      headers: { 'content-type': 'application/json', 'x-article-id': encodeURIComponent(ARTICLE_ID) },
      body: {
        ok: true,
        data: {
          id: ARTICLE_ID,
          url: parsed.url,
          finalUrl: parsed.url,
          title: '测试标题',
          filename: '2025-01-01-测试标题.md',
          markdown: MARKDOWN,
          markdownUrl: `http://localhost:3000/api/articles/${encodeURIComponent(ARTICLE_ID)}/markdown`,
          downloadUrl: `http://localhost:3000/api/articles/${encodeURIComponent(ARTICLE_ID)}/download`,
          media: [
            {
              kind: 'image',
              file: 'abc123.png',
              mime: 'image/png',
              bytes: 2048,
              localUrl: 'http://localhost:3000/media/abc123.png',
              sourceUrl: 'https://example.com/a.png',
              origin: 'capture',
            },
          ],
          mediaFailures: [],
          // 只有请求里带了 mediaOnly / webhookUrl 时才回传对应字段，方便断言 UI 渲染
          ...(parsed.mediaOnly ? { mediaOnly: { dir: '/media-only', local: !parsed.store } } : {}),
          ...(parsed.webhookUrl || parsed.webhook
            ? { webhook: { ok: true, status: 200, url: parsed.webhookUrl || 'https://hook.example.com/x' } }
            : {}),
          stats: { words: 12, chars: 30, markdownChars: MARKDOWN.length, media: { saved: 1, reusedFromCache: 0, failed: 0 }, adsBlocked: 4, elapsedMs: 1234 },
          warnings: [],
        },
      },
    });
  }
  if (pathname.startsWith('/media/')) {
    return makeResponse({ status: 200, body: 'PNGDATA', headers: { 'content-type': 'image/png' } });
  }
  return makeResponse({
    status: 404,
    body: { ok: false, error: { code: 'not_found', message: `未桩接的接口: ${method} ${pathname}${query ? `?${query}` : ''}` } },
    headers: { 'content-type': 'application/json' },
  });
}

const requests = [];

const dom = new JSDOM(html, {
  url: 'http://127.0.0.1:3000/',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  beforeParse(window) {
    window.fetch = (input, options = {}) => {
      const url = String(input);
      const method = (options.method || 'GET').toUpperCase();
      requests.push({ url, method, headers: options.headers || {}, body: options.body });
      try {
        return Promise.resolve(handleRequest(method, url, options.body));
      } catch (err) {
        return Promise.reject(err);
      }
    };
    Object.defineProperty(window.navigator, 'clipboard', {
      value: {
        writeText: async (text) => {
          window.__copied.push(String(text));
        },
      },
      configurable: true,
    });
    window.__copied = [];
    window.__downloads = [];
    window.__confirmAnswer = true;
    window.confirm = () => window.__confirmAnswer;
    // jsdom 没有 createObjectURL，且下载点击需要被记录
    window.URL.createObjectURL = () => 'blob:stub';
    window.URL.revokeObjectURL = () => {};
    window.HTMLAnchorElement.prototype.click = function click() {
      window.__downloads.push({ download: this.download, href: this.href });
    };
    window.localStorage.setItem('webclip_token', 'test-token');
  },
});

const { window } = dom;
const doc = window.document;
const $ = (id) => doc.getElementById(id);

after(() => {
  window.close();
});

const waitFor = async (predicate, label, timeoutMs = 5000) => {
  const started = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - started > timeoutMs) throw new Error(`等待超时：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const click = (el) => {
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
};

const switchToClip = () => {
  click(doc.querySelector('.viewtabs button[data-view="clip"]'));
};

const setField = (name, value) => {  const el = doc.querySelector(`[data-field="${name}"]`);
  assert.ok(el, `找不到字段 ${name}`);
  if (el.type === 'checkbox') {
    el.checked = Boolean(value);
  } else {
    el.value = String(value);
  }
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
  el.dispatchEvent(new window.Event('change', { bubbles: true }));
  return el;
};

/* ------------------------------------------------------------------ */

test('页面加载后默认展示抓取视图，并渲染出全部接口', () => {
  assert.equal($('view-clip').classList.contains('hidden'), false);
  assert.equal($('view-api').classList.contains('hidden'), true);

  const items = doc.querySelectorAll('#endpointList .endpoint-item');
  assert.ok(items.length >= 14, `接口数量异常：${items.length}`);
  assert.match($('endpointCount').textContent, /个接口/);

  // 分组标题存在
  const groups = [...doc.querySelectorAll('.endpoint-group')].map((el) => el.textContent);
  for (const group of ['抓取', '文章', '图床', '诊断']) {
    assert.ok(groups.includes(group), `缺少分组：${group}`);
  }
});

test('抓取视图：点「开始抓取」会调用 /api/convert 并渲染结果面板', async () => {
  requests.length = 0;
  $('url').value = 'https://example.com/clip-view';
  click($('go'));
  await waitFor(() => !$('result').classList.contains('hidden'), '结果面板');

  const req = requests.find((r) => r.url === '/api/convert' && r.method === 'POST');
  assert.ok(req, '没有发出转换请求');
  assert.equal(JSON.parse(req.body).url, 'https://example.com/clip-view');

  assert.match($('markdownBox').textContent, /测试标题/);
  assert.match($('stats').textContent, /字数/);
  assert.equal($('mediaGrid').querySelectorAll('figure').length, 1);
  assert.match($('tab-preview').innerHTML, /<h1[^>]*>测试标题<\/h1>/);
});

test('下载按钮使用服务端自动生成的文件名', () => {
  // 上一条测试已经渲染出结果
  assert.match($('stats').textContent, /2025-01-01-测试标题\.md/, '结果面板应展示自动生成的文件名');
  window.__downloads.length = 0;
  click($('download'));
  assert.equal(window.__downloads.length, 1, '应触发一次下载');
  assert.equal(window.__downloads[0].download, '2025-01-01-测试标题.md', '下载文件名应来自服务端 filename 字段');
});

test('删除文章：结果面板的删除按钮带 withMedia 请求，并隐藏结果、刷新列表', async () => {
  // 上一条测试已经渲染出结果，且列表里有一条记录
  await waitFor(() => $('recent').querySelectorAll('[data-delete]').length > 0, '最近列表渲染');
  requests.length = 0;

  click($('deleteArticle'));
  await waitFor(() => requests.some((r) => r.method === 'DELETE'), '删除请求');
  const del = requests.find((r) => r.method === 'DELETE');
  assert.match(del.url, new RegExp(`/api/articles/${encodeURIComponent(ARTICLE_ID).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(del.url, /withMedia=1/, '默认应带上"同时清理图床文件"');

  await waitFor(() => $('result').classList.contains('hidden'), '结果面板隐藏');
  await waitFor(() => $('status').textContent.includes('已删除'), '状态提示');
  assert.match($('status').textContent, /图床删除 1 个文件/, '应报告图床清理结果');
});

test('删除文章：取消确认时不发请求', async () => {
  await waitFor(() => $('recent').querySelectorAll('[data-delete]').length > 0, '最近列表');
  window.__confirmAnswer = false;
  requests.length = 0;
  click($('recent').querySelector('[data-delete]'));
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(requests.length, 0, '取消后不应发送删除请求');
  window.__confirmAnswer = true;
});

test('删除文章：关闭「同时清理图床文件」时 withMedia=0', async () => {
  await waitFor(() => $('recent').querySelectorAll('[data-delete]').length > 0, '最近列表');
  $('deleteWithMedia').checked = false;
  requests.length = 0;
  click($('recent').querySelector('[data-delete]'));
  await waitFor(() => requests.some((r) => r.method === 'DELETE'), '删除请求');
  assert.match(requests.find((r) => r.method === 'DELETE').url, /withMedia=0/);
  $('deleteWithMedia').checked = true;
});

test('孤儿图床回收：先 dryRun 统计，确认后再真删', async () => {
  requests.length = 0;
  click($('gcMedia'));
  await waitFor(() => $('status').textContent.includes('已回收'), '回收结果');

  const gcCalls = requests.filter((r) => r.url === '/api/media/gc');
  assert.equal(gcCalls.length, 2, '应先 dryRun 再执行');
  assert.equal(JSON.parse(gcCalls[0].body).dryRun, true);
  assert.equal(JSON.parse(gcCalls[1].body).dryRun, undefined);
  assert.match($('status').textContent, /已回收 2 个孤儿文件/);
});

test('文章浏览：切到该视图会拉列表并渲染条目', async () => {
  requests.length = 0;
  click(doc.querySelector('.viewtabs button[data-view="browse"]'));
  assert.equal($('view-browse').classList.contains('hidden'), false);
  assert.equal($('view-clip').classList.contains('hidden'), true);

  await waitFor(() => $('browseList').querySelectorAll('.browse-item').length > 0, '文章列表');
  assert.match($('browseCount').textContent, /共 2 篇/);
  assert.match($('browsePage').textContent, /第 1 \/ 1 页/);

  const first = $('browseList').querySelector('.browse-item');
  assert.match(first.textContent, /测试文章/);
  assert.match(first.textContent, /2025-01-01-测试文章\.md/, '列表里应显示下载文件名');
  assert.ok(requests.some((r) => r.url.startsWith('/api/articles?')), '应请求文章列表');
});

test('文章浏览：点条目渲染 Markdown、元信息与媒体，并可切到源码', async () => {
  requests.length = 0;
  click($('browseList').querySelector('.browse-item'));
  await waitFor(() => $('browseTitle').textContent === '测试文章', '文章标题');

  const req = requests.find((r) => r.url.includes('includeMarkdown=1'));
  assert.ok(req, '打开文章应带 includeMarkdown=1');

  assert.match($('browsePreview').innerHTML, /<h1[^>]*>测试标题<\/h1>/);
  assert.match($('browsePreview').innerHTML, /<img[^>]+src="http:\/\/localhost:3000\/media\/abc123\.png"/);
  assert.match($('browseMeta').textContent, /示例站/);
  assert.match($('browseMeta').textContent, /12 字/);
  assert.match($('browseMeta').innerHTML, /原文链接/);
  assert.equal($('browseMediaCount').textContent, '(1)');

  // 源码 tab
  click(doc.querySelector('#browseTabs button[data-btab="raw"]'));
  assert.equal($('browseRaw').classList.contains('hidden'), false);
  assert.match($('browseRaw').textContent, /# 测试标题/);
  // 媒体 tab
  click(doc.querySelector('#browseTabs button[data-btab="media"]'));
  assert.equal($('browseMediaGrid').classList.contains('hidden'), false);
  assert.equal($('browseMediaGrid').querySelectorAll('figure').length, 1);
  click(doc.querySelector('#browseTabs button[data-btab="render"]'));

  // 复制
  window.__copied.length = 0;
  click($('browseCopy'));
  await waitFor(() => window.__copied.length > 0, '复制 markdown');
  assert.match(window.__copied[window.__copied.length - 1], /# 测试标题/);

  // 下载用的是自动命名的文件名
  window.__downloads.length = 0;
  click($('browseDownload'));
  assert.equal(window.__downloads[0].download, '2025-01-01-测试文章.md');
});

test('文章浏览：支持 #browse/<id> 深链直接打开', async () => {
  switchToClip();
  window.location.hash = `#browse/${encodeURIComponent(ARTICLE_ID)}`;
  await waitFor(() => $('view-browse').classList.contains('hidden') === false, '深链切到浏览视图');
  await waitFor(() => $('browseTitle').textContent === '测试文章', '深链打开文章');
  assert.equal($('browseArticle').classList.contains('hidden'), false);
});

test('文章浏览：搜索会带 q 参数并回到第一页', async () => {
  requests.length = 0;
  $('browseSearch').value = '第二篇';
  $('browseSearch').dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitFor(() => requests.some((r) => r.url.includes('q=')), '搜索请求', 3000);
  const req = requests.find((r) => r.url.includes('q='));
  assert.match(decodeURIComponent(req.url), /q=第二篇/);
  assert.match(req.url, /offset=0/);
});

test('文章浏览：在浏览页删除文章会调用 DELETE 并复位', async () => {
  await waitFor(() => $('browseArticle').classList.contains('hidden') === false, '有打开的文章');
  requests.length = 0;
  click($('browseDelete'));
  await waitFor(() => requests.some((r) => r.method === 'DELETE'), '删除请求');
  assert.match(requests.find((r) => r.method === 'DELETE').url, /withMedia=1/);
  await waitFor(() => $('browseArticle').classList.contains('hidden'), '浏览区复位');
  assert.equal($('browseEmpty').classList.contains('hidden'), false);
  switchToClip();
});

test('网址记录：切到该页签会拉列表、展示次数与指纹，可打开文章或忘掉记录', async () => {
  requests.length = 0;
  click(doc.querySelector('.viewtabs button[data-view="browse"]'));
  click(doc.querySelector('#browseModeTabs button[data-bmode="urls"]'));

  assert.equal($('browseModeUrls').classList.contains('hidden'), false);
  assert.equal($('browseModeArticles').classList.contains('hidden'), true);
  await waitFor(() => $('urlList').querySelectorAll('.list-item').length > 0, '网址记录列表');

  assert.ok(requests.some((r) => r.url.startsWith('/api/urls?')), '应请求网址记录');
  assert.match($('urlSummary').textContent, /共记录 1 个网址/);
  assert.match($('urlList').textContent, /抓取 3 次/);
  assert.match($('urlList').textContent, /正文变更 1 次/);
  assert.match($('urlList').textContent, /abcdef12/, '应显示正文指纹前 8 位');
  assert.equal($('urlCount').textContent, '1');

  // 点「浏览」跳到对应文章
  const openLink = $('urlList').querySelector('[data-open]');
  assert.ok(openLink, '应有打开文章的链接');
  click(openLink);
  assert.equal($('browseModeArticles').classList.contains('hidden'), false, '应切回文章视图');
  await waitFor(() => $('browseTitle').textContent === '测试文章', '打开对应文章');

  // 回到网址记录，测试"忘掉"
  click(doc.querySelector('#browseModeTabs button[data-bmode="urls"]'));
  await waitFor(() => $('urlList').querySelector('[data-forget]'), '忘掉按钮');
  requests.length = 0;
  click($('urlList').querySelector('[data-forget]'));
  await waitFor(() => requests.some((r) => r.method === 'DELETE' && r.url.startsWith('/api/urls/')), '忘掉请求');
  assert.match(requests.find((r) => r.method === 'DELETE' && r.url.startsWith('/api/urls/')).url, /\/api\/urls\/7$/);
  await waitFor(() => $('status').textContent.includes('已忘掉该网址记录'), '状态提示');

  click(doc.querySelector('#browseModeTabs button[data-bmode="articles"]'));
  switchToClip();
});

test('网址记录：搜索带 q 参数', async () => {
  click(doc.querySelector('.viewtabs button[data-view="browse"]'));
  click(doc.querySelector('#browseModeTabs button[data-bmode="urls"]'));
  requests.length = 0;
  $('urlSearch').value = 'example';
  $('urlSearch').dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitFor(() => requests.some((r) => r.url.includes('q=example')), '搜索请求', 3000);
  switchToClip();
});

test('切到 API 测试视图，默认选中 POST /api/convert 并生成请求体', () => {
  click(doc.querySelector('.viewtabs button[data-view="api"]'));
  assert.equal($('view-api').classList.contains('hidden'), false);
  assert.equal($('view-clip').classList.contains('hidden'), true);

  assert.equal($('reqMethod').textContent, 'POST');
  assert.equal($('reqPath').textContent, '/api/convert');

  const body = JSON.parse($('apiBody').value);
  assert.equal(body.url, 'https://example.com');
  assert.equal(body.engine, 'browser');
  assert.equal(body.imageMode, 'local');
  assert.equal(body.store, true);

  // 表单字段与默认值联动
  assert.equal(doc.querySelector('[data-field="url"]').value, 'https://example.com');
  assert.equal(doc.querySelector('[data-field="engine"]').value, 'browser');
});

test('抓取视图：勾选「只下载视频图片」与填 Webhook 会带进请求，并渲染素材目录与通知结果', async () => {
  switchToClip();
  requests.length = 0;
  $('url').value = 'https://example.com/media-only-view';
  $('mediaOnly').checked = true;
  $('webhookUrl').value = 'https://hook.example.com/webclip';
  $('webhookMode').value = 'on';
  click($('go'));
  await waitFor(() => requests.some((r) => r.url === '/api/convert'), '转换请求');

  const payload = JSON.parse(requests.find((r) => r.url === '/api/convert').body);
  assert.equal(payload.mediaOnly, true, '勾选后应带 mediaOnly=true');
  assert.equal(payload.webhookUrl, 'https://hook.example.com/webclip', 'Webhook 输入框的值应带进请求');
  assert.equal(payload.webhook, true, '通知=总是发时应带 webhook=true');

  await waitFor(() => !$('result').classList.contains('hidden'), '结果面板');
  assert.match($('stats').textContent, /素材目录/, '结果面板应展示素材目录');
  assert.match($('stats').textContent, /\/media-only/);
  assert.match($('stats').textContent, /通知：.*已发送（200）/, '应展示通知结果');
  assert.match($('metaBox').textContent, /"mediaOnly"/);
});

test('抓取视图：不勾选/通知=不发时的请求体不含这两个开关', async () => {
  switchToClip();
  requests.length = 0;
  $('url').value = 'https://example.com/plain-view';
  $('mediaOnly').checked = false;
  $('webhookUrl').value = '';
  $('webhookMode').value = 'off';
  click($('go'));
  await waitFor(() => requests.some((r) => r.url === '/api/convert'), '转换请求');

  const payload = JSON.parse(requests.find((r) => r.url === '/api/convert').body);
  assert.equal(payload.mediaOnly, undefined, '未勾选不应带 mediaOnly');
  assert.equal(payload.webhookUrl, undefined, '留空不应带 webhookUrl');
  assert.equal(payload.webhook, false, '通知=不发时应带 webhook=false');
});

test('API 测试视图：POST /api/convert 也提供 mediaOnly / webhook / webhookUrl 三个字段', async () => {
  click(doc.querySelector('.viewtabs button[data-view="api"]'));
  const item = [...doc.querySelectorAll('.endpoint-item')].find(
    (el) => el.querySelector('.method')?.textContent === 'POST' && el.querySelector('code')?.textContent === '/api/convert',
  );
  assert.ok(item, '应能在接口列表里找到 POST /api/convert');
  click(item);
  assert.equal($('reqMethod').textContent, 'POST');
  assert.equal($('reqPath').textContent, '/api/convert');

  const mediaOnlyEl = doc.querySelector('[data-field="mediaOnly"]');
  const webhookEl = doc.querySelector('[data-field="webhook"]');
  const webhookUrlEl = doc.querySelector('[data-field="webhookUrl"]');
  const xhsApiUrlEl = doc.querySelector('[data-field="xhsApiUrl"]');
  assert.ok(mediaOnlyEl, '应提供 mediaOnly 字段');
  assert.ok(webhookEl, '应提供 webhook 字段');
  assert.ok(webhookUrlEl, '应提供 webhookUrl 字段');
  assert.ok(xhsApiUrlEl, '应提供 xhsApiUrl 字段（小红书自建解析器地址）');
  assert.ok(doc.querySelector('[data-field="xhsParserOnly"]'), '应提供 xhsParserOnly 字段（只走解析器）');

  setField('mediaOnly', true);
  setField('webhookUrl', 'https://hook.example.com/api-test');
  setField('xhsApiUrl', 'http://parser.example.com/xhs/detail');
  const body = JSON.parse($('apiBody').value);
  assert.equal(body.mediaOnly, true, '勾选后请求体应带 mediaOnly');
  assert.equal(body.webhookUrl, 'https://hook.example.com/api-test', '请求体应带 webhookUrl');
  assert.equal(body.xhsApiUrl, 'http://parser.example.com/xhs/detail', '请求体应带 xhsApiUrl');
});

test('抓取视图：填「小红书解析」地址会带进请求，留空则不带', async () => {
  switchToClip();
  requests.length = 0;
  $('url').value = 'https://www.xiaohongshu.com/explore/68f0abcdef';
  $('xhsApiUrl').value = 'http://parser.example.com:5556/xhs/detail';
  click($('go'));
  await waitFor(() => requests.some((r) => r.url === '/api/convert'), '转换请求');

  let payload = JSON.parse(requests.find((r) => r.url === '/api/convert').body);
  assert.equal(payload.xhsApiUrl, 'http://parser.example.com:5556/xhs/detail', '解析器地址应带进请求');
  assert.equal(payload.xhsParserOnly, undefined, '默认勾选「只走解析器」= 不传，跟随服务端配置');

  requests.length = 0;
  $('xhsApiUrl').value = '';
  $('xhsParserOnly').checked = false;
  click($('go'));
  await waitFor(() => requests.some((r) => r.url === '/api/convert'), '第二次转换请求');
  payload = JSON.parse(requests.find((r) => r.url === '/api/convert').body);
  assert.equal(payload.xhsApiUrl, undefined, '留空时不该带 xhsApiUrl（用服务端配置）');
  assert.equal(payload.xhsParserOnly, false, '取消勾选应明确传 false（改为先抓网页）');

  $('xhsParserOnly').checked = true;
});

test('发送请求：带上 Token、渲染状态码/耗时/媒体、并记录历史', async () => {
  requests.length = 0;
  setField('url', 'https://example.com/article');
  setField('includeVideos', true);

  click($('apiSend'));
  await waitFor(() => $('apiStatusPill').textContent.includes('200'), '响应状态码');

  const req = requests.find((r) => r.url === '/api/convert' && r.method === 'POST');
  assert.ok(req, '没有发出 POST /api/convert');
  assert.equal(req.headers['x-api-token'], 'test-token');
  assert.equal(req.headers['content-type'], 'application/json');
  const payload = JSON.parse(req.body);
  assert.equal(payload.url, 'https://example.com/article');
  assert.equal(payload.includeVideos, true);

  assert.match($('apiMeta').textContent, /ms/);
  assert.match($('apiMeta').textContent, /application\/json/);
  assert.match($('apiMeta').textContent, /测试文章|文章 id/, '应展示 x-article-id 响应头');

  const pretty = JSON.parse($('apiResponse').textContent);
  assert.equal(pretty.data.title, '测试标题');

  // 媒体网格
  assert.equal($('apiMediaGrid').querySelectorAll('figure').length, 1);
  assert.match($('apiMediaGrid').innerHTML, /abc123\.png/);

  // Markdown 预览可用
  assert.equal($('apiPreviewBtn').disabled, false);
  click($('apiPreviewBtn'));
  assert.match($('apiPreview').innerHTML, /<h1[^>]*>测试标题<\/h1>/);
  assert.match($('apiPreview').innerHTML, /<img[^>]+src="http:\/\/localhost:3000\/media\/abc123\.png"/);

  // 视频必须是真正的 <video> 元素（阅读模式能直接播），而不是被转义的文本
  const previewVideo = $('apiPreview').querySelector('video');
  assert.ok(previewVideo, '预览里应有真实的 <video> 元素');
  assert.equal(previewVideo.getAttribute('src'), 'http://localhost:3000/media/clip.mp4');
  assert.equal(previewVideo.hasAttribute('controls'), true, '应带 controls 才能播放');
  assert.equal(previewVideo.getAttribute('poster'), 'http://localhost:3000/media/cover.jpg');
  assert.ok(!$('apiPreview').textContent.includes('<video'), '标签不应以文本形式出现');

  // 历史
  const history = $('apiHistory').querySelectorAll('.hist-item');
  assert.equal(history.length, 1);
  assert.match(history[0].textContent, /POST/);
  assert.match(history[0].textContent, /200/);
});

test('curl 命令包含正确的 method / path / 请求体 / Token', async () => {
  setField('url', 'https://example.com/curl-test');
  await waitFor(() => $('apiBody').value.includes('curl-test'), '请求体同步');
  click($('apiCurl'));
  await waitFor(() => window.__copied.length > 0, 'curl 复制');
  const curl = window.__copied[window.__copied.length - 1];
  assert.match(curl, /curl -X POST 'http:\/\/127\.0\.0\.1:3000\/api\/convert'/);
  assert.match(curl, /-H 'content-type: application\/json'/);
  assert.match(curl, /-H 'x-api-token: test-token'/);
  assert.match(curl, /https:\/\/example\.com\/curl-test/);
});

test('GET 接口：路径参数从 id 字段拼装，且不再显示请求体', async () => {
  const items = [...doc.querySelectorAll('#endpointList .endpoint-item')];
  const target = items.find((el) => el.querySelector('code').textContent === '/api/articles/:id/markdown');
  assert.ok(target, '找不到 /api/articles/:id/markdown');
  click(target);

  assert.equal($('reqMethod').textContent, 'GET');
  assert.equal($('apiBodyWrap').classList.contains('hidden'), true);
  assert.ok(doc.querySelector('[data-field="id"]'), 'GET 接口应显示 id 字段');

  // 未填 id 时应给出提示而不是发请求
  requests.length = 0;
  setField('id', '');
  click($('apiSend'));
  await waitFor(() => $('apiMeta').textContent.includes('id'), '缺少 id 的提示');
  assert.equal(requests.length, 0, '缺 id 时不应发请求');

  // 直接粘贴 markdownUrl 也能解析出 id
  setField('id', `http://127.0.0.1:3000/api/articles/${encodeURIComponent(ARTICLE_ID)}/markdown`);
  click($('apiSend'));
  await waitFor(() => requests.some((r) => r.url.includes('/api/articles/')), 'GET 文章正文');
  const req = requests.find((r) => r.url.includes('/markdown'));
  assert.ok(req.url.startsWith('/api/articles/'), `路径异常：${req.url}`);
  assert.ok(decodeURIComponent(req.url).includes(ARTICLE_ID), `路径里应包含文章 id：${req.url}`);
  assert.ok(!req.url.includes(':id'), '路径里不应残留 :id 占位符');

  await waitFor(() => $('apiStatusPill').textContent.includes('200'), 'GET 响应');
  assert.match($('apiResponse').textContent, /测试标题/);
  assert.equal($('apiPreviewBtn').disabled, false, 'text/markdown 响应应可预览');
});

test('「用最近一篇文章的 id 填充」会写入 id 字段', async () => {
  const items = [...doc.querySelectorAll('#endpointList .endpoint-item')];
  click(items.find((el) => el.querySelector('code').textContent === '/api/articles/:id'));
  click($('apiFillRecent'));
  await waitFor(() => $('apiHint').textContent.includes('已填入'), '填充 id');
  assert.equal(doc.querySelector('[data-field="id"]').value, ARTICLE_ID);
});

test('一键自检：依次跑健康检查/鉴权/抓取/Markdown 直链/图床直链并输出结论', async () => {
  requests.length = 0;
  click($('selfCheckRun'));
  await waitFor(() => $('selfCheckResult').textContent.includes('自检'), '自检结论', 15000);
  await waitFor(() => !$('selfCheckRun').disabled, '自检结束', 15000);

  const rows = [...doc.querySelectorAll('#selfCheckResult .check-row')];
  const names = rows.map((el) => el.querySelector('.t').textContent);
  for (const expected of ['健康检查', '统计接口', '接口鉴权', '抓取转换', 'Markdown 直链', '图床直链', '清理自检数据']) {
    assert.ok(names.includes(expected), `自检缺少检查项：${expected}（实际：${names.join('、')}）`);
  }

  const failed = rows.filter((el) => el.classList.contains('fail'));
  assert.equal(failed.length, 0, `自检出现失败项：${failed.map((el) => el.textContent).join(' | ')}`);

  // 抓取与清理都真的发了请求
  assert.ok(requests.some((r) => r.url === '/api/convert' && r.method === 'POST'), '自检应发起一次转换');
  assert.ok(requests.some((r) => r.method === 'DELETE' && r.url.includes('/api/articles/')), '自检后应清理文章');
  // 图床直链用的是当前访问地址，而不是 PUBLIC_BASE_URL 里的 localhost
  assert.ok(
    requests.some((r) => r.url.startsWith('http://127.0.0.1:3000/media/')),
    '图床直链应使用当前访问地址',
  );

  // PUBLIC_BASE_URL 与当前地址不一致时应给出警告
  const baseUrlWarn = rows.find((el) => el.querySelector('.t').textContent === 'PUBLIC_BASE_URL');
  assert.ok(baseUrlWarn, '应提示 PUBLIC_BASE_URL 与访问地址不一致');
  assert.ok(baseUrlWarn.classList.contains('warn'));

  assert.match($('selfCheckResult').textContent, /自检通过|项失败/);
});

test('自检能识别 401：无 Token 时明确提示', async () => {
  const original = window.fetch;
  window.fetch = (input, options = {}) => {
    if (String(input).startsWith('/api/stats')) {
      return Promise.resolve(
        makeResponse({ status: 401, body: { ok: false, error: { code: 'unauthorized', message: '缺少或错误的 API Token' } } }),
      );
    }
    return original(input, options);
  };
  click($('selfCheckRun'));
  await waitFor(() => $('selfCheckResult').textContent.includes('自检结束') || !$('selfCheckRun').disabled, '第二次自检', 15000);
  const authRow = [...doc.querySelectorAll('#selfCheckResult .check-row')].find(
    (el) => el.querySelector('.t').textContent === '接口鉴权',
  );
  assert.ok(authRow.classList.contains('fail'));
  assert.match(authRow.textContent, /401/);
  window.fetch = original;
});

test('缺失请求体情况下：非法 JSON 会给出提示且不发请求', async () => {
  const items = [...doc.querySelectorAll('#endpointList .endpoint-item')];
  click(items.find((el) => el.querySelector('code').textContent === '/api/convert/batch'));
  await waitFor(() => !$('apiBodyWrap').classList.contains('hidden'), '批量接口显示请求体');

  $('apiBody').value = '{ 这不是 JSON }';
  $('apiBody').dispatchEvent(new window.Event('input', { bubbles: true }));
  requests.length = 0;
  click($('apiSend'));
  await waitFor(() => $('apiMeta').textContent.includes('JSON'), '非法 JSON 提示');
  assert.equal(requests.length, 0, '非法 JSON 不应发请求');
});
