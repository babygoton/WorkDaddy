#!/usr/bin/env bash
# WorkDaddy — Linux 版更新落地脚本（由 daemon.js 调用，勿手动执行）
#
# 参数: <新版解包目录> <安装目录> <daemon端口> <日志文件> <attemptId> <profileId>
#
# 与 macOS 的 apply-update.sh 职责相同：替换文件 → 重启 daemon。
# Linux 上没有 .app 包、没有 launchd，因此不需要 launchctl bootout / hdiutil 相关步骤。
set -uo pipefail

SRC="${1:-}"
DST="${2:-}"
PORT="${3:-47832}"
LOG_FILE="${4:-}"
ATTEMPT="${5:-}"
PROFILE="${6:-workbuddy-cn}"

log() {
  local line="[$(date -u +%FT%TZ)] $*"
  echo "$line"
  [ -n "$LOG_FILE" ] && echo "$line" >> "$LOG_FILE" 2>/dev/null
}

if [ -z "$SRC" ] || [ -z "$DST" ]; then
  log "错误：缺少参数（src=$SRC dst=$DST）"
  exit 1
fi

log "开始更新 attempt=${ATTEMPT} profile=${PROFILE} src=${SRC} dst=${DST}"

NODE_BIN="$(command -v node || true)"
[ -z "$NODE_BIN" ] && NODE_BIN="$(ls -1 "$HOME"/.workbuddy/binaries/node/versions/*/bin/node 2>/dev/null | sort -V | tail -1)"
if [ -z "$NODE_BIN" ]; then
  log "错误：未找到 node，无法完成更新"
  exit 1
fi

# ---------- 1. 停掉旧 daemon（只杀本安装目录下的，避免误伤其他 profile） ----------
pkill -f "${DST}/scripts/daemon.js" 2>/dev/null || true
sleep 1
log "旧 daemon 已停止"

# ---------- 2. 备份 + 替换 ----------
if [ ! -d "$SRC" ]; then
  log "错误：解包目录不存在 $SRC"
  exit 1
fi
BACKUP="${DST}.bak.$(date +%s)"
cp -a "$DST" "$BACKUP" 2>/dev/null && log "已备份到 $BACKUP"

mkdir -p "$DST/scripts"
cp -rf "$SRC"/. "$DST/" 2>/dev/null || { log "错误：文件替换失败，正在回滚"; rm -rf "$DST"; mv "$BACKUP" "$DST"; exit 1; }
chmod +x "$DST"/scripts/*.sh 2>/dev/null || true
log "文件已替换"

# ---------- 3. 重启 daemon ----------
DATA_DIR="${WBSWITCH_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/WorkDaddy}"
case "$PROFILE" in
  workbuddy-ai) DATA_DIR="${WBSWITCH_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/WorkDaddy/profiles/workbuddy-ai}" ;;
esac
mkdir -p "$DATA_DIR"
WBSWITCH_PROFILE="$PROFILE" WBSWITCH_DATA_DIR="$DATA_DIR" WBSWITCH_PORT="$PORT" \
  nohup "$NODE_BIN" "$DST/scripts/daemon.js" >> "$DATA_DIR/daemon.log" 2>&1 &
disown 2>/dev/null || true

for _ in $(seq 1 15); do
  curl -s -m 1 "http://127.0.0.1:${PORT}/api/status" >/dev/null 2>&1 && break
  sleep 1
done

if curl -s -m 2 "http://127.0.0.1:${PORT}/api/status" >/dev/null 2>&1; then
  log "更新完成，daemon 已重启（端口 $PORT）"
  rm -rf "$BACKUP" 2>/dev/null || true
  exit 0
fi

log "警告：daemon 重启后未能响应，保留备份 $BACKUP"
exit 1
