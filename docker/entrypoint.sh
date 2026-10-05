#!/bin/sh
# ---------------------------------------------------------------------------
# WebClip 入口脚本
#
# 解决 NAS/群晖/威联通上最常见的部署问题：
#   EACCES: permission denied, mkdir '/data/media'
# 原因是 bind mount 会覆盖镜像里 /data 的属主，而容器里跑服务的是 node(1000)，
# 宿主机目录却属于 admin(1026)/root。
#
# 做法：容器以 root 启动 → 建目录 → 按需修属主 → 降权到 PUID:PGID 运行服务。
#
#   PUID / PGID      运行服务的用户，默认 1000:1000（镜像内的 node 用户）
#   RUN_AS_ROOT=true 跳过降权，直接用 root 跑（NAS 上 ACL 特殊、chown 失败时的兜底）
#   CHOWN_ON_START=false 不做任何 chown，完全交给用户自己管权限
# ---------------------------------------------------------------------------
set -eu

DATA_DIR="${DATA_DIR:-/data}"
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
RUN_AS_ROOT="${RUN_AS_ROOT:-false}"
CHOWN_ON_START="${CHOWN_ON_START:-true}"

log() { echo "[entrypoint] $*"; }

# ---------------------------------------------------------------------------
# 有头模式：BROWSER_HEADLESS=false 时浏览器会以"有头"方式启动，
# 但容器里没有显示器，所以先把 Xvfb 虚拟显示拉起来并设好 DISPLAY。
#
#   BROWSER_HEADLESS=false   开有头模式（自动带 Xvfb）
#   XVFB_ENABLED=true        只要 Xvfb，不改 headless 配置
#   XVFB_DISPLAY=:99         虚拟显示号
#   XVFB_SCREEN=1920x1080x24 分辨率/色深
# ---------------------------------------------------------------------------
start_xvfb_if_needed() {
  # 可选参数：以哪个用户跑 Xvfb（"uid:gid"）。降权运行时必须与服务的用户一致，
  # 否则 X socket 权限会让浏览器连不上显示。
  XVFB_USER="${1:-}"
  want_xvfb="false"
  case "${BROWSER_HEADLESS:-true}" in
    false | False | FALSE | 0 | no | off) want_xvfb="true" ;;
  esac
  if [ "${XVFB_ENABLED:-false}" = "true" ]; then want_xvfb="true"; fi
  if [ "$want_xvfb" != "true" ]; then return 0; fi

  if ! command -v Xvfb >/dev/null 2>&1; then
    log "需要 Xvfb（有头模式）但镜像里没有找到，仍按无头方式继续"
    return 0
  fi

  XVFB_DISPLAY="${XVFB_DISPLAY:-:99}"
  XVFB_SCREEN="${XVFB_SCREEN:-1920x1080x24}"
  export DISPLAY="$XVFB_DISPLAY"

  if [ -e "/tmp/.X11-unix/X${XVFB_DISPLAY#:}" ]; then
    log "复用已存在的虚拟显示 $DISPLAY"
    return 0
  fi

  log "启动 Xvfb：DISPLAY=$DISPLAY 分辨率=$XVFB_SCREEN ${XVFB_USER:+（以 $XVFB_USER 运行）}"
  if [ -n "$XVFB_USER" ] && command -v gosu >/dev/null 2>&1; then
    gosu "$XVFB_USER" Xvfb "$XVFB_DISPLAY" -screen 0 "$XVFB_SCREEN" -nolisten tcp >/tmp/xvfb.log 2>&1 &
  else
    Xvfb "$XVFB_DISPLAY" -screen 0 "$XVFB_SCREEN" -nolisten tcp >/tmp/xvfb.log 2>&1 &
  fi
  # 等 X socket 就绪，避免浏览器启动时连不上显示
  i=0
  while [ "$i" -lt 30 ]; do
    [ -e "/tmp/.X11-unix/X${XVFB_DISPLAY#:}" ] && break
    i=$((i + 1))
    sleep 0.2
  done
  if [ -e "/tmp/.X11-unix/X${XVFB_DISPLAY#:}" ]; then
    log "Xvfb 就绪（浏览器将以有头模式运行）"
  else
    log "警告：Xvfb 启动超时，浏览器可能会启动失败（见 /tmp/xvfb.log）"
  fi
}

