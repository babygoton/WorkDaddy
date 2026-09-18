#!/usr/bin/env bash
# WorkDaddy × WorkBuddy AI（海外版）Linux 一键脚本
#
# 海外版和国内版最大的区别：它跑在**隔离 HOME** 下（独立应用副本 + 独立配置目录 +
# 独立登录态）。WorkDaddy 的守护进程必须运行在同一个 HOME 里，否则会读到国内版的
# 登录态、数据根也会指错。本脚本负责把这一整套环境变量设好，再转交给通用脚本，
# 免去每次手工 export HOME 的隐患。
#
# 真实路径来源：直接解析你自己的启动器（默认 ~/.local/bin/workbuddy-ai），
# 从里面读出 ISOHOME 与 APP —— 这是最可靠的「地面真相」，不用猜。
#
# 用法:
#   bash scripts/workbuddy-ai-linux.sh install     # 安装（默认）
#   bash scripts/workbuddy-ai-linux.sh relaunch    # 启用 CDP 并重启 WorkBuddy AI
#   bash scripts/workbuddy-ai-linux.sh uninstall   # 卸载（保留备份）
#   bash scripts/workbuddy-ai-linux.sh status      # 查看解析到的环境
#
# 可覆盖的环境变量:
#   WBSWITCH_AI_LAUNCHER   启动器路径（默认探测）
#   WBSWITCH_AI_HOME       隔离 HOME（默认从启动器解析，兜底 ~/.workbuddy-ai-home）
#   WBSWITCH_AI_BIN        应用可执行文件（默认从启动器解析）
#   WBSWITCH_AI_CONFIG     配置/数据目录（默认 $ISOHOME/.config/workbuddy-ai）
set -uo pipefail

# HOME 兜底：部分沙箱/服务化环境不导出 HOME，配合 set -u 会直接报 unbound variable
if [ -z "${HOME:-}" ]; then
  HOME="$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6)"
  [ -n "$HOME" ] || HOME="$PWD"
  export HOME
fi

