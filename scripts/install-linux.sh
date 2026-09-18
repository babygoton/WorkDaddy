#!/usr/bin/env bash
# WorkDaddy Linux 安装脚本（CDP 版）
#
# 上游只发布了 macOS(.dmg) / Windows(.exe) 两个包，本脚本补齐 Linux：
#   1) 解析 XDG 数据目录并创建备份目录
#   2) 写入 workbuddy-target.json（把 Linux 可执行文件路径固定下来）
#   3) 首次同步当前登录账号
#   4) 用 setsid 脱离 WorkBuddy 进程树后台启动守护进程
#   5) 等待 /api/status 就绪并打印后续步骤
#
# 用法:
#   bash scripts/install-linux.sh
#   WBSWITCH_PROFILE=workbuddy-ai bash scripts/install-linux.sh
#   WBSWITCH_WORKBUDDY_BIN=/path/to/workbuddy bash scripts/install-linux.sh
#
# 可选环境变量：
#   WBSWITCH_PROFILE       客户端 profile（默认 workbuddy-cn）
#   WBSWITCH_DATA_DIR      备份数据目录（默认 $XDG_CONFIG_HOME/WorkDaddy[/profiles/<id>]）
#   WBSWITCH_PORT          Web 管理界面端口
#   WBSWITCH_CDP_PORT      指定 CDP 端口
#   WBSWITCH_WORKBUDDY_BIN 直接指定 WorkBuddy 可执行文件
set -euo pipefail

# HOME 兜底：部分沙箱/服务化环境不导出 HOME，配合 set -u 会直接报 unbound variable
if [ -z "${HOME:-}" ]; then
  HOME="$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6)"
  [ -n "$HOME" ] || HOME="$PWD"
  export HOME
fi

NO_START=0
REFRESH_TARGET=0
for _arg in "$@"; do
  case "$_arg" in
    --no-start) NO_START=1 ;;
    --refresh-target) REFRESH_TARGET=1 ;;
    --help|-h)
      echo "用法: bash scripts/install-linux.sh [--no-start] [--refresh-target]"
      echo "  --no-start        只准备数据目录/客户端配置/账号备份，不启动守护进程"
      echo "  --refresh-target  重新探测并覆盖 workbuddy-target.json（升级本工具后建议执行）"
      exit 0 ;;
  esac
done
export NO_START REFRESH_TARGET

DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="${WBSWITCH_PROFILE:-workbuddy-cn}"

XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"

case "$PROFILE" in
  workbuddy-ai)   DEFAULT_DATA_DIR="$XDG_CONFIG_HOME/WorkDaddy/profiles/workbuddy-ai"; DEFAULT_UI_PORT=47833 ;;
  codebuddy-cn)   DEFAULT_DATA_DIR="$XDG_CONFIG_HOME/WorkDaddy/profiles/codebuddy-cn"; DEFAULT_UI_PORT=47834 ;;
  codebuddy-intl) DEFAULT_DATA_DIR="$XDG_CONFIG_HOME/WorkDaddy/profiles/codebuddy-intl"; DEFAULT_UI_PORT=47835 ;;
  *)              PROFILE="workbuddy-cn"; DEFAULT_DATA_DIR="$XDG_CONFIG_HOME/WorkDaddy"; DEFAULT_UI_PORT=47832 ;;
esac
export WBSWITCH_PROFILE="$PROFILE"

DATA_DIR="${WBSWITCH_DATA_DIR:-$DEFAULT_DATA_DIR}"
UI_PORT="${WBSWITCH_PORT:-$DEFAULT_UI_PORT}"
export WBSWITCH_DATA_DIR="$DATA_DIR"

# ---------------- 找 node：优先 WorkBuddy 托管运行时，其次 PATH ----------------
# 海外版以隔离 HOME 运行，该 HOME 下通常没有托管 runtime，
# 因此同时把「登录用户的真实家目录」纳入搜索。
REAL_HOME="${WBSWITCH_LAUNCH_HOME:-}"
if [ -z "$REAL_HOME" ]; then
  REAL_HOME="$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6)"
