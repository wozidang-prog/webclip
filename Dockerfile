# ---------- 基础镜像 ----------
# 用官方 node 镜像 + playwright install --with-deps，避免绑定某个 Playwright 基础镜像 tag
#
# 选 Node 24 而不是 22：网址记录与正文副本用的是 Node 内置的 node:sqlite，
# Node 22.5~23.3 需要加 --experimental-sqlite 才能加载，Node 24 起开箱可用。
FROM node:24-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    DATA_DIR=/data \
    PORT=3000 \
    HOST=0.0.0.0

WORKDIR /app

# 依赖层（package-lock.json 存在时用 npm ci，保证可复现）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npx playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* /root/.npm /tmp/*

# 入口脚本需要 gosu 来降权运行；ffmpeg 用来把抖音这类 DASH 分离的音视频轨合回一个文件
# （没有它的话，抖音 /video/<id> 抓到的会是"没声音的视频 + 一个音频文件"）。
# 刻意放在 playwright 之后：那层要下载 ~450MB 浏览器，动它就得重下。
RUN apt-get update \
    && apt-get install -y --no-install-recommends gosu ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# 真实 Google Chrome：抖音（以及其它 MSE 播放器）会先用 MediaSource.isTypeSupported 探测 H.264/AAC，
# Playwright 自带的 Chromium **没有专有编解码器**（容器内实测 h264/aac 都是 false），探测失败就不播放，
# 于是视频流一个请求都不会发，只能抓到空壳页。Chrome 自带编解码器，配合 BROWSER_CHANNEL=chrome 即可。
# 单独一层：别动上面那层 ~450MB 的浏览器缓存。
RUN apt-get update \
    && apt-get install -y --no-install-recommends wget ca-certificates \
    && wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
    && apt-get install -y --no-install-recommends /tmp/chrome.deb \
    && rm -f /tmp/chrome.deb \
    && rm -rf /var/lib/apt/lists/*

# 容器里默认就用真实的 Chrome（自带 Chromium 会被反爬识别、也没有 H.264/AAC）
ENV BROWSER_CHANNEL=chrome

# Xvfb：让浏览器可以"有头"运行（BROWSER_HEADLESS=false）。抖音这类站点的风控会盯着无头浏览器，
# 有头 + 虚拟显示通常能过；入口脚本会在需要时自动把 Xvfb 拉起来并设好 DISPLAY。
RUN apt-get update \
    && apt-get install -y --no-install-recommends xvfb xauth \
    && rm -rf /var/lib/apt/lists/*

# 应用代码
COPY src ./src
COPY public ./public
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# 构建时间戳：/healthz 的 build 字段会读它，用来确认容器里跑的是不是最新镜像
# （NAS 上忘记重建镜像时，现象就是"某些链接还是不行"，这个字段一眼就能看出来）
RUN date -u +%Y-%m-%dT%H:%M:%SZ > /app/BUILD_TIME

# 数据目录（图床 + 文章）
RUN mkdir -p /data/media /data/articles /data/tmp \
    && chown -R node:node /data

# 注意：这里刻意不写 USER node —— 容器以 root 启动，由 entrypoint 按 PUID/PGID
# 修好 /data 权限后再降权到普通用户运行，这样才能兼容 NAS 上各种属主的映射目录。
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "src/server.js"]
