#!/usr/bin/env bash
# WorkDaddy — Linux 版 CDP 启动脚本
#
# 作用与 macOS 的 relaunch-with-cdp.sh 一致：
#   1) 确保 WorkDaddy 守护进程在运行（127.0.0.1:<UI_PORT>）
#   2) 彻底退出 WorkBuddy（Linux 上进程名就是二进制名，按路径精确 pkill）
#   3) 带 --remote-debugging-port=<port> 启动 WorkBuddy，保证 CDP 参数生效
#   4) 验证 CDP 端口开放（/json/version 返回 WorkBuddy/CodeBuddy）
#
# 用法:
#   bash scripts/relaunch-with-cdp-linux.sh [CDP端口]
#   WBSWITCH_PROFILE=workbuddy-ai bash scripts/relaunch-with-cdp-linux.sh
#   WBSWITCH_WORKBUDDY_BIN=/opt/WorkBuddy/workbuddy bash scripts/relaunch-with-cdp-linux.sh
#
# 注意：必须在图形会话中（有 DISPLAY 或 WAYLAND_DISPLAY）执行，否则 WorkBuddy 无法启动。
set -uo pipefail

PORT="${WBSWITCH_CDP_PORT:-${1:-}}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="${WBSWITCH_PROFILE:-workbuddy-cn}"

XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"

case "$PROFILE" in
  workbuddy-ai)
    APP_NAME="WorkBuddy AI"
    APP_BIN_DEFAULT="/opt/WorkBuddyAI/workbuddy-ai"
    DEFAULT_DATA_DIR="$XDG_DATA_HOME/WorkDaddy/profiles/workbuddy-ai"
    DEFAULT_UI_PORT=47833
    DEFAULT_CDP_PORT=9223
    AUTH_DEFAULT="$XDG_DATA_HOME/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop-ai.info"
    ;;
  *)
    PROFILE="workbuddy-cn"
    APP_NAME="WorkBuddy"
    APP_BIN_DEFAULT="/opt/WorkBuddy/workbuddy"
    DEFAULT_DATA_DIR="$XDG_DATA_HOME/WorkDaddy"
    DEFAULT_UI_PORT=47832
    DEFAULT_CDP_PORT=9222
    AUTH_DEFAULT="$XDG_DATA_HOME/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info"
    ;;
esac

export WBSWITCH_PROFILE="$PROFILE"
[ -n "$PORT" ] || PORT="$DEFAULT_CDP_PORT"
DATA_DIR="${WBSWITCH_DATA_DIR:-$DEFAULT_DATA_DIR}"
UI_PORT="${WBSWITCH_PORT:-$DEFAULT_UI_PORT}"
AUTH_FILE="${WBSWITCH_AUTH_FILE:-$AUTH_DEFAULT}"
CDP_PORT_FILE="$DATA_DIR/cdp-port.json"

