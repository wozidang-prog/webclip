# WebClip · 网页转 Markdown 服务（无头浏览器 + 本地图床）

一个自托管的 Docker 服务：**通过 API 传入网址 → 无头浏览器打开页面 → 过滤广告等无关内容 → 正文转成 Markdown → 页面里的图片/视频保存到本地图床 → Markdown 里的媒体链接改写成本地地址。**

```
POST /api/convert  {"url": "https://example.com/post"}
        │
        ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 1. 无头 Chromium 打开页面（自动滚动触发懒加载、等待网络空闲）        │
│    · 网络层拦截：广告/统计/弹窗域名、内网地址                        │
│    · 顺手把图片字节缓存下来，避免二次下载（省一次带宽）              │
│ 2. DOM 清洗：脚本/样式/广告位/侧栏/导航/订阅框/弹窗/追踪像素/评论    │
│ 3. Mozilla Readability 抽取正文（失败自动降级为轻量清洗重试）        │
│ 4. 二次清洗：相关阅读、分享、标签等"链接密度过高"的段落             │
│ 5. Turndown + GFM → Markdown（标题/表格/代码块/图片/图注）           │
│ 6. 媒体落地：图片/视频/音频 → /data/media/<站点>/<文章标题>/01.jpg … │
│ 7. 改写链接：![alt](http://原站/图.jpg) → ![alt](http://你/ media/..)│
│ 8. 落盘：/data/articles/<id>/index.md + meta.json                    │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 目录

- [特性](#特性)
- [快速开始](#快速开始)
- [在 NAS 上部署（群晖 / 威联通 / Unraid）](#在-nas-上部署群晖--威联通--unraid)
- [网址记录与正文副本](#网址记录--正文副本重复抓取不再重复下载)
- [部署后自检](#部署后自检命令行不需要浏览器)
- [API 文档](#api-文档)
- [请求选项](#请求选项)
- [广告与无关内容过滤是怎么做的](#广告与无关内容过滤是怎么做的)
- [本地图床](#本地图床)
- [环境变量](#环境变量)
- [目录结构](#目录结构)
- [自测](#自测)
- [常见问题](#常见问题)
- [安全说明](#安全说明)
- [容量与性能](#容量与性能)

---

## 特性

| 能力 | 说明 |
| --- | --- |
| 无头浏览器渲染 | Playwright + Chromium，能拿到 JS 渲染后的 DOM、处理懒加载、自动滚动 |
| 双引擎 | `browser`（默认，最强）/ `fetch`（纯 HTTP，快、省内存、适合静态页） |
| 广告拦截 | 网络层按域名/路径拦截 + DOM 层按选择器/class-id 词元删除 + 链接密度启发式 |
| 正文抽取 | Mozilla Readability，正文过短时自动用"轻量清洗"重试，避免误删 |
| 本地图床 | **按网站分类** + 两种布局：`media/<站点域名>/<标题>/01.jpg`（默认 `folder`，按正文顺序编号）/ `media/<站点域名>/<sha256>.jpg`（`flat`，内容寻址、同图只存一份、重复抓取零下载） |
| 短视频/图文站 | 内置**抖音**、**小红书**适配：媒体地址只存在于页面 JS 数据里也能挖出来（含图文作品的整组图片） |
| 链接改写 | 图片/视频/音频/封面/图注链接统一改写为 `PUBLIC_BASE_URL/media/...` |
| 内容协商 | `Accept: text/markdown` 或 `?format=md` 直接返回 Markdown 文本 |
| 批量接口 | `/api/convert/batch` 一次提交多个 URL |
| 存档与检索 | 文章列表、正文直链、`.md` 下载（**文件名自动生成**）、删除文章、批量删除、图床文件删除与孤儿回收（带引用计数保护） |
| 可选鉴权 | `API_TOKEN`，支持 `x-api-token` / `Bearer` |
| SSRF 防护 | 默认拒绝内网/回环/保留地址与非 http(s) 协议 |
| 自带 Web UI | 三个视图：**抓取网页**（粘贴网址、预览、下载）、**文章浏览**（读已存档的 Markdown）、**API 测试**（交互式调接口 + 一键自检） |

---

## 快速开始

### 方式一：Docker Compose（推荐）

```bash
cp .env.example .env
# 编辑 .env：至少把 PUBLIC_BASE_URL 改成外部可访问的地址
docker compose up -d --build
```

打开 <http://localhost:3000> 使用内置界面，或直接调接口：

```bash
curl -s http://localhost:3000/api/convert \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com/article"}' | jq -r '.data.markdown'
```

### 方式二：Docker

```bash
docker build -t webclip:latest .
docker run -d --name webclip \
  -p 3000:3000 \
  -e PUBLIC_BASE_URL=http://localhost:3000 \
  -e CHROMIUM_NO_SANDBOX=true \
  --shm-size=1g \
  -v webclip-data:/data \
  webclip:latest
```

### 方式三：本机 Node（需要 Node ≥ 20.11）

```bash
npm install
npx playwright install chromium     # 或设置 BROWSER_CHANNEL=chrome 复用本机 Chrome
cp .env.example .env
npm start
```

> Windows 上想复用已安装的 Chrome：`$env:BROWSER_CHANNEL='chrome'; npm start`

### 方式四：命令行（不起服务）

```bash
node scripts/clip.mjs https://example.com/post                     # 打印到 stdout
node scripts/clip.mjs https://example.com/post --out post.md       # 写入文件
node scripts/clip.mjs https://example.com/post --engine fetch --json meta.json --no-video
```

`--help` 可看全部参数（对应下面「请求选项」里的同名选项）。

### 部署后自检（命令行，不需要浏览器）

```bash
node scripts/selfcheck.mjs http://192.168.1.10:3000 --token <API_TOKEN>
node scripts/selfcheck.mjs http://localhost:3000 --token x --target https://example.com --engine browser
node scripts/selfcheck.mjs http://localhost:3000 --token x --json      # 机器可读，可用于 CI
```

依次检查：健康检查 → 鉴权拦截（无 Token 必须 401）→ 统计接口 → 广告规则 → 真实抓取 → Markdown 直链 → 图床直链（免 Token）→ 清理数据。
Web UI 里的「一键自检」是同一套逻辑的图形版。

---

## 在 NAS 上部署（群晖 / 威联通 / Unraid）

### 先解决一个必踩的坑：`EACCES: permission denied, mkdir '/data/media'`

```
ERROR 启动失败 {"err":"EACCES: permission denied, mkdir '/data/media'"}
```

**原因**：你把宿主机目录挂到了 `/data`（bind mount）。bind mount 会**覆盖镜像里 `/data` 的属主**，而 NAS 上共享文件夹的属主通常是 `admin`（群晖常见 uid **1026**、gid **100**）或 `root`，容器里的普通用户 `node`（uid 1000）自然写不进去。用命名卷（named volume）不会有这个问题。

**解决办法**：镜像已经做成 NAS 友好的了——容器以 root 启动，入口脚本会检查 `/data` 是否可写，不可写就自动 `chown` 成 `PUID:PGID`，然后**降权**成该用户运行服务。你只需要告诉它目录属主是谁：

```bash
# 1) 在 NAS 上看一眼宿主机目录属主
ls -nd /volume1/docker/webclip/data
#   drwxr-xr-x 2 1026 100 ...   ← 第三/四列就是 uid/gid

# 2) 在 compose 里填上（或 DSM 项目 → 环境变量里加）
PUID=1026
PGID=100

# 3) 重建
docker compose up -d
```

启动日志会明确告诉你它做了什么：

```
[entrypoint] 将运行用户调整为 1026:100
[entrypoint] 修复 /data 属主为 1026:100（文件较多时可能需要一会儿）…
[entrypoint] 权限修复完成
[entrypoint] 以 1026:100 启动：node src/server.js
```

其它可用开关：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PUID` / `PGID` | `1000` / `1000` | 服务运行用户；设成宿主机目录属主即可 |
| `RUN_AS_ROOT` | `false` | 兜底：NFS/ACL 导致 chown 失败时，直接用 root 跑（能跑通，但隔离性下降） |
| `CHOWN_ON_START` | `false`→`true` | 设为 `false` 则完全不碰你的目录属主，权限自己管 |

如果 chown 失败（NAS 上的 ACL、NFS 共享、只读挂载等），入口脚本会打印上面的提示并**自动退回 root 运行**，保证服务能起来，不会像以前那样直接崩掉。

### 部署方式

**方式 A：SSH 上去用 docker compose（推荐，能构建镜像）**

```bash
# 群晖：套件中心装好 Container Manager 后即可用 docker / docker compose
cd /volume1/docker
git clone <你的仓库> webclip   # 或把项目文件拷进来
cd webclip
cp .env.example .env
vi .env        # 改 PUBLIC_BASE_URL、PUID/PGID
docker compose up -d --build
```

**方式 B：在电脑上构建好镜像再搬到 NAS（DSM「项目」界面不支持 build）**

```bash
# 电脑上
docker build -t webclip:latest .
docker save webclip:latest -o webclip.tar
# 拷到 NAS 后
docker load -i webclip.tar
```

然后在 DSM → Container Manager → 项目 → 新建，compose 里把 `build:` 那段删掉、只留 `image: webclip:latest`（并保留 `PUID`/`PGID`、`shm_size`、`/data` 映射）。

**推荐的目录映射**（把 compose 里 `webclip-data:/data` 那行换掉）：

| NAS | 建议挂载路径 |
| --- | --- |
| 群晖 DSM | `/volume1/docker/webclip/data:/data` |
| 威联通 QTS | `/share/Container/webclip/data:/data` |
| Unraid | `/mnt/user/appdata/webclip:/data` |

### NAS 上的其它注意事项

