#!/usr/bin/env bash
# WorkDaddy 桌面启动器（双击使用）
#
# 用途：一个图标搞定两个渠道（国内版 / 国际版）的启动与面板启用。
#
# 它做的事很薄——只负责「选渠道 + 显示状态 + 必要的确认」，真正的启停逻辑全部
# 复用已有脚本（relaunch-with-cdp-linux.sh / install-linux.sh / workbuddy-ai-linux.sh），
# 避免把端口分配、归属判定、启动器还原 HOME 这些坑再实现一遍。
#
# 关键行为：如果目标渠道的面板（CDP）已经在跑，**完全不碰应用窗口**，只确保后台服务；
# 只有在「应用在跑但没开面板」时才需要重启，并且会先弹窗征求同意。
#
# 用法: bash scripts/launch-gui-linux.sh
set -uo pipefail

# HOME 兜底：部分沙箱/服务化环境不导出 HOME，配合 set -u 会直接报 unbound variable
if [ -z "${HOME:-}" ]; then
  HOME="$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6)"
  [ -n "$HOME" ] || HOME="$PWD"
  export HOME
fi

DIR="$(cd "$(dirname "$0")/.." && pwd)"
REL="$DIR/scripts/relaunch-with-cdp-linux.sh"
AI_WRAPPER="$DIR/scripts/workbuddy-ai-linux.sh"
INSTALL="$DIR/scripts/install-linux.sh"

CN_UI_PORT=47832
AI_UI_PORT=47833

ZENITY="$(command -v zenity 2>/dev/null || true)"
# 没有图形会话（SSH / 无 DISPLAY）时不能硬用 zenity，否则只会看到
# "This option is not available" 这种莫名其妙的报错。退化为文本菜单。
if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
  ZENITY=""
fi

# 真实家目录：不只看 getent —— 容器里 uid 可能是 0 而家目录是 /root
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

# ---------------- 状态探测（复用 relaunch 脚本的只读模式） ----------------
CN_STATUS=""
AI_STATUS=""
probe_cn() {
  env -u WBSWITCH_DATA_DIR -u WBSWITCH_CDP_PORT HOME="$REAL_HOME" WBSWITCH_PROFILE=workbuddy-cn \
    bash "$REL" --status 2>/dev/null
}
probe_ai() {
  # 走 AI 封装脚本，由它负责隔离 HOME / 数据根等环境
  env -u WBSWITCH_DATA_DIR -u WBSWITCH_CDP_PORT bash "$AI_WRAPPER" probe 2>/dev/null
}
field() { printf '%s' "$1" | sed -n "s/^$2=//p" | head -1; }

describe() {  # $1=status 输出  $2=渠道名
  local st="$1" name="$2" daemon app cdp
  daemon="$(field "$st" daemon)"; app="$(field "$st" app)"; cdp="$(field "$st" cdp)"
  local d_txt a_txt c_txt
  case "$daemon" in up) d_txt="后台服务 运行中" ;; *) d_txt="后台服务 已停止" ;; esac
  case "$cdp" in
    ""|none) c_txt="面板 未开启" ;;
    *)       c_txt="面板 已开启（端口 $cdp）" ;;
  esac
  case "$app" in running) a_txt="应用 运行中" ;; *) a_txt="应用 未运行" ;; esac
  printf '%s：%s ｜ %s ｜ %s' "$name" "$a_txt" "$c_txt" "$d_txt"
}

# ---------------- 执行动作（带脉冲进度框，避免几秒钟没反应） ----------------
LAST_LOG=""
run_action() {  # $1=标题  $2...=命令
  local title="$1"; shift
  local log
  log="$(mktemp)"
  LAST_LOG="$log"
  if [ -z "$ZENITY" ]; then
    "$@" >"$log" 2>&1
    local rc=$?
    sed -n '$p' "$log" 2>/dev/null
    return $rc
  fi
  "$@" >"$log" 2>&1 &
  local pid=$!
  (
    while kill -0 "$pid" 2>/dev/null; do
      echo "# $title"
      sleep 1
    done
  ) | "$ZENITY" --progress --pulse --no-cancel --auto-close \
        --title="WorkDaddy" --text="$title…" --width=420 >/dev/null 2>&1
  wait "$pid"
  return $?
}