# node：优先系统 PATH，其次 WorkBuddy managed runtime
NODE_BIN="$(command -v node || true)"
# 回退：WorkBuddy 托管的 node。不要写死版本号——客户端升级后旧版本目录会被清掉，
# 这里按版本号排序取最新可用的一个。
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(ls -1 "$HOME"/.workbuddy/binaries/node/versions/*/bin/node 2>/dev/null | sort -V | tail -1)"
fi
if [ -z "$NODE_BIN" ]; then
  echo "错误：未找到 node（需要 >= 18）。请先安装 Node.js 后再运行。"
  exit 1
fi

# ---- 客户端二进制发现 ----
# 优先级：WBSWITCH_WORKBUDDY_BIN > workbuddy-target.json（企业定制）>
#         /usr/share/applications/*.desktop 的 Exec > 默认 /opt 路径
discover_workbuddy_bin() {
  if [ -n "${WBSWITCH_WORKBUDDY_BIN:-}" ] && [ -x "$WBSWITCH_WORKBUDDY_BIN" ]; then
    APP_BIN="$WBSWITCH_WORKBUDDY_BIN"
    return 0
  fi
  if [ -f "$DIR/scripts/workbuddy-target.js" ]; then
    local target
    target="$("$NODE_BIN" "$DIR/scripts/workbuddy-target.js" --resolve --profile="$PROFILE" --data-dir="$DATA_DIR" 2>/dev/null || true)"
    if [ -n "$target" ] && [ -x "$target" ]; then
      APP_BIN="$target"
      return 0
    fi
  fi
  local desktop="" exec_line="" candidate
  for desktop in /usr/share/applications/*.desktop "$HOME/.local/share/applications"/*.desktop; do
    [ -f "$desktop" ] || continue
    grep -qi "workbuddy" "$desktop" 2>/dev/null || continue
    case "$PROFILE" in
      workbuddy-ai) grep -qi "ai" "$desktop" || continue ;;
      *) grep -qi "ai" "$desktop" && continue ;;
    esac
    exec_line="$(sed -n 's/^Exec=//p' "$desktop" | head -1)"
    candidate="${exec_line%% *}"
    [ -n "$candidate" ] && [ -x "$candidate" ] && { APP_BIN="$candidate"; return 0; }
  done
  [ -x "$APP_BIN_DEFAULT" ] && { APP_BIN="$APP_BIN_DEFAULT"; return 0; }
  command -v workbuddy >/dev/null 2>&1 && { APP_BIN="$(command -v workbuddy)"; return 0; }
  return 1
}

APP_BIN=""
if ! discover_workbuddy_bin; then
  echo "错误：未找到 WorkBuddy 客户端可执行文件（$PROFILE）。"
  echo "   可用环境变量 WBSWITCH_WORKBUDDY_BIN=/path/to/workbuddy 指定。"
  exit 1
fi

mkdir -p "$DATA_DIR" "$DATA_DIR/accounts" 2>/dev/null || true

valid_port() { [ "${1:-0}" -ge 1024 ] 2>/dev/null && [ "${1:-0}" -le 65535 ] 2>/dev/null; }
port_in_use() {
  if command -v nc >/dev/null 2>&1; then nc -z -w 1 127.0.0.1 "$1" >/dev/null 2>&1; else curl -s --max-time 1 "http://127.0.0.1:$1/" >/dev/null 2>&1; fi
}
is_workbuddy_cdp() { curl -fsS --max-time 1 "http://127.0.0.1:$1/json/version" 2>/dev/null | grep -qiE 'WorkBuddy|CodeBuddy'; }

resolve_cdp_port() {
  local saved="" p candidates=""
  [ -f "$CDP_PORT_FILE" ] && saved="$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$CDP_PORT_FILE" | head -1)"
  valid_port "$PORT" && candidates="$candidates $PORT"
  valid_port "$saved" && candidates="$candidates $saved"
  for p in $(seq 9222 9232); do candidates="$candidates $p"; done
  candidates="$candidates 9333"
  for p in $candidates; do is_workbuddy_cdp "$p" && { PORT="$p"; break; }; done
  is_workbuddy_cdp "$PORT" || for p in $candidates; do port_in_use "$p" || { PORT="$p"; break; }; done
  if ! valid_port "$PORT"; then echo "错误：9222-9232、9333 均被占用，无法启动 CDP"; exit 1; fi
  printf '{"port":%s,"updatedAt":"%s"}\n' "$PORT" "$(date -u +%FT%TZ)" > "${CDP_PORT_FILE}.tmp.$$" 2>/dev/null || true
  mv -f "${CDP_PORT_FILE}.tmp.$$" "$CDP_PORT_FILE" 2>/dev/null || true
}
resolve_cdp_port

echo ""
echo "WorkDaddy (Linux) — profile=${PROFILE}"
echo "  客户端 : $APP_BIN"
echo "  数据目录: $DATA_DIR"
echo "  CDP 端口: $PORT"
echo ""
echo "警告：即将退出 WorkBuddy 并以 CDP 模式重启（请先保存工作内容，包括当前对话）。"
read -r -p "确认继续？(y/N) " ans
case "$ans" in
  y|Y|yes|YES) ;;
  *) echo "已取消"; exit 0 ;;
esac

# ---------- 1. 启动守护进程 ----------
if ! curl -s -m 1 "http://127.0.0.1:${UI_PORT}/api/status" >/dev/null 2>&1; then
  echo "==> 启动 WorkDaddy 守护进程"
  WBSWITCH_PROFILE="$PROFILE" WBSWITCH_DATA_DIR="$DATA_DIR" WBSWITCH_PORT="$UI_PORT" \
    nohup "$NODE_BIN" "$DIR/scripts/daemon.js" >> "$DATA_DIR/daemon.log" 2>&1 &
  disown 2>/dev/null || true
else
  echo "==> WorkDaddy 守护进程已运行，跳过启动"
fi

for _ in $(seq 1 10); do
  curl -s -m 1 "http://127.0.0.1:${UI_PORT}/api/status" >/dev/null 2>&1 && { echo "==> 守护进程运行中"; break; }
  sleep 1
done

# ---------- 2. 退出 WorkBuddy ----------
echo "==> 退出 WorkBuddy ..."
pkill -f "$APP_BIN" 2>/dev/null || true
sleep 3
if pgrep -f "$APP_BIN" >/dev/null 2>&1; then
  echo "   仍在运行，强制结束"
  pkill -9 -f "$APP_BIN" 2>/dev/null || true
  sleep 2
fi

# ---------- 3. 带调试端口启动 ----------
echo "==> 以 --remote-debugging-port=${PORT} 启动 WorkBuddy"
nohup "$APP_BIN" --remote-debugging-port="$PORT" >/dev/null 2>&1 &
disown 2>/dev/null || true

# ---------- 4. 验证 ----------
echo "==> 等待 CDP 端口开放"
OK=0
for _ in $(seq 1 60); do
  sleep 1
  if curl -s -m 2 "http://127.0.0.1:${PORT}/json/version" | grep -qiE 'WorkBuddy|CodeBuddy'; then
    OK=1
    break
  fi
done

if [ "$OK" = "1" ]; then
  echo ""
  echo "CDP 已开启: http://127.0.0.1:${PORT}"
  echo "   WorkBuddy 启动后右下角会自动出现 WorkDaddy 组件（约几秒内）。"
  echo "   若未出现，可手动重新注入: curl -X POST http://127.0.0.1:${UI_PORT}/api/inject"
else
  echo ""
  echo "警告：等待 60 秒仍未检测到 CDP 端口 ${PORT}。"
  echo "   可能原因：不在图形会话中（无 DISPLAY/WAYLAND_DISPLAY），或客户端忽略了该参数。"
  echo "   手动检查: curl http://127.0.0.1:${PORT}/json/version"
  exit 1
fi