- **`shm_size: "1gb"` 别删**：Chromium 在 `/dev/shm` 太小（默认 64MB）时会崩。DSM 的 Container Manager 支持这个字段。
- **`PUBLIC_BASE_URL` 要填 NAS 的实际地址**：例如 `http://192.168.1.10:3000`，否则 Markdown 里的图片链接是 `localhost`，在别的设备上打不开。
- **内网服务也能抓**：如果想让 WebClip 抓你家内网的 Wiki/博客，设 `ALLOW_PRIVATE_NETWORK=true`。
- **反向代理 + HTTPS**：用 DSM 的反代或 Nginx/Caddy 转发到 3000 端口后，把 `PUBLIC_BASE_URL` 改成 `https://clip.example.com`；`/media/*` 已带 CORS 头，可被外部 Markdown 阅读器直接引用。
- **CPU 弱的机型**：把 `CONVERT_CONCURRENCY` 降到 `1`（默认 3），并发高时 Chromium 很吃内存；`engine=fetch` 的请求几乎不占资源。
- **ARM 机型**（部分群晖/威联通）：镜像基于 `linux/amd64`，ARM NAS 上需要用 Buildx 构建 `linux/arm64` 镜像（`docker buildx build --platform linux/arm64 -t webclip:latest .`），Playwright 提供 arm64 版 Chromium。

---

## API 文档

所有接口前缀 `/api`。设置了 `API_TOKEN` 时需带 `x-api-token: <token>` 或 `Authorization: Bearer <token>`；`/media/*` 静态资源始终公开（否则 Markdown 里的图片在别处打不开）。

### `POST /api/convert` — 转换单个网址

```bash
curl -X POST http://localhost:3000/api/convert \
  -H 'content-type: application/json' \
  -d '{
    "url": "https://example.com/post",
    "engine": "browser",
    "imageMode": "local",
    "includeVideos": true,
    "waitSelector": "article"
  }'
```

响应（节选）：

```json
{
  "ok": true,
  "data": {
    "id": "20240911-143012-a1b2c3-文章标题",
    "url": "https://example.com/post",
    "finalUrl": "https://example.com/post?utm=1",
    "title": "文章标题",
    "author": "作者",
    "markdown": "---\ntitle: \"文章标题\"\n---\n\n# 文章标题\n\n正文…![图](http://localhost:3000/media/9f2c…c1.png)\n",
    "markdownUrl": "http://localhost:3000/api/articles/<id>/markdown",
    "downloadUrl": "http://localhost:3000/api/articles/<id>/download",
    "media": [
      {
        "kind": "image",
        "sourceUrl": "https://example.com/a.jpg",
        "localUrl": "http://localhost:3000/media/9f2c…c1.png",
        "hash": "9f2c…",
        "file": "9f2c…c1.png",
        "mime": "image/png",
        "bytes": 20481,
        "origin": "capture"
      }
    ],
    "stats": {
      "words": 812, "chars": 1903, "markdownChars": 2410,
      "media": { "saved": 3, "reusedFromCache": 0, "reusedFromCapture": 5, "failed": 0, "bytes": 812345 },
      "adsBlocked": 17, "imagesCaptured": 5, "lazyFixed": 4,
      "extract": { "removedSelectors": 32, "removedByToken": 9, "removedPixels": 1, "removedJunkSections": 3 },
      "elapsedMs": 4213
    },
    "warnings": []
  }
}
```

只要 Markdown 文本：

```bash
curl -X POST http://localhost:3000/api/convert \
  -H 'content-type: application/json' -H 'accept: text/markdown' \
  -d '{"url":"https://example.com/post"}' > post.md
```

也支持把参数放进查询串：

```bash
curl 'http://localhost:3000/api/convert?url=https://example.com/post&engine=fetch&imageMode=local' -H 'accept: text/markdown'
```

### `POST /api/convert/batch` — 批量

```bash
curl -X POST http://localhost:3000/api/convert/batch \
  -H 'content-type: application/json' \
  -d '{"urls":["https://a.com/1","https://b.com/2"],"engine":"fetch"}'
```

单次上限由 `CONVERT_MAX_BATCH` 控制（默认 10）。批量默认不返回正文（可用 `returnMarkdown: true` 打开）。

### 删除与磁盘回收

删除逻辑按布局分别处理，都不会因为删一篇文章把别的文章图片打成死链：

- **`folder` 布局（默认）**：媒体文件带归属文章标记，删除文章时直接把它那整个标题文件夹一起删掉
- **`flat` 布局**：图床是**按内容寻址**的，同一张图可能被多篇文章共用（同一篇文章重复抓取、不同文章引用同一图源），所以按引用计数只删真正没人引用的

```bash
# 删文章，保留图床文件（默认）
curl -X DELETE 'http://localhost:3000/api/articles/<id>' -H 'x-api-token: <TOKEN>'

# 删文章 + 清理它独占的图床文件（被别的文章共用的会保留，并在返回值里报告）
curl -X DELETE 'http://localhost:3000/api/articles/<id>?withMedia=1' -H 'x-api-token: <TOKEN>'
# → {"data":{"removed":true,"withMedia":true,
#     "media":{"candidates":5,"removed":2,"keptBecauseShared":3,"freedBytes":41821}}}

# 批量删除
curl -X POST 'http://localhost:3000/api/articles/delete' -H 'x-api-token: <TOKEN>' \
  -H 'content-type: application/json' -d '{"ids":["<id1>","<id2>"],"withMedia":true}'

# 删单个图床文件（被引用会拒绝，force=1 强删）
curl -X DELETE 'http://localhost:3000/api/media/<hash 或文件名>' -H 'x-api-token: <TOKEN>'

# 回收孤儿文件：先 dryRun 看看有多少，再真删
curl -X POST 'http://localhost:3000/api/media/gc' -H 'x-api-token: <TOKEN>' \
  -H 'content-type: application/json' -d '{"dryRun":true}'
```

Web UI 里：抓取结果面板有「删除这篇文章」，最近转换列表每条记录后面有「删除」，
右上角勾选框控制是否「删除时同时清理图床文件」，旁边还有「回收孤儿图床文件」按钮（会先统计再确认）。

> 另外：文章 id 带秒级时间戳，同一秒内重复抓同一网址本来会生成同一个 id 并**静默覆盖**上一篇；
> 现在会自动加 `-2`、`-3` 后缀，绝不覆盖已有文章。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/articles?limit=20&offset=0&q=关键词` | 文章列表 |
| GET | `/api/articles/:id?includeMarkdown=1` | 文章元数据（可选带正文） |
| GET | `/api/articles/:id/markdown` | 正文（`text/markdown`，浏览器内联显示） |
| GET | `/api/articles/:id/download` | 正文（附件下载，文件名自动生成） |
| DELETE | `/api/articles/:id?withMedia=1` | 删除文章；`withMedia=1` 顺带清理它**独占**的图床文件 |
| POST | `/api/articles/delete` | 批量删除：`{"ids":[...],"withMedia":true}`（单次上限 200） |
| GET | `/api/media?limit=50&sort=newest` | 图床文件列表 |
| GET | `/api/media/by-url?url=<原始地址>` | 按源地址查本地副本 |
| DELETE | `/api/media/:ref?force=1` | 删除单个图床文件；`ref` 支持 hash / hash 前缀 / 文件名 / 相对路径（如 `我的标题/01.jpg`）。仍被文章引用时返回 `409 media_in_use`，加 `force=1` 才强删 |
| POST | `/api/media/gc` | 回收**没有任何文章引用**的孤儿文件；`{"dryRun":true}` 只统计不删 |
| POST | `/api/media/prune` | 按容量淘汰最久未使用的文件 |
| GET | `/api/rules` | 当前广告规则规模 |
| GET | `/api/stats` | 图床/文章/配置统计 |
| GET | `/healthz` | 健康检查（Docker healthcheck 用） |
| GET | `/media/<file>` | **本地图床静态资源**（folder 布局下即 `/media/<站点域名>/<标题>/01.jpg`；长缓存、允许跨域） |
| GET | `/media-only/<file>` | **只下载模式**的素材目录（`MEDIA_ONLY_DIR`，与 `/media` 同一套缓存头，单独一棵目录树） |
| GET | `/` | 内置 Web UI（抓取 / **API 测试** 两个视图） |

### Web UI 里的文章浏览

首页顶部切到「**文章浏览**」：左侧是已存档文章列表（带搜索、分页），右侧直接阅读渲染后的 Markdown。

- 三个标签页：**渲染** / **Markdown 源码** / **媒体**（缩略图墙）
- 元信息一行显示站点、作者、发布时间、存档时间、字数、媒体数、自动生成的文件名，以及原文链接
- 操作：复制、下载 `.md`（文件名来自服务端自动命名）、删除（默认同时清理图床文件）
- **深链**：地址栏形如 `#browse/<文章 id>`，可以直接分享或收藏，刷新后仍停在读的那篇
- 三个视图都走 hash 路由（`#clip` / `#browse/<id>` / `#api`），浏览器前进后退可用

### Web UI 里的 API 测试

打开首页 → 顶部切到「**API 测试**」：

- **接口列表**：14 个接口按「抓取 / 文章 / 图床 / 诊断」分组，点一下即选中
- **参数表单**：按接口动态生成字段（布尔/下拉/数字/文本），自动拼成 query 或 JSON 请求体；也可直接编辑请求体 JSON
- **发送与响应**：显示 HTTP 状态码、耗时、响应类型、响应大小、`x-article-id` 等关键响应头；JSON 自动格式化，`text/markdown` 可直接点「预览 Markdown」；响应里带媒体时顺带渲染缩略图墙
- **复制 curl**：按当前参数生成可直接粘贴到 NAS 终端执行的 curl 命令（含 Token 头）
- **请求历史**：最近 12 次调用，点一下即可回填参数复现
- **一键自检**：按顺序跑

  | 检查项 | 验证内容 |
  | --- | --- |
  | 健康检查 | 服务存活、版本、浏览器状态 |
  | 统计接口 | `/api/stats` 可访问，图床/文章规模 |
  | 接口鉴权 | `API_TOKEN` 是否已设置（未设置会警告公网裸奔） |
  | 广告规则 | 规则是否被 `ADBLOCK_DISABLE` 关掉 |
  | 抓取转换 | 真实抓一次目标网址（可切 `browser`/`fetch`），报告字数、媒体数、拦截请求数 |
  | Markdown 直链 | 生成的 `.md` 能否取回 |
  | 图床直链 | 媒体文件能否免 Token 访问；`PUBLIC_BASE_URL` 与当前访问地址不一致时给出警告 |
  | 清理自检数据 | 删掉自检产生的文章，不留垃圾 |

  右侧「复制报告」可把结果（含失败原因）整段复制出来贴到 issue 里。