show_result() {  # $1=成功标题  $2=正文
  if [ -n "$ZENITY" ]; then
    "$ZENITY" --info --title="WorkDaddy" --width=460 --text="$1\n\n$2" >/dev/null 2>&1
  else
    printf '%s\n\n%s\n' "$1" "$2"
  fi
}

fail_result() {  # $1=标题
  local tail_log=""
  [ -n "$LAST_LOG" ] && [ -f "$LAST_LOG" ] && tail_log="$(tail -6 "$LAST_LOG" | tr '\n' '\v' | sed 's/\v/\n/g')"
  if [ -n "$ZENITY" ]; then
    "$ZENITY" --error --title="WorkDaddy" --width=520 \
      --text="$1\n\n$tail_log" >/dev/null 2>&1
  else
    printf '%s\n%s\n' "$1" "$tail_log"
  fi
}

confirm_restart() {  # $1=渠道名
  if [ -z "$ZENITY" ]; then return 0; fi
  "$ZENITY" --question --title="需要重启应用" --width=500 \
    --ok-label="重启并启用面板" --cancel-label="取消" \
    --text="<b>$1 当前没有开启面板端口。</b>\n\n必须重启它才能注入面板，重启会关闭当前窗口。\n请先保存正在进行的对话，包括正在聊的内容。\n\n（不想重启的话，可以改选「只启动后台服务」）"
}

# ---------------- 渠道动作 ----------------
activate_cn() {
  CN_STATUS="$(probe_cn)"
  if [ "$(field "$CN_STATUS" cdp_ready)" = "yes" ]; then
    run_action "正在确保国内版后台服务" \
      env -u WBSWITCH_DATA_DIR -u WBSWITCH_CDP_PORT HOME="$REAL_HOME" WBSWITCH_PROFILE=workbuddy-cn \
      bash "$REL" --ensure || { fail_result "国内版启动失败"; return 1; }
    show_result "国内版已就绪 ✅" "面板入口：WorkBuddy 右下角机器人按钮。\n（应用本来就在跑，没有重启它）"
    return 0
  fi
  confirm_restart "国内版 WorkBuddy" || { show_result "已取消" "没有做任何改动。"; return 0; }
  run_action "正在重启国内版并启用面板" \
    env -u WBSWITCH_DATA_DIR -u WBSWITCH_CDP_PORT HOME="$REAL_HOME" WBSWITCH_PROFILE=workbuddy-cn \
    bash "$REL" --ensure || { fail_result "国内版启动失败"; return 1; }
  show_result "国内版已启动 ✅" "面板入口：WorkBuddy 右下角机器人按钮（几秒内出现）。"
}

activate_ai() {
  AI_STATUS="$(probe_ai)"
  if [ "$(field "$AI_STATUS" cdp_ready)" = "yes" ]; then
    run_action "正在确保国际版后台服务" bash "$AI_WRAPPER" relaunch --ensure \
      || { fail_result "国际版启动失败"; return 1; }
    show_result "国际版已就绪 ✅" "面板入口：WorkBuddy AI 右下角机器人按钮。\n（应用本来就在跑，没有重启它）"
    return 0
  fi
  confirm_restart "国际版 WorkBuddy AI" || { show_result "已取消" "没有做任何改动。"; return 0; }
  run_action "正在重启国际版并启用面板" bash "$AI_WRAPPER" relaunch --ensure \
    || { fail_result "国际版启动失败"; return 1; }
  show_result "国际版已启动 ✅" "面板入口：WorkBuddy AI 右下角机器人按钮（几秒内出现）。"
}

start_services_only() {
  run_action "正在启动国内版后台服务" \
    env -u WBSWITCH_DATA_DIR -u WBSWITCH_CDP_PORT HOME="$REAL_HOME" bash "$INSTALL" \
    || { fail_result "国内版后台服务启动失败"; return 1; }
  run_action "正在启动国际版后台服务" bash "$AI_WRAPPER" install \
    || { fail_result "国际版后台服务启动失败"; return 1; }
  show_result "后台服务已启动 ✅" "应用窗口没有被重启。\n面板会在应用下次带 CDP 启动后出现。"
}