fi
if [ -z "$REAL_HOME" ] || { [ ! -d "$REAL_HOME/.local/share/workbuddy-ai" ] && [ ! -d "$REAL_HOME/.workbuddy" ]; }; then
  for c in "$HOME" /home/*; do
    [ -d "$c/.local/share/workbuddy-ai" ] || [ -d "$c/.workbuddy" ] || continue
    REAL_HOME="$c"; break
  done
fi
[ -n "$REAL_HOME" ] || REAL_HOME="$HOME"
# 传给守护进程：它重启应用时要用真实 HOME 调用启动器
export WBSWITCH_LAUNCH_HOME="$REAL_HOME"

NODE=""
for c in \
  "$DIR/scripts/runtime/node/node" \
  "$REAL_HOME/.workbuddy/binaries/node/versions/22.22.2/bin/node" \
  "$HOME/.workbuddy/binaries/node/versions/22.22.2/bin/node" \
  "$REAL_HOME/.workbuddy/binaries/node/current/bin/node" \
  "$HOME/.workbuddy/binaries/node/current/bin/node" \
  "$(command -v node 2>/dev/null || true)"; do
  if [ -n "$c" ] && [ -x "$c" ]; then NODE="$c"; break; fi
done
if [ -z "$NODE" ]; then
  # 托管 runtime 版本号可能变化，兜底扫一遍目录
  for c in "$REAL_HOME"/.workbuddy/binaries/node/versions/*/bin/node "$HOME"/.workbuddy/binaries/node/versions/*/bin/node; do
    [ -x "$c" ] && { NODE="$c"; break; }
  done
fi
if [ -z "$NODE" ] && [ -x /opt/WorkBuddy/resources/runtime/node/bin/node ]; then
  NODE=/opt/WorkBuddy/resources/runtime/node/bin/node
fi
if [ -z "$NODE" ]; then
  echo "错误: 未找到 node，请先安装 Node.js（或设 PATH 让 node 可见）" >&2
  exit 1
fi
echo "==> 使用 node: $NODE ($("$NODE" -v))"

# 本地回环探测必须绕过系统代理：本机常设 http_proxy 指向 Xray/Clash 等，
# 会让 127.0.0.1 的健康检查被代理拦截（表现为「守护进程未就绪」）。
curl_local() { curl -s --noproxy '*' -m 2 "$@"; }

REPORTER="$DIR/scripts/sentry-report.js"
report_install_failure() {
  local code="$1"
  [ -f "$REPORTER" ] || return 0
  "$NODE" "$REPORTER" --stage linux-install \
    --message "install-linux.sh 失败 (exit=${code})" \
    --extra-json "{\"exitCode\":${code}}" >/dev/null 2>&1 || true
}
on_install_exit() {
  local code="$?"
  if [ "$code" -ne 0 ]; then report_install_failure "$code"; fi
  return "$code"
}
trap on_install_exit EXIT

# ---------------- 1) 备份目录 ----------------
echo "==> 创建备份目录: $DATA_DIR"
mkdir -p "$DATA_DIR/accounts"
chmod 700 "$DATA_DIR"

# 仅停止同用户、同 Node/脚本/profile/数据目录的旧 daemon，避免误杀被复用的 PID。
# --no-start 时不动正在运行的守护进程（例如只想刷新 target 配置的场景）。
if [ "${NO_START:-0}" != "1" ] && [ -f "$DATA_DIR/.daemon.lock" ]; then
  OLD_PID="$("$NODE" -e "try { const j=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); process.stdout.write(String(j.pid||'')); } catch(_) {}" "$DATA_DIR/.daemon.lock")"
  if [[ "$OLD_PID" =~ ^[1-9][0-9]*$ ]] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "==> 停止旧守护进程 pid=$OLD_PID"
    "$NODE" "$DIR/scripts/linux-daemon-process.js" --stop "$OLD_PID" "$NODE" \
      "$DIR/scripts/daemon.js" "$PROFILE" "$DATA_DIR"
  fi
fi

# ---------------- 2) 写入/校验 workbuddy-target.json ----------------
TARGET_FILE="$DATA_DIR/workbuddy-target.json"
if [ -n "${WBSWITCH_WORKBUDDY_BIN:-}" ] || [ "$REFRESH_TARGET" = "1" ] || [ ! -f "$TARGET_FILE" ]; then
  echo "==> 解析并写入 WorkBuddy 客户端路径"
  BIN_ARG="${WBSWITCH_WORKBUDDY_BIN:-}"
  "$NODE" -e '
    const t = require(process.argv[1]);
    const path = require("path");
    const fs = require("fs");
    const dataDir = process.argv[2];
    const profileId = process.argv[3];
    let binary = process.argv[4];
    if (!binary) {
      const p = require(process.argv[5]);
      const prof = p.getProfile(profileId, { dataDir, platform: "linux" });
      binary = prof.appPath;
    }
    if (!binary || !fs.existsSync(binary)) {
      console.error("未找到 WorkBuddy 可执行文件: " + binary);
      console.error("可用 WBSWITCH_WORKBUDDY_BIN=/path/to/workbuddy 显式指定");
      process.exit(2);
    }
    const target = t.buildTargetFromBinary({ binary, profileId, platform: "linux" });
    t.writeWorkBuddyTarget({ dataDir, profileId, target, platform: "linux" });
    console.log("   clientType=" + target.clientType + " port=" + target.cdp.port + " bin=" + target.binary);
  ' "$DIR/scripts/workbuddy-target.js" "$DATA_DIR" "$PROFILE" "$BIN_ARG" "$DIR/scripts/profiles.js"
else
  echo "==> 已存在客户端配置，跳过: $TARGET_FILE"
fi

# ---------------- 2.5) 登录凭据自检 ----------------
# 海外版必须跑在隔离 HOME 下才能看到自己的登录态；若当前 HOME 不对，
# 这里立刻给出可执行的提示，而不是等到守护进程里报「未登录」。
AUTH_PATH="$("$NODE" -e '
  const p = require(process.argv[1]);
  const prof = p.getProfile(process.argv[2], { dataDir: process.argv[3], platform: "linux" });
  process.stdout.write(prof.authFile || "");
' "$DIR/scripts/profiles.js" "$PROFILE" "$DATA_DIR" 2>/dev/null || true)"
if [ -n "$AUTH_PATH" ] && [ ! -f "$AUTH_PATH" ]; then
  echo ""
  echo "⚠️  未找到登录凭据: $AUTH_PATH"
  if [ "$PROFILE" = "workbuddy-ai" ]; then
    echo "   海外版以隔离 HOME 运行，请改用封装脚本（会自动设好 HOME）："
    echo "     bash \"$DIR/scripts/workbuddy-ai-linux.sh\" install"
  fi
  echo "   若已确认路径无误，可忽略本条（未登录状态下首次同步本来就会失败）。"
  echo ""
fi

# ---------------- 3) 首次同步当前登录账号 ----------------
echo "==> 首次同步当前登录账号"
if ! WBSWITCH_PROFILE="$PROFILE" "$NODE" "$DIR/scripts/sync.js"; then
  echo "   (首次同步失败，守护进程启动后会自动重试)"
fi

# ---------------- 4) 后台启动守护进程 ----------------
# 解析并导出「启动器」：守护进程在切换账号时要自己重启应用，
# 靠这个变量才能走启动器（保留免代理环境 / --user-data-dir / MIME 关联）。
# 漏掉它的话，CN 端重启应用会直连二进制，丢掉 workbuddy-noproxy 的免代理配置，
# 登录网关（copilot.tencent.com）可能报 502。
if [ -z "${WBSWITCH_WORKBUDDY_LAUNCHER:-}" ]; then
  case "$PROFILE" in
    workbuddy-ai)   _lnames="workbuddy-ai" ;;
    workbuddy-cn)   _lnames="workbuddy-noproxy workbuddy" ;;
    codebuddy-cn)   _lnames="codebuddy-cn codebuddy" ;;
    codebuddy-intl) _lnames="codebuddy" ;;
    *)              _lnames="" ;;
  esac
  for _d in "$HOME/.local/bin" "$REAL_HOME/.local/bin"; do
    for _n in $_lnames; do
      if [ -x "$_d/$_n" ]; then export WBSWITCH_WORKBUDDY_LAUNCHER="$_d/$_n"; break 2; fi
    done
  done
fi
[ -n "${WBSWITCH_WORKBUDDY_LAUNCHER:-}" ] && echo "==> 启动器: $WBSWITCH_WORKBUDDY_LAUNCHER"

if [ "${NO_START:-0}" = "1" ]; then
  echo "==> --no-start：跳过启动守护进程（可稍后用 relaunch-with-cdp-linux.sh 启动）"
else
# 关键：用 setsid 脱离当前会话/进程组。
# 若从 WorkBuddy 内置终端启动，守护进程会挂在 WorkBuddy 进程树下，
# 后续「切换账号需要重启 WorkBuddy」时会被一起杀掉，导致切换中断。
echo "==> 启动守护进程（已脱离当前会话）"
mkdir -p "$DATA_DIR/accounts"
setsid nohup "$NODE" "$DIR/scripts/daemon.js" >> "$DATA_DIR/daemon.log" 2>&1 < /dev/null &
DAEMON_PID=$!
echo "   pid: $DAEMON_PID"
fi

# ---------------- 5) 等待就绪 ----------------
if [ "${NO_START:-0}" = "1" ]; then
  UI_UP=0
else
echo "==> 等待守护进程就绪"
UI_UP=0
for _ in $(seq 1 20); do
  if curl_local "http://127.0.0.1:${UI_PORT}/api/status" >/dev/null 2>&1; then UI_UP=1; break; fi
  sleep 1
done
fi

echo ""
echo "=============================================="
if [ "${NO_START:-0}" = "1" ]; then
  echo "✅ 准备完成（--no-start：守护进程未启动）"
  echo "   数据目录与客户端配置已就绪，可直接执行下面的「下一步」；"
  echo "   该脚本会先启动守护进程，再带 CDP 重启 WorkBuddy。"
elif [ "$UI_UP" = "1" ]; then
  echo "✅ 安装完成！"
else
  echo "⚠️  守护进程已启动，但 20 秒内未响应 /api/status"
  echo "   请查看日志: tail -50 \"$DATA_DIR/daemon.log\""
fi
echo "   Web 界面 : http://127.0.0.1:${UI_PORT}"
echo "   备份目录 : ${DATA_DIR}"
echo "   客户端   : ${PROFILE}"
echo "   CDP 端口 : ${WBSWITCH_CDP_PORT:-自动选择 (9222-9232/9333)}"
echo "   开机自启 : 已禁用（需要时手动启动）"
echo ""
echo "下一步：让 CDP 生效（必须，否则无法注入组件）"
if [ "$PROFILE" = "workbuddy-ai" ]; then
  echo "   海外版必须走封装脚本（它会设好隔离 HOME，数据根才不会指错）："
  echo "     bash \"$DIR/scripts/workbuddy-ai-linux.sh\" relaunch"
else
  echo "   bash \"$DIR/scripts/relaunch-with-cdp-linux.sh\""
fi
echo "   该脚本会退出并以 --remote-debugging-port 重启 WorkBuddy，"
echo "   之后右下角会出现账号切换组件。"
echo "=============================================="

# 尝试打开管理界面（无图形会话时静默失败）
if command -v xdg-open >/dev/null 2>&1 && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
  xdg-open "http://127.0.0.1:${UI_PORT}" >/dev/null 2>&1 || true
fi
exit 0