错误响应统一为：

```json
{ "ok": false, "error": { "code": "bad_request", "message": "…" } }
```

常见状态码：`400` 参数/URL 非法或被 SSRF 规则拒绝 · `401` Token 错误 · `404` 文章不存在 · `422` 页面无有效 HTML · `429` 限流 · `502` 上游失败 · `504` 超时。

---

## 请求选项

所有选项既可放在 `options` 对象里，也可直接放在请求体顶层，或作为查询参数：

| 选项 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `url` | string | — | 必填，目标网址 |
| `engine` | `browser` \| `fetch` | `browser` | 抓取引擎 |
| `imageMode` | `local` \| `remote` \| `none` | `local` | 媒体处理方式：下载到本地图床 / 保留外链 / 全部删除 |
| `includeImages` | bool | `true` | 是否保存图片 |
| `includeVideos` | bool | `true` | 是否保存视频 |
| `includeAudio` | bool | `true` | 是否保存音频 |
| `filterAds` | bool | `true` | 是否启用广告与无关内容过滤 |
| `frontmatter` | bool | `true` | 是否生成 YAML frontmatter |
| `includeTitle` | bool | `true` | 是否在正文顶部加 `# 标题` |
| `includeMetaSection` | bool | `false` | 是否在末尾附"本地图床资源"清单 |
| `store` | bool | `true` | 是否落盘（`false` 只返回结果） |
| `scroll` | bool | `true` | 自动滚动触发懒加载 |
| `scrollSteps` | number | `12` | 最大滚动次数 |
| `waitSelector` | string | — | 等待该 CSS 选择器出现 |
| `waitMs` | number | `0` | 额外等待毫秒数 |
| `timeoutMs` | number | `120000` | 单次任务总超时（上限 300000） |
| `maxMediaFiles` | number | `80` | 单页最多保存的媒体数量 |
| `mediaLayout` | `folder` \| `flat` | `MEDIA_LAYOUT`（默认 `folder`） | 媒体目录布局：`folder` = `media/<站点>/<标题>/01.jpg` 按顺序编号；`flat` = 内容寻址去重（别名 `layout`） |
| `mediaOnly` | boolean | `false` | **只下载视频图片**：媒体存到独立目录（`MEDIA_ONLY_DIR`，默认与 `DATA_DIR` 同级），默认不落文章（别名 `onlyMedia`） |
| `webhook` | boolean | 见下 | 抓完是否发通知：不传时"`mediaOnly=1` **或**给了 `webhookUrl`"会自动发；普通请求要发就传 `webhook=true` |
| `webhookUrl` | string | 空 | 单次请求覆盖 webhook 地址（留空用服务端 `WEBHOOK_URL`） |
| `xhsApiUrl` | string | 空 | 单次请求覆盖**小红书自建解析器**地址（留空用服务端 `XIAOHONGSHU_API`）；填了就只有这次请求走它 |
| `xhsParserOnly` | boolean | `true` | 小红书是否只走解析器、不抓网页（仅配了解析器时有效） |
| `maxFileBytes` | number | `26214400` | 单张图片上限（字节） |
| `maxVideoBytes` | number | `268435456` | 单个视频上限（字节，默认 256MiB） |
| `maxAudioBytes` | number | `67108864` | 单个音频上限 |
| `maxBytesPerPage` | number | `83886080` | 单页图片+音频总量上限 |
| `maxVideoBytesPerPage` | number | `536870912` | 单页视频总量上限 |
| `removeSelectors` | string[] | `[]` | 额外要删除的选择器 |
| `headers` | object | `{}` | 附加请求头 |
| `cookies` | string | — | Cookie 字符串（登录后才可见的页面） |
| `userAgent` | string | 内置 Chrome UA | 自定义 UA |
| `returnMarkdown` | bool | `true` | 是否在 JSON 里返回正文 |
| `onMediaError` | `keep` \| `drop` | `keep` | 媒体下载失败时保留外链还是删掉该媒体 |
| `recoverEmbeddedMedia` | bool | `true` | 是否从页面内嵌数据里补媒体（微信图片消息/SPA 必需） |
| `embeddedMediaHeading` | string | `图片（来自页面数据）` | 补进来的媒体小节标题 |
| `observedMediaHeading` | string | `视频（来自页面请求）` | 从播放器网络请求里补出来的音视频小节标题 |
| `videoMarkdown` | `html` \| `link` \| `both` | `html` | 视频/音频在 Markdown 里的表示形式 |
| `filenameTemplate` | string | 见下 | 下载文件名模板，可覆盖服务端 `FILENAME_TEMPLATE` |

### 下载文件自动命名

下载（`/api/articles/:id/download`）、正文直链（`/api/articles/:id/markdown`）以及 `POST /api/convert` 的 `text/markdown` 响应，都会自动生成文件名：

```
Content-Disposition: attachment; filename="20260913-120000-9cb7b2-285-PPT.md"; filename*=UTF-8''2024-01-05-%E7%A7%91%E6%8A%80...
X-Article-Filename: 2024-01-05-%E7%A7%91%E6%8A%80...      ← 同一个名字（百分号编码）
```

HTTP 头只能是 latin1，所以中文名放在 `filename*`（RFC 5987）里；`filename="..."` 是给不支持 `filename*` 的客户端/下载器的
**可读 ASCII 兜底名**：

| 情况 | `filename="..."` |
| --- | --- |
| 文件名里有 ASCII 词 | 保留它们，如 `2026-09-14-Rust-1.80.md` |
| 纯中文标题 | `<日期>-<站点>-<标题短哈希>`，如 `2026-09-14-toutiao-68d973.md` |
| 连标题都没有 | `<日期>-<域名>`，如 `2026-09-14-m.toutiao.com.md` |

> 兜底名**绝不会是文章 id**（id 是「时间戳-哈希-slug」，早先拿它兜底时，用 `curl -OJ`、NAS 下载器这类
> 只看 `filename=` 的客户端下载出来就是一串时间戳，会被误以为"没按标题命名"）。浏览器用 `filename*`，
> 拿到的始终是上面那个完整中文名。

文件名由模板 `FILENAME_TEMPLATE` 决定，默认 `{date}-{title}`（带日期，便于归档排序且不会重名），例如
`2024-01-05-科技爱好者周刊（第 285 期）：为什么 PPT 不如备忘录.md`。

| 占位符 | 含义 |
| --- | --- |
| `{date}` | 发布日期；页面没给发布时间的就用抓取日期（`YYYY-MM-DD`） |
| `{clipdate}` / `{time}` / `{datetime}` | 抓取日期 / 抓取时间 `HHMMSS` / 抓取日期时间 `YYYY-MM-DD_HHMMSS` |
| `{title}` | 标题（已去掉"标题 \| 站点名"这类后缀） |
| `{site}` / `{host}` | 站点名（og:site_name）/ 域名 |
| `{author}` / `{id}` / `{words}` / `{lang}` | 作者 / 文章 id / 字数 / 语言 |

示例：

```bash
FILENAME_TEMPLATE='{title}'                      # 只用标题
FILENAME_TEMPLATE='{date}-{site}-{title}'        # 日期-站点-标题
FILENAME_TEMPLATE='{site}/{date} {title}'        # 站点子目录（/ 会被清理成空格）
FILENAME_TEMPLATE='{clipdate}_{time}-{title}'    # 抓取时间精确到秒，几乎不可能重名
```

也可以按请求覆盖：`{"url":"...","filenameTemplate":"{title}"}`。
生成时会做这些处理：去掉文件系统非法字符（`\ / : * ? " < > |`，全角冒号等 NFKC 归一化）、
收敛重复分隔符、按 `FILENAME_MAX_LENGTH`（默认 100 字符）与 `FILENAME_MAX_BYTES`（默认 200 字节）双重截断
——**字节上限是必须的**：ext4/NTFS 单个文件名最多 255 字节，中文一个字 3 字节，只按字符数截会写出存不下的名字；
`+ # % & '` 这类合法字符会原样保留（`C++ 教程` 不会被吃成 `C 教程`）；避免 Windows 保留名（con/prn/aux…）。

> 中文名的长度还会受 HTTP 头限制：名字放在 `filename*` 里做百分号编码，所以截断必须切在**字符边界**上，
> 不能对编码后的字符串直接 `slice`（否则会切出半个汉字，客户端拿到 `…- 今日` 这种半截名字）。
生成的 `filename` 会随文章一起存进 `meta.json`，所以之后下载的名字始终一致；它也出现在
`POST /api/convert` 的结果和 `/api/articles` 列表里，方便客户端直接用（Web UI 的「下载 .md」就是这么做的）。

---

### 网址记录 + 正文副本（重复抓取不再重复下载）

服务内部用 **SQLite**（Node 内置 `node:sqlite`，零第三方依赖）维护两张表：

| 表 | 内容 |
| --- | --- |
| `urls` | 抓过的网址记录：正文指纹、抓取次数、正文变更次数、最近抓取/变更时间、对应文章 |
| `articles` | **正文副本**：Markdown 全文 + 元数据（便于检索，也供下次比对） |

数据库文件默认在 `DATA_DIR/webclip.db`（WAL 模式）。`node:sqlite` 需要 Node ≥ 24（或 22.5~23.3 加 `--experimental-sqlite`）；
环境不满足时**不会影响服务启动**，只是这些功能降级为 no-op，日志里会写明原因。

**重复抓取会先比对正文，没变就不再下载**：抓完页面、抽出正文后，服务会算一个"正文指纹"——
正文纯文本 + 媒体数量 + 每个媒体地址的**最后一段路径**（例如字节跳动 CDN 的 `.../VIDEOID/?a=24&x-signature=…`，
域名前缀和签名每次都会变，用最后一段才能在跨会话时稳定比较）。

- 指纹一致 **且** 影响输出的选项（`imageMode`、`includeVideos`、`videoMarkdown`、文件名模板…）也一致
  → 直接复用已存档的文章、正文副本与图床文件，**一个字节都不重新下载**，响应里带 `"unchanged": true`、`"reused": true`
