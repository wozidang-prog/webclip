#!/usr/bin/env node
/**
 * 小红书抓取分步自检（**在 webclip 容器里跑**，用来定位"到底哪一环失败"）。
 *
 *   docker exec <webclip容器> node src/cli/xhs-doctor.js "https://xhslink.cn/o/xxxx"
 *   docker exec <webclip容器> node src/cli/xhs-doctor.js "https://www.xiaohongshu.com/explore/<id>"
 *   不带链接时用内置样例；加 --json 输出机器可读结果。
 *
 * 为什么需要它：容器里能 curl 通解析器 ≠ 整条抓取链通。失败可能发生在六处，
 * 每一处的原因和处理都不一样：DNS/Ipv6、TCP、解析器 HTTP、解析器自身出网、
 * CDN 图片下载、挂载卷写权限。这里逐项查，并直接给出"该怎么办"。
 */
import net from 'node:net';
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const asJson = process.argv.includes('--json');
const SAMPLE = 'https://www.xiaohongshu.com/discovery/item/6aaa07f90000000028000fdd';
const target = args[0] || SAMPLE;

const results = [];
const record = (step, ok, detail, hint = '') => {
  results.push({ step, ok, detail, hint });
  if (!asJson) {
    console.log(`${ok === true ? '✅' : ok === null ? '⚠️ ' : '❌'} ${step}: ${detail}`);
    if (hint) console.log(`   → ${hint}`);
  }
};

const config = (await import('../config.js')).config;
const api = await import('../pipeline/sites/xhs-api.js');
const base = (config.xiaohongshuApi || '').trim();

/* ---------- 0. 配置 ---------- */
if (!asJson) {
  console.log('=== 小红书抓取自检 ===');
  console.log(`链接: ${target}`);
  console.log(`XIAOHONGSHU_API: ${base || '(未配置)'}`);
  console.log(`XIAOHONGSHU_PARSER_ONLY: ${config.xhsParserOnly}`);
  console.log(`XIAOHONGSHU_API_TIMEOUT_MS: ${config.xiaohongshuApiTimeoutMs}`);
  console.log(`node: ${process.version} | 用户: uid=${process.getuid?.() ?? '-'} gid=${process.getgid?.() ?? '-'}`);
  const info = (await import('../utils/build-info.js')).buildInfo();
  console.log(`这一版代码: ${info.at || '未知'}（${info.source === 'image' ? '镜像构建时间' : '源码最新修改时间'}）`);
  console.log('');
}
record('配置', Boolean(base), base ? '已配置解析器地址' : '没有配置 XIAOHONGSHU_API（只能抓网页，未登录时会是「安全限制」这类页面）',
  base ? '' : '在 .env 里设 XIAOHONGSHU_API=http://<解析器局域网IP>:5556/xhs/detail');

if (!base) {
  if (asJson) console.log(JSON.stringify({ ok: false, results }, null, 2));
  process.exit(1);
}

const apiUrl = new URL(base);

/* ---------- 1. DNS ---------- */
let lookup = { v4: [], v6: [], err: '' };
try {
  const all = await dns.lookup(apiUrl.hostname, { all: true });
  lookup = {
    v4: all.filter((a) => a.family === 4).map((a) => a.address),
    v6: all.filter((a) => a.family === 6).map((a) => a.address),
    err: '',
  };
} catch (err) {
  lookup.err = err.code || err.message;
}
if (lookup.err) {
  record('DNS 解析解析器域名', false, `${apiUrl.hostname} → ${lookup.err}`, api.explainXhsApiFailure(lookup.err, base));
} else if (!lookup.v4.length && lookup.v6.length) {
  // 只有 IPv6 未必是问题（宿主机/容器有 IPv6 就行），所以只警告；以下一步 TCP 实测为准
  record('DNS 解析解析器域名', null,
    `${apiUrl.hostname} → 只有 IPv6（${lookup.v6.join(', ')}）`,
    '默认 Docker 网络没有 IPv6：如果下面 TCP 那步失败，就改用局域网 IPv4 地址（如 http://192.168.x.x:5556/xhs/detail）');
} else {
  record('DNS 解析解析器域名', true, `${apiUrl.hostname} → ${lookup.v4.join(', ') || lookup.v6.join(', ')}`);
}

/* ---------- 2. TCP ---------- */
const port = Number(apiUrl.port || (apiUrl.protocol === 'https:' ? 443 : 80));
const tcp = await new Promise((resolve) => {
  const t0 = Date.now();
  const sock = net.connect({ host: apiUrl.hostname, port, family: lookup.v4.length ? 4 : 0 });
  const done = (ok, detail) => {
    sock.destroy();
    resolve({ ok, detail: `${detail}（${Date.now() - t0}ms）` });
  };
  sock.setTimeout(8000);
  sock.on('connect', () => done(true, `TCP ${apiUrl.hostname}:${port} 可连`));
  sock.on('timeout', () => done(false, `TCP ${apiUrl.hostname}:${port} 超时`));
  sock.on('error', (err) => done(false, `TCP ${apiUrl.hostname}:${port} 失败：${err.code || err.message}`));
});
record('TCP 连通解析器端口', tcp.ok, tcp.detail, tcp.ok ? '' : api.explainXhsApiFailure(tcp.detail.match(/\b(E[A-Z]+)\b/)?.[1] || '', base));