open_status_page() {
  local port=""
  [ "$(field "$(probe_cn)" daemon)" = "up" ] && port="$CN_UI_PORT"
  [ -z "$port" ] && { [ "$(field "$(probe_ai)" daemon)" = "up" ] && port="$AI_UI_PORT"; }
  if [ -z "$port" ]; then
    show_result "暂无可用状态页" "两个后台服务都没有在运行。\n先选「只启动后台服务」。"
    return 0
  fi
  xdg-open "http://127.0.0.1:$port" >/dev/null 2>&1 &
  show_result "已打开状态页" "地址：http://127.0.0.1:$port"
}

# ---------------- 主菜单 ----------------
probe_all() {
  CN_STATUS="$(probe_cn)"
  AI_STATUS="$(probe_ai)"
}

main_menu() {
  probe_all
  local cn_line ai_line
  cn_line="$(describe "$CN_STATUS" "国内版")"
  ai_line="$(describe "$AI_STATUS" "国际版")"

  local choice
  choice="$("$ZENITY" --list --title="WorkDaddy 启动器" --width=680 --height=460 \
    --text="<b>选择要启动的渠道</b>\n\n${cn_line}\n${ai_line}\n\n启动会自动确保后台服务，并让 WorkBuddy 开启右下角面板。\n若应用正在运行但没开面板，需要重启它（会先征求你同意）。" \
    --column="id" --column="操作" --hide-column=1 --print-column=1 \
    "CN"   "启动 国内版 WorkBuddy（需要时自动重启并开启面板）" \
    "AI"   "启动 国际版 WorkBuddy AI（需要时自动重启并开启面板）" \
    "BOTH" "两个都启动" \
    "SVC"  "只启动后台服务（不重启应用窗口）" \
    "INFO" "打开面板状态页" \
    "QUIT" "取消")"

  case "$choice" in
    CN)   activate_cn ;;
    AI)   activate_ai ;;
    BOTH) activate_cn; activate_ai ;;
    SVC)  start_services_only ;;
    INFO) open_status_page ;;
    *)    exit 0 ;;
  esac
}

# 用法: bash scripts/launch-gui-linux.sh [cn|ai|both|services|info]
#   不带参数 = 弹出选择框；带参数 = 直接执行对应动作（供独立桌面快捷方式使用）
REQUEST="${1:-}"
case "$REQUEST" in
  ""|cn|ai|both|services|info) ;;
  -h|--help)
    echo "用法: bash scripts/launch-gui-linux.sh [cn|ai|both|services|info]"
    echo "  cn        启动国内版（需要时重启并开启面板）"
    echo "  ai        启动国际版 WorkBuddy AI（同上）"
    echo "  both      两个都启动"
    echo "  services  只启动后台服务（不重启应用窗口）"
    echo "  info      打开面板状态页"
    echo "  不带参数   弹出选择框（桌面图标默认用法）"
    exit 0 ;;
  *)
    echo "未知参数: $REQUEST（可用: cn|ai|both|services|info）" >&2
    exit 1 ;;
esac

if [ "$REQUEST" = "cn" ]; then activate_cn; exit $?; fi
if [ "$REQUEST" = "ai" ]; then activate_ai; exit $?; fi
if [ "$REQUEST" = "both" ]; then activate_cn; activate_ai; exit $?; fi
if [ "$REQUEST" = "services" ]; then start_services_only; exit $?; fi
if [ "$REQUEST" = "info" ]; then open_status_page; exit $?; fi

if [ -n "$ZENITY" ]; then
  main_menu
else
  # 没有 zenity：退化为终端文本菜单（在终端里跑时可用）
  probe_all
  echo "WorkDaddy 启动器（未检测到 zenity，使用文本菜单）"
  echo "  $(describe "$CN_STATUS" "国内版")"
  echo "  $(describe "$AI_STATUS" "国际版")"
  echo ""
  echo "  1) 启动 国内版（需要时重启并开启面板）"
  echo "  2) 启动 国际版（需要时重启并开启面板）"
  echo "  3) 两个都启动"
  echo "  4) 只启动后台服务（不重启应用窗口）"
  echo "  5) 打开面板状态页"
  echo "  6) 退出"
  read -r -p "请输入选项 [1]: " c
  case "${c:-1}" in
    1) activate_cn ;;
    2) activate_ai ;;
    3) activate_cn; activate_ai ;;
    4) start_services_only ;;
    5) open_status_page ;;
    *) exit 0 ;;
  esac
fi