- 指纹变了 → 正常完整处理，并另存为新快照（网址记录里的"正文变更次数"+1，`warnings` 里会提示）
- 想强制重抓：请求里带 `"force": true`

```bash
# 查一个网址抓过没有（不会触发抓取）
curl 'http://localhost:3000/api/urls/check?url=https://example.com/a' -H 'x-api-token: <TOKEN>'
# → {"known":true,"fetchCount":3,"changeCount":1,"contentHash":"…","articleId":"…","wouldReuse":true}

# 网址记录列表（可按网址/标题搜索）
curl 'http://localhost:3000/api/urls?limit=50&q=example' -H 'x-api-token: <TOKEN>'

# 忘掉某条记录（文章与图片都保留；下次抓这个网址会完整重新下载）
curl -X DELETE 'http://localhost:3000/api/urls/7' -H 'x-api-token: <TOKEN>'

# 在正文副本里全文检索
curl 'http://localhost:3000/api/search?q=关键词' -H 'x-api-token: <TOKEN>'
```

**删除文章时，对应的网址记录与正文副本会一起删掉**（`DELETE /api/articles/:id` 的返回值里
`database: { removedBodies, removedUrls }` 会告诉你删了几条）；所以删掉再抓 = 完整重新下载一遍。
如果只想清理记录、保留文章，用 `keepUrlRecords=1` 或直接删 `/api/urls/:id`。

Web UI 的「文章浏览」视图里新增了「**网址记录**」页签：可以看到每个网址抓了几次、正文变过几次、
正文长度与媒体数、指纹前缀、最近抓取时间，并能直接跳到对应文章或"忘掉"这条记录。

---

### 视频在 Markdown 里怎么表示

默认输出 **HTML `<video>` 标签**，支持 HTML 的阅读器（Obsidian 阅读模式、Typora、VS Code 预览、多数静态站点生成器）可以直接播放：

```html
<video src="http://你的地址/media/16a0cc7784665ea433a6575a.mp4" controls preload="metadata" poster="http://你的地址/media/cover.jpg"></video>
```

用 `VIDEO_MARKDOWN` 切换（也可按请求传 `videoMarkdown`）：

| 值 | 输出 | 适用 |
| --- | --- | --- |
| `html`（默认） | `<video src="…" controls></video>` | Obsidian / Typora / VS Code 预览等支持 HTML 的阅读器 |
| `link` | `[▶ 视频](…)` | 会把 HTML 过滤掉的渲染器（例如 GitHub、部分博客平台） |
| `both` | 标签 + 链接兜底 | 读者环境不确定时最保险 |

细节：属性值会做 HTML 转义（`&` → `&amp;`）；有封面时写进 `poster`；**只有封面没有地址**时退回成一张图片；
音频同理输出 `<audio controls>`。内置 Web UI 的预览也能直接播（预览渲染器对 `<video>`/`<audio>` 会放行真实标签，其余 HTML 仍然转义防注入）。

---

## 广告与无关内容过滤是怎么做的

三层，逐层收窄（规则集中在 `src/adblock/rules.js`，可用环境变量追加）：

**第 1 层 · 网络请求拦截**（无头浏览器路由层，不下载就不占带宽）

- 约 90 条广告/统计/弹窗域名规则：DoubleClick、Google Ads/GA/GTM、Amazon Ads、Taboola、Outbrain、Criteo、AdNxs、PubMatic、百度统计/联盟、CNZZ、友盟、神策、GrowingIO、OneTrust、Cookiebot …
- 路径规则：`/pagead/`、`/gampad/`、`/adserver/`、`/track/`、`/pixel`、`/beacon`、`facebook.com/tr/`、`1x1.gif` …
- 主文档永不拦截（避免把页面本身拦掉）
- 默认还会拦掉内网地址请求（SSRF）

**第 2 层 · DOM 删除**（`cleanDocument`）

- 基础噪音：`script/style/noscript/template/link/meta/object/embed/canvas/form/input/button/dialog[role=dialog]` 等
- 广告位：`ins.adsbygoogle`、`ins[data-ad-slot]`、`amp-ad`、`[id^=div-gpt-ad]`、`[class*=adsbygoogle]`、`[class*=sponsored-content]` …
- 干扰层：Cookie/同意书、订阅框、弹窗遮罩、分享条、评论表单、侧栏、导航、页脚、面包屑、分页
- class/id **词元**判定：`ad-container`、`sidebar-widget` 命中，`download-button`、`adaptive-layout`、`article-body` 不误伤
- 追踪像素：声明尺寸 ≤2px、`/1x1.gif`、`spacer.gif`、透明 GIF data URI
- iframe 白名单：只保留 YouTube / Bilibili / Vimeo / CodePen / Gist 等嵌入，广告 iframe 删除

**第 3 层 · 结构启发式**（`removeJunkSections`）

- 正文短于 400 字、链接 ≥3、链接密度 >0.5 的块直接删除
- 命中"相关阅读 / 猜你喜欢 / 广告 / 赞助 / 评论 / 分享 / Related Posts / Sponsored"等标题的段落连同内容一起删除
- 清洗后正文过短（<220 字）时，自动退回"只删明确广告位"的轻量模式重试，防止把内容删空

媒体侧还有几类特殊处理：

- **懒加载扶正**：`data-src`/`data-original`/`data-lazy-src`/`srcset`/`data-bg` → 真实 `src`，并优先选非占位图
- **占位图识别**：`placeholder`、`blank`、`spacer`、`lazy`、`1x1` 等路径不作为正文图
- **背景图配图**：很多站点（今日头条、部分 CMS）把正文配图写成 `<div style="background-image:url(...)">`。这类节点没有文字，会先被 Readability 和我们自己的空节点清理误删，所以**在清洗之前**就把它们转成真正的 `<img>`（浏览器引擎还会按渲染尺寸过滤掉图标/装饰图）
- **播放器 UI 清理**：播放器容器的按钮/进度/提示（"暂停""00:09 / 00:25""进入全屏"）会被删除，否则这些字会一字不差混进正文；清理后只剩媒体的容器会被**解包**，避免变成"没有文字的空 div"而被 Readability 丢掉
- **封面属性提升**：`data-poster`/`tt-poster`/`data-cover` 等属性里的封面地址会被提升为 `<video poster>`，随视频一起进图床
- **播放器地址兜底（重要）**：不少站点把播放地址藏在 JS 里 —— 字节跳动的短视频页最典型：HTML 里
  既没有 `<video>` 也没有任何媒体地址，全靠 `tt-videoid` + 签名 token 去换播放信息，甚至走 MSE。这时靠
  **网络层观测**：浏览器实际请求过的音视频地址会被记下来，然后
  · 正文里有 `<video>`（空的、`data:`、`blob:` 都算）→ 把地址填进去；
  · 正文里完全没有播放器节点 → 追加到正文末尾的「视频（来自页面请求）」小节。
  m3u8/mpd 播放列表与分片会被排除（无法存成单文件）；同一份内容的不同 CDN 地址会按本地文件去重。
- **推广块清理**：`扫码下载 App` / `打开 App 继续阅读` 这类只含一小段文字 + 链接/二维码的块会被删掉，
  二维码图片（URL 含 `qrcode`）也不会进图床。
- **页面数据兜底（重要）**：越来越多页面把正文配图放在 `<script>` 的内嵌 JSON/JS 数据里交给前端渲染。典型是
  微信**「图片消息」**：图片地址在 `picture_page_info_list[].cdn_url`，DOM 里根本没有 `<img>`，
  渲染成 swiper 后又只懒加载可视区域那一两张 —— 图片本身完全能下载，但**从未进入流水线**。
  现在会扫描内嵌数据把媒体地址挖出来（解码 `\x0a`/`\/`/`&amp;` 等转义，跳过头像/图标/统计像素/广告域名/重复项），
  在"页面数据里的媒体明显比 DOM 里多"时补进正文末尾的「图片（来自页面数据）」小节，每个媒体独占一行。
  可用 `recoverEmbeddedMedia: false` 关掉，或用 `embeddedMediaHeading`、`observedMediaHeading` 改小节标题。
- **描述兜底**：正文几乎为空（< 40 字）而页面提供了 description（或站点数据里的文案）时，把描述当导语补在开头
  （顺带解码微信那种没解码的字面量 `\x0a`）。
- **站点适配器（抖音 / 小红书）**：这两类站点的 DOM 里连占位 `<img>` 都没有，只有一个空壳播放器 + 签名接口，
  真实的图片/视频地址只在页面内嵌数据里。适配层会按站点结构解析数据再收集媒体：
  · **抖音**：`window._ROUTER_DATA`（`loaderData…item_list[0]`）/ `RENDER_DATA` / `__INITIAL_STATE__`，
    视频取 `video.play_addr.url_list[]`（多域名多码率里挑一个）并带 `video.cover` 当封面，图文作品取 `images[].url_list[]`（按顺序），
    文案取 `desc`、作者取 `author.nickname`；推荐流里的其它作品不会被抓进来。
  · **小红书**：`__INITIAL_STATE__`（`note.noteDetailMap[].note`）/ `RENDER_DATA`（整段 URI 编码），
    图片取 `imageList[].urlDefault`，视频取 `video.media.stream.h264[].masterUrl`，标题/正文/作者取 `title`/`desc`/`user.nickname`。
  适配器是"锦上添花"：解析不出来只会少抓几个媒体文件，不会影响正文抓取；不认识的站点直接跳过。
  字段名随站点改版会变，所以实现是"按字段名模式递归识别"而不是写死路径（见 `src/pipeline/sites/`）。
- **标题去重**：正文里那个与文章标题重复的 `#/##` 标题会被去掉（正文标题常少个「 - 站点名」后缀，按前缀判定）。

---

## 本地图床

```
folder 布局（默认）：
/data/media/我的文章标题/01.jpg、02.png、03.mp4   ← 一个标题一个文件夹，按正文出现顺序编号
flat 布局：
/data/media/9f2c8a…c1.png                        ← 文件名 = sha256(内容) 前 24 位 + 扩展名
/data/media-index.ndjson                         ← 相对路径 → 记录 索引（放在 media 目录外，不会被静态服务暴露）
```