DIR="$(cd "$(dirname "$0")/.." && pwd)"
ACTION="${1:-install}"
[ $# -gt 0 ] && shift

# 定位「登录用户的真实家目录」。
# 不能只信 getent：容器/沙箱里 uid 可能是 0 而家目录却是 /root，真实工作目录在别处。
# 以「存在海外版应用副本」优先，其次「存在 .workbuddy」，最后才回退到 passwd / $HOME。
resolve_real_home() {
  local candidates=() c
  [ -n "${HOME:-}" ] && candidates+=("$HOME")
  local pw
  pw="$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6)"
  [ -n "$pw" ] && candidates+=("$pw")
  local d
  for d in /home/* /root; do [ -d "$d" ] && candidates+=("$d"); done

  for c in "${candidates[@]}"; do
    [ -e "$c/.local/share/workbuddy-ai/app/workbuddy" ] && { printf '%s' "$c"; return 0; }
  done
  for c in "${candidates[@]}"; do
    [ -d "$c/.workbuddy" ] && { printf '%s' "$c"; return 0; }
  done
  printf '%s' "${candidates[0]:-$PWD}"
}

REAL_HOME="$(resolve_real_home)"

REAL_HOME="$(resolve_real_home 2>/dev/null || true)"

# ---------------- 从启动器解析地面真相 ----------------
LAUNCHER="${WBSWITCH_AI_LAUNCHER:-}"
if [ -z "$LAUNCHER" ]; then
  for d in "$REAL_HOME/.local/bin" "$HOME/.local/bin"; do
    [ -x "$d/workbuddy-ai" ] && { LAUNCHER="$d/workbuddy-ai"; break; }
  done
fi

ISOHOME="${WBSWITCH_AI_HOME:-}"
APP="${WBSWITCH_AI_BIN:-}"
if [ -f "$LAUNCHER" ]; then
  if [ -z "$ISOHOME" ]; then
    ISOHOME="$(sed -n 's/^[[:space:]]*ISOHOME="\([^"]*\)"[[:space:]]*$/\1/p' "$LAUNCHER" | head -1)"
  fi
  if [ -z "$APP" ]; then
    APP="$(sed -n 's/^[[:space:]]*APP="\([^"]*\)"[[:space:]]*$/\1/p' "$LAUNCHER" | head -1)"
  fi
fi
ISOHOME="${ISOHOME:-$REAL_HOME/.workbuddy-ai-home}"

# 应用副本兜底探测
if [ -z "$APP" ] || [ ! -x "$APP" ]; then
  for c in \
    "$REAL_HOME/.local/share/workbuddy-ai/app/workbuddy" \
    "/opt/WorkBuddyAI/workbuddy" \
    "$REAL_HOME/.local/share/workbuddy-ai/app/WorkBuddy AI"; do
    [ -x "$c" ] && { APP="$c"; break; }
  done
fi

# 配置/数据目录：海外版用 --user-data-dir / WORKBUDDY_CONFIG_DIR 重定向到这里
CONFIG="${WBSWITCH_AI_CONFIG:-}"
if [ -z "$CONFIG" ]; then
  for c in "$ISOHOME/.config/workbuddy-ai" "$ISOHOME/.config/WorkBuddy AI" "$ISOHOME/.workbuddy-ai"; do
    [ -d "$c" ] && { CONFIG="$c"; break; }
  done
fi
CONFIG="${CONFIG:-$ISOHOME/.config/workbuddy-ai}"

# ---------------- 自检 ----------------
problems=0
[ -n "$ISOHOME" ] || { echo "✗ 未解析到隔离 HOME" >&2; problems=1; }
if [ ! -x "$APP" ]; then
  echo "✗ 未找到应用可执行文件（可用 WBSWITCH_AI_BIN 指定）: ${APP:-<空>}" >&2
  echo "  提示：先执行 $REAL_HOME/.local/share/workbuddy-ai/setup-overseas-app.sh 准备海外版应用副本" >&2
  problems=1
fi
[ -n "$LAUNCHER" ] && [ -x "$LAUNCHER" ] || echo "⚠ 未找到启动器（将直接执行应用副本，可能丢失免代理等配置）"

if [ "$ACTION" = "status" ]; then
  echo "WorkBuddy AI 环境解析结果"
  echo "  登录用户真实家目录 : $REAL_HOME"
  echo "  隔离 HOME          : $ISOHOME"
  echo "  应用可执行文件     : ${APP:-<未找到>}"
  echo "  配置/数据目录      : $CONFIG"
  echo "  启动器             : ${LAUNCHER:-<未找到>}"
  echo "  登录凭据           : $ISOHOME/.local/share/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop-ai.info"
  echo "  数据库             : $CONFIG/workbuddy.db"
  echo "  WorkDaddy 备份目录 : $ISOHOME/.config/WorkDaddy/profiles/workbuddy-ai"
  echo "  UI 端口 / CDP 端口 : 47833 / 9223"
  echo ""
  echo "存在性检查："
  for p in \
    "$APP" \
    "$CONFIG/workbuddy.db" \
    "$ISOHOME/.local/share/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop-ai.info"; do
    if [ -e "$p" ]; then echo "  ✓ $p"; else echo "  ✗ $p"; fi
  done
  exit $problems
fi

[ "$problems" = "0" ] || exit 1

# ---------------- 设置环境并转交 ----------------
# 关键：HOME 换成隔离 HOME，让 WorkDaddy 读到海外版的登录态与数据根
export HOME="$ISOHOME"
# 同时把「真实家目录」传下去：启动器与守护进程重启应用时都需要还原它，
# 否则启动器会把隔离 HOME 当真实家目录（见 relaunch 脚本里的说明）。
export WBSWITCH_LAUNCH_HOME="$REAL_HOME"
export WBSWITCH_PROFILE=workbuddy-ai
export WBSWITCH_WORKBUDDY_BIN="$APP"
[ -n "$LAUNCHER" ] && [ -x "$LAUNCHER" ] && export WBSWITCH_WORKBUDDY_LAUNCHER="$LAUNCHER"
# 数据根显式固定，避免从任意终端启动时读到国内版残留的 WORKBUDDY_CONFIG_DIR
export WBSWITCH_TARGET_DATA_ROOT="$CONFIG"

if [ "$ACTION" != "probe" ]; then
  echo "==> WorkBuddy AI 环境"
  echo "    HOME=$HOME"
  echo "    应用=$APP"
  echo "    数据根=$CONFIG"
  echo ""
fi

case "$ACTION" in
  install)
    exec bash "$DIR/scripts/install-linux.sh" "$@"
    ;;
  relaunch)
    exec bash "$DIR/scripts/relaunch-with-cdp-linux.sh" "$@"
    ;;
  probe)
    # 只读状态探测：把环境设好之后转交 relaunch 的 --status，
    # 供桌面启动器等外部调用方读取（不必自己重新实现 AI 环境解析）。
    exec bash "$DIR/scripts/relaunch-with-cdp-linux.sh" --status
    ;;
  uninstall)
    exec bash "$DIR/scripts/uninstall-linux.sh" "$@"
    ;;
  *)
    echo "用法: bash scripts/workbuddy-ai-linux.sh [install|relaunch|uninstall|status|probe]" >&2
    echo "  probe: 只读输出运行状态（供桌面启动器调用）" >&2
    exit 1
    ;;
esac