ensure_dirs() {
  mkdir -p "$DATA_DIR/media" "$DATA_DIR/articles" "$DATA_DIR/tmp" 2>/dev/null || true
}

hint() {
  cat <<EOF
[entrypoint] ---------------------------------------------------------------
[entrypoint] 目录不可写：$DATA_DIR
[entrypoint] 常见解决办法（任选其一）：
[entrypoint]   1) 用 PUID/PGID 指定成宿主机目录的属主（NAS 上最常用）：
[entrypoint]      docker compose 里加：  PUID=1026  PGID=100
[entrypoint]      查宿主机目录属主：      ls -nd /volume1/docker/webclip/data
[entrypoint]   2) 宿主机直接改属主：
[entrypoint]      sudo chown -R 1000:1000 /volume1/docker/webclip/data
[entrypoint]   3) 兜底（不太安全，但一定能跑）：
[entrypoint]      RUN_AS_ROOT=true
[entrypoint] ---------------------------------------------------------------
EOF
}

# ---- 已经是非 root（例如 compose 里写了 user:）------------------------------
if [ "$(id -u)" != "0" ]; then
  log "以非 root 身份启动 (uid=$(id -u) gid=$(id -g))，无法自动修权限"
  ensure_dirs
  if ! touch "$DATA_DIR/media/.write-test" 2>/dev/null; then
    hint
  else
    rm -f "$DATA_DIR/media/.write-test"
  fi
  start_xvfb_if_needed
  exec "$@"
fi

# ---- root 启动：先建目录，再按需修属主，最后降权 -----------------------------
ensure_dirs

if ! id -u node >/dev/null 2>&1; then
  log "镜像内没有 node 用户，直接以 root 运行"
  start_xvfb_if_needed
  exec "$@"
fi

# 把镜像内的 node 用户改成 PUID/PGID（-o 允许与已有 uid 重复）
if [ "$PUID" != "$(id -u node)" ] || [ "$PGID" != "$(id -g node)" ]; then
  log "将运行用户调整为 ${PUID}:${PGID}"
  groupmod -o -g "$PGID" node 2>/dev/null || log "警告：修改 node 组失败，继续使用原 gid"
  usermod -o -u "$PUID" node 2>/dev/null || log "警告：修改 node 用户失败，继续使用原 uid"
fi

TARGET_UID="$(id -u node)"
TARGET_GID="$(id -g node)"

if [ "$RUN_AS_ROOT" = "true" ]; then
  log "RUN_AS_ROOT=true，跳过权限修复与降权（以 root 运行）"
  start_xvfb_if_needed
  exec "$@"
fi

# 用写测试判断权限是否已经正确：正确就跳过递归 chown（文件多时很慢）
NEED_CHOWN="false"
if [ "$CHOWN_ON_START" = "true" ]; then
  if ! gosu "$TARGET_UID:$TARGET_GID" sh -c ": > '$DATA_DIR/media/.write-test'" 2>/dev/null; then
    NEED_CHOWN="true"
  else
    rm -f "$DATA_DIR/media/.write-test"
  fi
fi

if [ "$NEED_CHOWN" = "true" ]; then
  log "修复 $DATA_DIR 属主为 ${TARGET_UID}:${TARGET_GID}（文件较多时可能需要一会儿）…"
  if chown -R "$TARGET_UID:$TARGET_GID" "$DATA_DIR" 2>/dev/null; then
    if ! gosu "$TARGET_UID:$TARGET_GID" sh -c ": > '$DATA_DIR/media/.write-test'" 2>/dev/null; then
      hint
      log "chown 后仍不可写，尝试以 root 运行以免服务起不来"
      start_xvfb_if_needed
      exec "$@"
    fi
    rm -f "$DATA_DIR/media/.write-test"
    log "权限修复完成"
  else
    hint
    log "chown 失败（NAS 上的 ACL/NFS 可能不允许），尝试以 root 运行以免服务起不来"
    start_xvfb_if_needed
    exec "$@"
  fi
fi

log "以 ${TARGET_UID}:${TARGET_GID} 启动：$*"
start_xvfb_if_needed "${TARGET_UID}:${TARGET_GID}"
exec gosu "$TARGET_UID:$TARGET_GID" "$@"