对外访问：`GET /media/<file>`（`Cache-Control: immutable`、`Access-Control-Allow-Origin: *`），Markdown 中的链接即 `${PUBLIC_BASE_URL}/media/<file>`。
媒体默认**按网站分类**：页面域名（去掉开头的 `www.`）作为第一层目录，`media/douyin.com/…`、`media/xiaohongshu.com/…`。
`folder` 布局下链接形如 `${PUBLIC_BASE_URL}/media/xiaohongshu.com/%E6%88%91%E7%9A%84%E6%A0%87%E9%A2%98/01.jpg`（中文文件夹名逐段 URL 编码，浏览器与静态服务都能正常处理）。

| 布局 | 路径形态 | 适合谁 |
| --- | --- | --- |
| `folder`（默认，`MEDIA_LAYOUT=folder`） | `media/<站点>/<标题>/01.jpg` | 想直接翻目录看图、要"一个作品一个文件夹"、同名内容各存一份也无所谓 |
| `flat`（`MEDIA_LAYOUT=flat`） | `media/<站点>/<sha256>.jpg` | 想最省磁盘、跨文章共用同一张图、重复抓取时零下载命中缓存 |

站点目录由页面**最终 URL 的域名**决定（短链跳转后按真实站点归类），可用 `MEDIA_GROUP_BY_SITE=false` 关掉、退回旧的扁平结构。
关掉或改名都不影响老数据：每条图床记录都存着自己的相对路径，Markdown 里的链接和删除/回收逻辑都按记录里的路径走。
单次请求可用 `mediaLayout`（或 `layout`）覆盖服务端默认值。注意 `folder` 布局**不做跨文章内容去重**，也不享受 flat 的 URL 索引零下载（重复抓取仍由"网址记录 + 正文指纹"挡在前面，正文没变时不会重新下载）。

- **字节捕获**：浏览器渲染时已经在内存里的图片字节会被直接复用，省掉一次网络请求（`stats.media.reusedFromCapture`）
- **播放器触发**：抖音这类 MSE 播放器把视频流交给 `blob:` + MediaSource，地址**只有开始播放才会请求**。抓取流程会在收网前主动把播放器推起来（`PAGE_PLAY_NUDGE_MS`，默认 4s），否则同一个地址有时抓得到、有时什么都抓不到。
- **DASH 合流**：抖音 `/video/<id>` 把音视频拆成 `…/media-video-avc1/`（纯视频轨）与 `…/media-audio-und-mp4a/`（纯音频轨）。装了 ffmpeg（`FFMPEG_PATH`，Docker 镜像已内置）时用 `-c copy` 无损合成一个带声音的 MP4（`stats.media.muxed`）；没装就分别保存，音频存成 `.m4a` 并在 `mediaFailures` 里给出提示。
- **编码提示（只提示不干预）**：站点常常给同一段视频多个档位（分辨率/码率/编码各不同），管线按**分辨率优先、其次码率**挑最高的那一档。若挑中的是 **H.265(HEVC) 或 AV1**，落盘后会在 `warnings` 里提示"部分播放器解不了、只有声音"——Windows 自带播放器、不少手机和浏览器确实解不了 HEVC，常见表现就是"视频只有音频"。想要能到处播的 H.264 就自己换档位（或用支持 HEVC 的播放器，如 VLC/PotPlayer）。
- **同内容去重**：播放器会为同一条视频请求多个清晰度档位（起播低档、随后升档），抖音的地址里还带签名段导致"同一文件多个 URL"。字节一致的按内容哈希去重；时长相同而体积不同的只保留最大的那档 —— 即画质最好的那份（`stats.media.deduped`）。
- **容量治理**：超过 `MAX_MEDIA_TOTAL_BYTES` 后按"最久未使用"从旧到新淘汰（本次引用的文件不会被删）
- 视频里的 HLS/DASH 播放列表（`.m3u8`/`.mpd`）无法保存为单文件，会跳过并保留原始链接（出现在 `mediaFailures`）

> 重要：Markdown 里的图片链接指向 `PUBLIC_BASE_URL`。部署到服务器/反向代理后一定要把它设成外部可访问的域名，否则在别的设备上打开 `.md` 图片是坏的。HTTPS 场景建议由 Nginx/Caddy 反代并开启 CORS。

### 小红书自建解析器（推荐，可配可不配）