/* ---------- 3. 短链展开（给了短链才有） ---------- */
const note = await api.resolveXhsNoteUrl(target).catch((err) => ({ url: target, expanded: false, err: err.message }));
record('整理笔记链接', Boolean(note.url),
  note.expanded ? `短链已展开 → ${note.url.slice(0, 110)}` : '直接用原始链接（无需展开）');

/** 小红书要求链接带 xsec_token：缺了必然解析失败（实测） */
record('链接是否带 xsec_token', api.hasXsecToken(note.url),
  api.hasXsecToken(note.url) ? '已带上（能正常取作品数据）' : '没有 xsec_token',
  api.hasXsecToken(note.url) ? '' : api.MISSING_TOKEN_HINT);

/* ---------- 4. 调用解析器 ---------- */
const parsed = await api.collectViaXhsApi(target, { apiUrl: '' });
if (parsed.items.length) {
  record('解析器返回作品数据', true,
    `${parsed.kind === 'video' ? '视频' : '图文'} | 标题「${parsed.title}」| 作者「${parsed.author}」| 媒体 ${parsed.items.length} 个`);
} else {
  record('解析器返回作品数据', false, `reason=${parsed.reason} ${parsed.message || ''}`,
    parsed.hint || '解析器自己没拿到数据：它也需要能出网访问小红书；可先单测解析器容器，例如 curl -X POST 解析器地址 -H "content-type: application/json" -d \'{"url":"<笔记链接>"}\'');
}

/* ---------- 5. 媒体直链是否可下载 ---------- */
if (parsed.items.length) {
  const first = parsed.items[0];
  const media = await new Promise((resolve) => {
    const t0 = Date.now();
    fetch(first.url, {
      headers: { referer: parsed.noteUrl || target, 'user-agent': config.fetch.userAgent, range: 'bytes=0-2047' },
      signal: AbortSignal.timeout(20_000),
    })
      .then(async (r) => {
        const buf = Buffer.from(await r.arrayBuffer());
        resolve({ ok: r.ok, detail: `HTTP ${r.status} | ${r.headers.get('content-type')} | 读到 ${buf.length} 字节（${Date.now() - t0}ms）` });
      })
      .catch((err) => resolve({ ok: false, detail: `失败：${err.cause?.code || err.message}`, hint: api.explainXhsApiFailure(err.cause?.code || '', first.url) }));
  });
  record('下载第一个媒体直链', media.ok, `${first.url.slice(0, 90)} ${media.detail}`, media.hint || (media.ok ? '' : '容器需要能出网访问小红书 CDN（ci.xiaohongshu.com / sns-*-xhscdn.com）'));
}

/* ---------- 6. 挂载卷写权限 ---------- */
for (const [label, dir] of [
  ['数据目录 DATA_DIR', config.data.dir],
  ['素材目录 MEDIA_ONLY_DIR', config.mediaOnly.dir],
]) {
  const probe = path.join(dir, `.write-probe-${Date.now()}`);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(probe, 'ok');
    await fs.unlink(probe);
    record(`${label} 可写`, true, dir);
  } catch (err) {
    record(`${label} 可写`, false, `${dir} → ${err.code || err.message}`,
      '挂载卷权限不对（NAS 上常见）：确认 .env 里 PUID/PGID 与共享文件夹属主一致，或 chown -R 1000:1000 该目录');
  }
}

/* ---------- 7. 真的跑一次抓取 ---------- */
try {
  const { convertUrl } = await import('../pipeline/convert.js');
  const t0 = Date.now();
  const r = await convertUrl(target, { engine: 'fetch', mediaOnly: true, force: true, store: false });
  const ok = r.media.length > 0;
  record('完整抓取（mediaOnly）', ok,
    `${Date.now() - t0}ms | 标题「${r.title}」| 媒体 ${r.media.length} 个 | 落盘 ${r.media[0]?.localPath || '-'}`,
    ok ? '' : `warnings: ${(r.warnings || []).join(' | ') || '(无)'}`);
  if ((r.warnings || []).length && !asJson) console.log(`   ⚠️  warnings: ${r.warnings.join(' | ')}`);
} catch (err) {
  record('完整抓取（mediaOnly）', false, `${err.code || ''} ${err.message}`, '把这一整段输出发给我即可定位');
}

const failed = results.filter((r) => r.ok === false);
if (asJson) {
  console.log(JSON.stringify({ ok: !failed.length, target, results }, null, 2));
} else {
  console.log('');
  console.log(failed.length ? `❌ 有 ${failed.length} 项失败：${failed.map((f) => f.step).join('、')}` : '✅ 全部通过：这条链接在容器里能正常抓取');
}
process.exit(failed.length ? 1 : 0);