小红书网页端的正文和媒体都在签名接口后面：没登录时短链会一路跳到登录页，页面里只剩占位图；
就算配了 Cookie，改版/风控也会让它时灵时不灵。所以更稳的做法是**自建一个解析器**，
例如 [JoeanAmier/XHS-Downloader](https://github.com/JoeanAmier/XHS-Downloader)（自带 HTTP API），
一次请求就能拿到**作品标题、正文、作者、图片/视频直链**。

```bash
# .env
XIAOHONGSHU_API=http://192.168.1.10:5556/xhs/detail   # 用局域网 IPv4，别用只有 IPv6 的 DDNS 域名
XIAOHONGSHU_API_TIMEOUT_MS=30000
XIAOHONGSHU_PARSER_ONLY=true   # 默认值：配了解析器就完全不抓网页
```

配好之后：

- **小红书链接优先走解析器**（`source: "xhs_api"`），拿到标题/正文/直链；解析器没结果时**自动回退**页面解析，两条路都失败才只是少抓几个文件。
- **默认「只走解析器、不抓网页」**（`XIAOHONGSHU_PARSER_ONLY=true`）：连网页都不打开，直接用解析器的标题/正文/直链造一篇页面往下走。
  这样做是因为**未登录或被风控时网页只会返回「安全限制」这类页面** —— 抓它既没内容、又容易把验证/封禁引到抓取机上。
  实测同一条短链：只走解析器 6.9s 完成、标题正文图片全部正确；关掉这个开关则要多抓一次网页（7.9s）且页面正文是登录页。
  想恢复"先抓网页、解析器只当兜底"的老行为，设 `XIAOHONGSHU_PARSER_ONLY=false` 或在单次请求里传 `xhsParserOnly=false`。
- **链接必须带 `xsec_token`**：小红书现在要求地址里带它才取得到作品数据。没有 token 的笔记地址（例如从浏览器直接拷的
  `/discovery/item/<id>`）解析器只会回「获取小红书作品数据失败」；用 **App「分享 → 复制链接」得到的 `xhslink.cn` 短链**最稳
  （程序会自动跳转取出带 token 的完整地址）。检测到缺 token 时程序会把这条提示写进 `warnings`。
- **抓取失败先跑自检**（分步定位到底哪一环断的）：

  ```bash
  # 在 webclip 容器里执行（镜像已内置该脚本）
  docker exec <webclip容器> node src/cli/xhs-doctor.js "https://xhslink.cn/o/xxxx"

  # 本机（非容器）也可以
  npm run doctor:xhs -- "https://xhslink.cn/o/xxxx"
  ```

  逐项检查：配置 → DNS（含"域名只有 IPv6、容器没有 IPv6"这个坑）→ TCP 端口 → 短链展开 → `xsec_token` →
  解析器返回数据 → **第一个媒体直链能否下载**（解析器通了不等于小红书 CDN 通）→ 挂载卷写权限（NAS 上常见）→ 完整抓取一次。
  每项失败都给出该怎么做；加 `--json` 输出机器可读结果。
- **两个容器不在同一网络也没关系**：webclip 只需要能访问解析器的 **HTTP 地址**。解析器端口若已映射到宿主机，用
  `http://<宿主机局域网IP>:5556/xhs/detail`（推荐）；没映射就把两个容器放进同一个 Docker 网络，改用容器名
  （`http://xhs-api:5556/xhs/detail`）。容器名和 `localhost` 在"不同网络"或"另一个容器"里都不成立
  （容器里的 `localhost` 指 webclip 自己）。
- **短标题不会被误判**：两个字的中文标题（实测作品标题「龙湾」）是正经标题；只有「整条就是站点名/样板文案」
  （「小红书」「Loading」「Just a moment…」）或**拉丁字母不足 4 个**（"OK"、"Hi"）才算占位标题。
  早先"少于 4 个字就算占位"的规则会把两字标题顶掉、标题掉成 `www.xiaohongshu.com`，素材目录也跟着变成域名。
- **图片会按小红书 CDN 的指令取格式**：解析器给的直链形如 `…?imageView2/format/png`。这个指令**必须原样带出去**
  —— 早先 URL 规范化会把 `/` 编码成 `%2F`（`imageView2%2Fformat%2Fpng=`），CDN 认不出来就返回上传时的**原始 HEIC**，
  很多看图软件打不开（实测同一张图：坏指令给 22KB HEIC，正确指令给 133KB PNG）。现在追踪参数照删、CDN 指令原样保留。
- **占位标题不会盖掉真标题**：未登录/风控页的标题（「小红书 - 你的生活兴趣社区」「安全限制」「访问频繁」…）会被识别为占位标题，
  一律让位给解析器给的作品标题。
- **没有标题的笔记用日期当标题**：图文笔记可以真的没有标题（实例如
  `https://www.xiaohongshu.com/discovery/item/6aaa07f90000000028000fdd`，解析器返回 `作品标题: (空)`），
  这时用**作品自己的发布时间**当标题，形如 `2026-09-16 03:07`（到分钟，避免同一天多条无标题笔记挤进同一目录互相覆盖）；
  发布时间缺失/格式异常则退回"今天"。落盘路径里冒号会被 slug 成 `-`（`2026-09-16-03-07`），Windows/SMB 都能用。
  解析器的 `发布时间` 同时会写进 front matter 的 `published`。
- **`xhslink.cn` / `xhslink.com` 分享短链会被自动展开**：这类短链解析器不认，程序会先跳一次拿到
  `…/login?redirectPath=<编码后的笔记地址>`，把里面的笔记地址（含必需的 `xsec_token`）取出来再交给解析器。
  实测把短链直接丢给解析器只会得到 `提取小红书作品链接失败`。
- **标题不再被占位标题顶掉**：未登录时页面标题是「小红书 - 你的生活兴趣社区」这种，管线会改用解析器给的作品标题。
- **协议细节**（自建 FastAPI 版实测）：`POST` + JSON `{"url":…,"download":false}`，`GET` 会被 405 拒；
  返回 `{"message":…,"params":…,"data":…}`；**`data` 是空对象 `{}` 时算失败**（不能按"有没有 data"判断成功）。
  视频作品里「下载地址」放的是视频直链，封面单独一个字段、不算独立文件。
- **单次请求覆盖**：请求体里带 `xhsApiUrl`（或 Web UI 高级选项里的「小红书解析」输入框）即可临时换一个解析器地址，
  留空用服务端 `XIAOHONGSHU_API`。
- `GET /healthz` 的 `xiaohongshuApi.configured` 会告诉你服务端到底配没配。

> 解析器地址是**你自己的服务**：容器里必须能连到它。实测两种踩坑（都会报 `fetch failed`，程序会把原因与建议写进 `warnings`）：
>
> | 现象 | 原因 / 处理 |
> |---|---|
> | `ENOTFOUND`（容器里连不上，宿主机却能连） | ① 容器 DNS 指向 NAS 自己（`127.0.0.1`）→ 加 `dns: ["223.5.5.5"]`；② **域名只有 IPv6 记录**（`Resolve-DnsName`/`nslookup` 只看到 AAAA）而**默认 Docker 网络没有 IPv6** → 容器里怎么都连不通。**推荐直接把地址换成局域网 IPv4**：`XIAOHONGSHU_API=http://192.168.x.x:5556/xhs/detail`，或用 `extra_hosts: ["你的域名:192.168.x.x"]` |
> | `ECONNREFUSED` / 超时 | 解析器没在跑、端口没放行，或防火墙只允许本机访问（自建服务记得监听 `0.0.0.0`） |
> | 证书报错（`UNABLE_TO_VERIFY_LEAF_SIGNATURE` 等） | 解析器用了自签名证书：改用 `http`，或换受信任证书 |
>
> 若解析器需要登录态，可同时配 `XIAOHONGSHU_COOKIE`，请求里会把它作为 `cookie` 参数带给解析器。

### 只下载视频图片模式 + webhook 通知

只要素材、不要文章时，请求里加 `mediaOnly=1`：

```bash
curl -X POST 'http://localhost:3000/api/convert' \
  -H 'content-type: application/json' -H 'x-api-token: <TOKEN>' \
  -d '{"url":"https://www.xiaohongshu.com/explore/xxxx","mediaOnly":1,"webhook":true}'
```

- **存到哪儿**：`MEDIA_ONLY_DIR`，默认是 `DATA_DIR` 的**同级**大文件夹（`/data` → `/media-only`）。
  结构与主图床一致：`<站点域名>/<标题>/01.jpg、02.mp4 …`（可用 `mediaLayout=flat` 换成内容寻址）。
  容器里记得把这个目录也挂出来（compose 已带 `webclip-media-only` 卷），否则文件随容器消失。
- **不影响主图床**：单独一棵目录树、单独一份索引；`/media-only/<file>` 静态可访问，清理素材直接删整个文件夹即可。
- **默认不落文章**（不写 `data/articles`、不写网址记录），返回里 `markdownUrl` 为 `null`；想同时留文章就显式传 `store=true`。
- **返回里带磁盘绝对路径**：每个媒体条目多了 `localPath`，另有 `mediaOnly.dir` 告诉这次落在哪个目录，方便脚本直接搬运。
- **webhook**：配 `WEBHOOK_URL` 后，`mediaOnly=1` 的请求会自动发一条；普通请求传 `webhook=true` 也会发，传 `false` 可关。
  也可以在单次请求里用 **`webhookUrl`** 临时覆盖通知地址（无需改服务端配置）。
  报文格式由 `WEBHOOK_FORMAT` 决定（`json`（默认，完整 JSON，含 `text` 摘要）/ `text` / `slack` / **`synology`（群晖 Chat）** / `feishu` / `dingtalk` / `wecom`），
  需要鉴权用 `WEBHOOK_HEADERS`（JSON）。发送失败只记日志、不影响抓取，结果里会带 `webhook: {ok, status, url, error}` 供排查。
- **消息里带下载直链**：不管是哪种格式，正文都会列出每个视频/图片的**可点下载地址**（本地图床直链，最多 30 条）。
  如果 `PUBLIC_BASE_URL` 还是 `localhost`，消息末尾会额外提醒一句（否则手机点不开）。
- **超长消息自动分条**：聊天平台对单条消息都有长度上限（群晖 Chat 实测约 **2000 字**，超过会被回
  `{"code":410,"errors":"msg too long"}`）。程序按各平台上限（群晖取 1900）**按行切分成多条**发送，
  每段开头带「（1/3）」这样的标记，**下载链接不会被截断**；分条之间留 `WEBHOOK_PART_DELAY_MS`（默认 1.5s）间隔，
  遇到群晖的 `create post too fast` 还会自动重试。上限可用 `WEBHOOK_MAX_CHARS` 覆盖。

**群晖 Chat（DSM 的 Chat 套件）怎么配**

1. Chat 里进「频道 → 集成 → 传入 Webhook」，生成一条地址，形如
   `https://<能访问 DSM 的域名或 IP>/webapi/entry.cgi?api=SYNO.Chat.External&method=incoming&version=2&token=%22xxxxxxxx%22`；
2. `.env` 里填（群晖常用自签名证书，所以第三个开关别忘）：
   ```bash
   WEBHOOK_URL=https://ddns.example.sbs/webapi/entry.cgi?api=SYNO.Chat.External&method=incoming&version=2&token=%22xxxxxxxx%22
   WEBHOOK_FORMAT=synology
   WEBHOOK_TLS_VERIFY=false
   ```
3. 之后带 `mediaOnly=1` 的抓取会自动往这个频道发消息，形如：
   ```
   【WebClip】隐藏在大山里的木质小家
   来源：https://xhslink.cn/o/xxxx
   媒体：共 3 个（视频 1 / 图片 2），合计 26.1MB
   保存目录：/media-only
   下载地址：
   1. 视频 20.35MB http://192.168.1.10:3000/media-only/douyin.com/…/01.mp4
   2. 图片 0.30MB http://192.168.1.10:3000/media-only/xiaohongshu.com/…/01.jpg
   ```

> 注意：群晖 Chat 的**传入 Webhook 只能发文本**（不能通过它上传文件），所以这里发的是下载链接；
> 手机点链接会直接打开/下载对应视频或图片。想让链接在手机上可用，`PUBLIC_BASE_URL` 必须写成 NAS 的域名或 `IP:端口`。

**webhook 不通？先跑自检**

```bash
curl -X POST 'http://localhost:3000/api/webhook/test' \
  -H 'content-type: application/json' -H 'x-api-token: <TOKEN>' \
  -d '{"url":"https://<你的 webhook 地址>","format":"synology"}'
```

它不抓任何东西，只往那个地址发一条测试消息，并**把对方的 HTTP 状态与响应正文带回来**（正文里往往直接写着原因）。

群晖 Chat 常见错误对照：

| 现象 | 原因 / 处理 |
|---|---|
| `error: fetch failed (ENOTFOUND)` | **容器里解析不了域名**（群晖常见：容器的 DNS 指向 NAS 自己的 `127.0.0.1`）。给 compose 的 service 加 `extra_hosts: ["你的域名:192.168.1.10"]`（把域名直接指到 NAS 局域网 IP），或加 `dns: ["223.5.5.5","1.1.1.1"]`；也可以把 webhook 地址直接换成 NAS 的局域网 IP |
| `HTTP 404` + 一大段 HTML，连 `/webapi/query.cgi` 也 404 | 这个**主机:端口**没把 `/webapi/` 路由到 DSM（常见于 DDNS 指到了 Web Station 站点或反代没放行）。换成能访问 DSM 的地址（**443 或 80**） |
| `{"error":{"code":407,"errors":"payload: url and text are both empty"}}` | 报文形式不对：群晖的传入 webhook **不收 JSON 正文**，要发**表单编码的 `payload=<JSON 字符串>`**。本程序已内置处理（`WEBHOOK_FORMAT=synology`）；手工 curl 测试时要注意 |
| `{"error":{"code":404,"errors":"invalid token"}}` | 端口对了但 **token 无效**：回 Chat「频道 → 集成 → 传入 Webhook」重新复制（或重置）整条地址 |
| `{"error":{"code":105,"errors":"autoblock"}}` | 试错次数太多，NAS 把来源 IP **自动封锁**了：DSM → 控制面板 → 安全性 → 自动封锁，把该 IP 解封（或加进允许名单） |
| `error: fetch failed (UNABLE_TO_VERIFY_LEAF_SIGNATURE)` / `DEPTH_ZERO_SELF_SIGNED_CERT` | NAS 用的是自签名证书，把 **`WEBHOOK_TLS_VERIFY=false`** 打开即可（只影响 webhook 这一个请求） |
| `{"error":{"code":410,"errors":"msg too long"}}` | 单条消息超过群晖上限（实测约 **2000 字**）。程序会自动分条发送（每段带「（i/N）」标记）；若仍出现，把 `WEBHOOK_MAX_CHARS` 调小（如 1500） |
| `{"error":{"code":411,"errors":"create post too fast"}}` | 短时间发太多条，群晖在限流：程序会自动重试；也可调大 `WEBHOOK_PART_DELAY_MS` |

正确的群晖 Chat 地址长这样（token 里的引号是 URL 编码的 `%22`，直接用 Chat 给的那条即可）：

```
https://<能够访问 DSM 的域名或 IP>/webapi/entry.cgi?api=SYNO.Chat.External&method=incoming&version=2&token=%22xxxxxxxx%22
```

手工用 curl 验证时记得是表单编码：

```bash
curl -X POST 'https://<NAS>/webapi/entry.cgi?api=SYNO.Chat.External&method=incoming&version=2&token=%22xxxx%22' \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode 'payload={"text":"hello from curl"}'
```

**Web UI**：抓取视图的「高级选项」里有 **「只下载视频图片」勾选框**、**Webhook 地址输入框**和**通知下拉（跟随 / 总是发 / 不发）**；
结果面板会显示素材目录与通知结果（`通知：已发送（200）`）。同一组参数也加进了 **API 测试视图**的 `POST /api/convert` 字段里。

---

## 环境变量

完整清单见 `.env.example`，常用项：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | 监听地址 |
| `PUBLIC_BASE_URL` | `http://localhost:3000` | **Markdown 中媒体链接前缀，部署必改** |
| `API_TOKEN` | 空 | 设置后 `/api/*` 需鉴权 |
| `FILENAME_TEMPLATE` | `{date}-{title}` | 下载文件名模板（占位符见上） |
| `FILENAME_MAX_LENGTH` | `100` | 文件名最大字符数 |
| `FILENAME_MAX_BYTES` | `200` | 文件名字节上限（ext4/NTFS 单名 255 字节） |
| `VIDEO_MARKDOWN` | `html` | 视频/音频输出为 `<video>` 标签还是链接（`html`/`link`/`both`） |
| `DATA_DIR` | `./data` | 数据目录（容器内 `/data`） |
| `DATABASE_ENABLED` | `true` | 是否启用网址记录 / 正文副本（SQLite） |
| `DATABASE_FILE` | `DATA_DIR/webclip.db` | 数据库文件位置 |
| `SKIP_UNCHANGED_REFRESH` | `true` | 正文没变就复用存档、不再下载（`force=true` 可强制重抓） |
| `CONVERT_CONCURRENCY` | `3` | 并发抓取数（每个任务一个浏览器上下文） |
| `CONVERT_JOB_TIMEOUT_MS` | `120000` | 单任务超时 |
| `RATE_LIMIT_PER_MINUTE` | `0` | 每 IP 每分钟请求上限，0 = 关闭 |
| `BROWSER_HEADLESS` | `true` | 是否无头 |
| `CHROMIUM_NO_SANDBOX` | `false`（容器内 `true`） | 是否加 `--no-sandbox` |
| `BROWSER_CHANNEL` | 空 | `chrome` / `msedge`，或留空用自带 Chromium |
| `BROWSER_IDLE_CLOSE_MS` | `300000` | 空闲多久关闭浏览器释放内存 |
| `PAGE_AUTO_SCROLL` | `true` | 自动滚动触发懒加载 |
| `MAX_MEDIA_FILE_BYTES` | `26214400` | 单张图片上限（25MiB） |
| `MAX_VIDEO_BYTES` | `268435456` | 单个视频上限（256MiB，大视频按需调大） |
| `MAX_AUDIO_BYTES` | `67108864` | 单个音频上限（64MiB） |
| `MAX_MEDIA_FILES_PER_PAGE` | `80` | 单页媒体数量上限 |
| `MAX_VIDEO_BYTES_PER_PAGE` | `536870912` | 单页视频总量上限（512MiB） |
| `MAX_MEDIA_TOTAL_BYTES` | `5368709120` | 图床总容量（5GiB） |
| `MEDIA_LAYOUT` | `folder` | 媒体目录布局：`folder`=按标题文件夹 + 顺序编号 / `flat`=内容寻址去重 |
| `MEDIA_GROUP_BY_SITE` | `true` | 媒体是否按网站分一层目录（`media/douyin.com/…`）；关掉退回旧的扁平结构 |
| `FFMPEG_PATH` | 空 | ffmpeg 可执行文件路径（留空自动找 PATH / Playwright 自带）；用于 DASH 音视频合流 |
| `PAGE_PLAY_NUDGE_MS` | `4000` | 触发页面播放器后等多久收网（MSE 播放器的媒体请求要等播放才开始） |
| `DOUYIN_COOKIE` | 空 | 抖音登录 Cookie：抓 `douyin.com`（含 `v.douyin.com` 短链、`iesdouyin.com`）时自动带上 |
| `XIAOHONGSHU_COOKIE` | 空 | 小红书登录 Cookie：抓 `xiaohongshu.com` / `xhslink.com` / `xhslink.cn` 时自动带上 |
| `XIAOHONGSHU_API` | 空 | **小红书自建解析器**（如 [XHS-Downloader](https://github.com/JoeanAmier/XHS-Downloader)）：填入后，小红书链接优先调用此 API 解析，**无需 Cookie 也能抓取**。示例：`http://xhs-parser.example.com:5556/xhs/detail` |
| `XIAOHONGSHU_API_TIMEOUT_MS` | `30000` | 自建解析器单次请求超时（解析视频笔记偏慢） |
| `XIAOHONGSHU_PARSER_ONLY` | `true` | 配了解析器时小红书**只走解析器、完全不抓网页**（避开「安全限制」风控页）；设 `false` 恢复"先抓网页、解析器兜底" |
| `SITE_COOKIES` | 空 | 其它站点的 Cookie，JSON：`{"example.com":"a=1; b=2"}`（子域自动匹配） |
| `BROWSER_HEADLESS` | `true` | 设 `false` 走**有头模式**；容器里会由入口脚本自动拉起 Xvfb |
| `BROWSER_USER_AGENT` | 空 | 浏览器上下文 UA；**留空=用浏览器自己的真实 UA（推荐）**，设成与真实浏览器不符的值会被风控拦 |
| `XVFB_ENABLED` | `false` | 只要虚拟显示、不改 headless 配置时用（`XVFB_DISPLAY` / `XVFB_SCREEN` 可调） |
| `MEDIA_ONLY_DIR` | `DATA_DIR` 同级 `media-only` | 「只下载视频图片」模式的素材根目录 |
| `WEBHOOK_URL` | 空 | 抓完发通知的地址；留空不发 |
| `WEBHOOK_FORMAT` | `json` | 报文格式：`json` / `text` / `slack` / `synology`（群晖 Chat）/ `feishu` / `dingtalk` / `wecom` |
| `WEBHOOK_HEADERS` | 空 | 附加请求头（JSON），如 `{"Authorization":"Bearer xxx"}` |
| `WEBHOOK_TIMEOUT_MS` | `10000` | 通知发送超时 |
| `WEBHOOK_TLS_VERIFY` | `true` | 是否校验 webhook 证书；群晖等自签名证书场景设 `false` |
| `ALLOW_PRIVATE_NETWORK` | `false` | 是否允许抓内网地址 |
| `ADBLOCK_DISABLE` | `0` | 设为 `1` 完全关闭广告过滤 |
| `ADBLOCK_EXTRA_DOMAINS` | 空 | 追加广告域名（逗号分隔） |
| `LOG_LEVEL` | `info` | `debug` 可看到每条拦截/下载细节 |

---

## 目录结构

```
.
├── Dockerfile                  # node:24-slim + playwright chromium --with-deps
├── docker-compose.yml          # 带数据卷、shm、healthcheck
├── .env.example
├── public/index.html           # 内置 Web UI（抓取视图 + API 测试视图，零依赖，含简易 Markdown 预览）
├── scripts/clip.mjs            # 命令行抓取工具
├── scripts/inspect.mjs         # 抓取诊断工具（媒体为什么没抓到 / 正文为什么是空的）
├── scripts/selfcheck.mjs       # 部署自检（健康检查/鉴权/抓取/图床直链）
├── src
│   ├── server.js               # Express 装配：鉴权、限流、静态图床、健康检查、优雅退出
│   ├── config.js               # 全部环境变量与默认值
│   ├── routes/api.js           # REST 接口
│   ├── adblock/rules.js        # 广告域名/路径/DOM 选择器/词元规则
│   ├── browser
│   │   ├── pool.js             # Chromium 池：路由拦截、图片捕获、上下文隔离、空闲回收
│   │   └── lazyload.js         # 注入页面的懒加载扶正脚本
│   ├── pipeline
│   │   ├── convert.js          # 主流程编排（引擎 → 抽取 → 媒体 → Markdown → 落盘）
│   │   ├── extract.js          # DOM 清洗 + Readability + 元信息 + 标题清理
│   │   ├── dom-media.js        # 背景图配图还原、播放器 UI 清理、封面属性提升
│   │   ├── media.js            # 媒体收集、下载、去重、链接改写
│   │   ├── markdown.js         # Turndown 规则 + frontmatter + Markdown 后处理
│   │   ├── fingerprint.js      # 正文指纹 / 选项指纹（判断"要不要重新下载"）
│   │   ├── embedded.js         # 页面内嵌数据里的媒体地址挖掘
│   │   └── sites               # 站点适配器：抖音 / 小红书（页面数据 → 图片视频）
│   │       ├── index.js        #   按域名选站点 + 字段模式递归识别 + 媒体收集
│   │       ├── state.js        #   页面内嵌 JSON 的宽容解析（URI 编码/undefined/括号配对）
│   │       ├── douyin.js       #   抖音：_ROUTER_DATA / RENDER_DATA 等数据位置
│   │       └── xiaohongshu.js  #   小红书：__INITIAL_STATE__ / RENDER_DATA
│   ├── storage
│   │   ├── media.js            # 本地图床：folder/flat 两种布局、顺序编号、容量淘汰、删除
│   │   ├── articles.js         # 文章落盘与检索、未被占用 id、引用 hash 统计
│   │   ├── db.js               # SQLite：网址记录 + 正文副本（Node 内置 node:sqlite）
│   │   └── maintenance.js      # 删除编排：文章+图床引用计数清理、孤儿回收
│   └── utils                   # 日志、错误、网络(SSRF/下载)、文本、并发、文件名
└── test
    ├── smoke.test.mjs          # API 端到端测试（本地夹具站点，无需外网）
    └── ui.test.mjs             # Web UI 测试（jsdom 加载真实页面 + 桩 fetch）
```

---

## 自测

```bash
npm test                       # 跑两套：API 端到端 + Web UI（jsdom，无需外网）
npm run test:api               # 仅 API 端到端（本地夹具站点）
npm run test:ui                # 仅 Web UI（jsdom 加载 public/index.html，桩掉 fetch）
npm run test:runner            # 用 node --test 跑（部分沙箱会因管道 stdio 受限）

# 额外验证无头浏览器引擎：
#   Linux/macOS:  TEST_BROWSER=1 npm test
#   Windows:      $env:TEST_BROWSER='1'; $env:BROWSER_CHANNEL='chrome'; npm test
```

覆盖：广告域名规则、class/id 词元误伤、slug 合法性、SSRF 拦截、参数校验、fetch 引擎全流程（逐项断言过滤结果）、无 alt 图片不被误删、标题永久链接展开、背景图配图抓取、播放器 UI 清理、视频独立大小上限、图床落盘与 HTTP 读取、重复抓取零下载、**folder 布局（标题文件夹 / 顺序编号 / 同名标题不互相覆盖 / 删除整目录 / 中文文件夹名可访问）**、**站点适配器（抖音视频与图文、小红书图文+视频、推荐流不混入、URI 编码与 `undefined` 字面量解析、非适配站点安全跳过）**、`imageMode` 三种模式、`filterAds=false`、**下载文件名自动生成（含 ASCII 兜底）**、REST 接口与错误码、`Accept: text/markdown` 内容协商、**删除功能（图床引用计数保护 / 批量删除 / 单文件删除 409 与 force / 孤儿回收 dryRun）**、浏览器引擎（广告拦截计数 + 图片字节捕获 + **空闲回收后自动重启**）、Web UI（接口列表/参数联动/发送与响应渲染/curl 生成/请求历史/一键自检/401 识别/非法 JSON 拦截/删除与回收交互）。

---

## 常见问题

**Q：抓回来的正文是空的 / 只有几行？**
多半年限在反爬或纯前端渲染。依次尝试：`engine=browser`（默认）→ 加 `waitSelector`（如 `article`、`.post-content`）→ 加 `waitMs: 3000` → `scroll: true`。响应里的 `warnings` 会提示"正文内容极少"。

**Q：图片变成了原始外链（没有本地化）？**
说明下载失败，看 `mediaFailures[].reason`：

| reason | 含义与处理 |
| --- | --- |
| `too_large` | 超过单文件上限。**视频默认 256MiB、图片默认 25MiB**，大视频请调大 `MAX_VIDEO_BYTES` |
| `download_failed` | 4xx/5xx。很多站点的图片链接是**每次加载单独签名**的（如字节 CDN 的 `x-signature`），离开那个页面会话就可能失效，只能靠页面加载时的网络层捕获 |
| `upstream_error` | 网络/超时，可重试或设大 `FETCH_TIMEOUT_MS` |
| `streaming_playlist` | m3u8/mpd 播放列表，无法保存为单文件 |
| `page_budget_exceeded` | 单页媒体总量超预算，见 `MAX_MEDIA_BYTES_PER_PAGE` / `MAX_VIDEO_BYTES_PER_PAGE` |
| `not_media` / `unexpected_type` | 返回的是 HTML/JSON（多为防盗链或错误页） |

**Q：页面里明明有视频/图片，抓回来却没有？**
按这个顺序排查：
1. 用诊断工具看清页面结构：`node scripts/inspect.mjs <url>`，它会列出 DOM 里的 `img`/`video`/背景图数量、懒加载扶正结果、抽取到的媒体目标与失败原因；
2. 视频是不是超过上限（`mediaFailures` 里会有 `too_large`）；
3. 视频地址是不是 `blob:`（MSE 流式播放）或 m3u8——这两种无法保存为单文件；
4. 图片是不是挂在 `background-image` 上（见上文"背景图配图"），或链接本身已失效（连浏览器都打不开）；
5. **图片地址是不是只在页面数据里**（微信公众号"图片消息"、Next.js/Nuxt 站点、各类 SPA/swiper 相册）——这种情况下
   响应里的 `stats.embeddedMedia` 会显示 `{found, used}`，告警里也有一条说明，媒体会补在正文末尾；
   如果 `found` 有值但 `used` 为 0，说明 DOM 里已有足够媒体，被判定为"数据里那些多半是推荐位"而没有补。

**Q：抖音的视频抓不到 / 抓下来没声音？**
抖音是"媒体地址只存在于网络请求里"的 MSE 播放器，链路上有四个坑，都已内置处理，但依赖几个前提：
1. **必须 `engine=browser`**：`fetch` 引擎对抖音只能拿到"加载中"的空壳。
2. **必须有可用的浏览器**：本机裸跑要 `npx playwright install chromium`，或设置 `BROWSER_CHANNEL=chrome`（代码会自动在本机 Chrome/Edge 之间兜底）；Docker 镜像里已装真实 Chrome 并默认用它 —— Playwright 自带的 Chromium **没有 H.264/AAC**，抖音播放器探测不到编解码器就不起播，视频流一个请求都不会发。
3. **播放器要被触发**：地址只在播放开始后随请求出现，抓取流程会自动推一次播放（`PAGE_PLAY_NUDGE_MS`）。
4. **音视频是分开的两条 DASH 流**：需要 ffmpeg 合流才能得到"带声音的 MP4"（`FFMPEG_PATH`，镜像已内置）。没有 ffmpeg 时音频会单独存成 `.m4a`，并在 `mediaFailures` 里提示。

如果 Docker 里页面标题变成 `www.douyin.com`、只剩两张图，且 `mediaFailures` 为空，那多半是**身份不一致被风控拦了**。按这个顺序排查：

1. **UA 与真实浏览器是否矛盾**（最常见）：别设置与真实浏览器不符的 `BROWSER_USER_AGENT`（例如 Linux 容器里写 Windows UA）。实测同一容器里：UA 不匹配 → 标题变成 `www.douyin.com`、零视频；改成与浏览器一致（或直接留空用浏览器自带 UA）→ 立刻抓到 45MB 带声音的视频。
2. **出口 IP**：确认容器与宿主机的出口 IP 一致（`docker run --rm webclip:latest node -e "fetch('https://ipinfo.io/ip').then(r=>r.text()).then(console.log)"`）。若容器走的是代理/机房 IP，抖音会直接返回空响应。
3. **配有头模式 + Cookie**：`BROWSER_HEADLESS=false`（镜像内置 Xvfb，入口脚本自动拉起）+ `DOUYIN_COOKIE=...`。`BROWSER_HEADLESS=false` 时要注意 `docker exec` 的新进程不会继承 `DISPLAY`，手动进去调试要加 `-e DISPLAY=:99`。

**Q：需要登录才能看的页面？**
两种方式：① 在 `.env` 里配站点 Cookie（`DOUYIN_COOKIE` / `XIAOHONGSHU_COOKIE` / `SITE_COOKIES`），抓对应域名时自动带上；② 单次请求里传 `cookies`（优先级更高，`engine=browser` 时会注入上下文）。站点 Cookie 也会随媒体下载请求发往该页面的 CDN（抖音/小红书的 CDN 都是自家域名）。

**Q：小红书该用哪个引擎？**
`fetch` 就够（内容本来就在服务端渲染的页面数据里），而且它给出的画质档位是按分辨率挑的；`browser` 在无头容器里会被小红书的风控页（"安全限制"）挡住、有头（`BROWSER_HEADLESS=false`）才能过。两种情况下管线都会**自动兜底**：如果浏览器引擎抓到的正文几乎为空，会自动用 fetch 引擎重抓一次，并在 `warnings` 里说明（同时把风控页那篇垃圾文章清掉）。

**Q：容器里 Chromium 起不来？**
`CHROMIUM_NO_SANDBOX=true`（compose 已默认开启）以及 `--shm-size=1g`。

**Q：`EACCES: permission denied, mkdir '/data/media'`？**
宿主机目录属主与容器运行用户不一致，见[在 NAS 上部署](#在-nas-上部署群晖--威联通--unraid)：设置 `PUID`/`PGID` 即可（容器会自动修权限并降权运行）。

**Q：中文乱码？**
`fetch` 引擎会按 `Content-Type` / `<meta charset>` 自动识别（含 GBK/GB18030）；`browser` 引擎由 Chromium 处理。

**Q：Markdown 里的图片在我电脑上打不开？**
`PUBLIC_BASE_URL` 还是 `localhost`。改成域名或 `IP:端口`。

**Q：想抓内网/本机地址（比如自建 Wiki）？**
`ALLOW_PRIVATE_NETWORK=true`，并清楚这会放开 SSRF 限制。

---

## 安全说明

- **SSRF**：默认拒绝内网/回环/链路本地/保留地址（含 IPv6 与 IPv4-mapped），下载器对每一次重定向都重新校验，浏览器路由层也会拒绝字面内网地址。仅在可信环境才开启 `ALLOW_PRIVATE_NETWORK`。
- **协议**：只允许 `http`/`https`（`file:` 需显式开启）。
- **鉴权**：对外暴露时务必设置 `API_TOKEN`；`/media/*` 是公开的，不要往里放敏感内容。
- **`--no-sandbox`**：容器内默认开启，这是为了在受限内核上能跑起来；代价是降低了进程内隔离，请靠容器隔离 + 不挂载敏感目录来兜底。宿主安全要求高时可关掉它并给容器 `--cap-add=SYS_ADMIN` 或调整 seccomp。
- **运行用户**：容器以 root 启动（为了能按 `PUID`/`PGID` 修好挂载目录权限），随后由入口脚本降权到 `PUID:PGID` 运行 Node 与 Chromium——`docker exec <容器> ps -o uid,cmd` 可确认。不想让它碰目录属主就设 `CHOWN_ON_START=false`；CHOWN 失败时会打印提示并退回 root 运行（`RUN_AS_ROOT=true` 可显式指定）。
- **抓取目标**：请遵守目标站点的 robots/服务条款与版权规定，本工具只做技术实现。
- **按需删除**：`DELETE /api/articles/:id` 删文章，`POST /api/media/prune` 控图床容量。

---

## 容量与性能

- 每个转换任务一个独立的 `BrowserContext`，`CONVERT_CONCURRENCY` 控制并发；浏览器空闲 `BROWSER_IDLE_CLOSE_MS` 后自动关闭释放内存。
- 图片字节在浏览器渲染时就被捕获，**每张图只下载一次**；再次抓取同一页面时命中 URL 索引，**完全不下载**。
- 典型页面（20 张图）在 3~6 秒内完成；纯静态页用 `engine=fetch` 通常 < 1 秒，且几乎不占内存。
- 单页媒体预算：`MAX_MEDIA_FILES_PER_PAGE` × `MAX_MEDIA_FILE_BYTES`，另有 `MAX_MEDIA_BYTES_PER_PAGE` 总预算兜底。
