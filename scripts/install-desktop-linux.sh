#!/usr/bin/env bash
# 安装/更新 WorkDaddy 桌面图标与菜单项（Linux）
#
# 默认只装 1 个入口（最干净）：
#   桌面 + 应用菜单：WorkDaddy 启动器 —— 双击弹选择框，自己选渠道
#
# 用法:
#   bash scripts/install-desktop-linux.sh                   # 只装选择器
#   bash scripts/install-desktop-linux.sh --with-shortcuts   # 额外加 3 个直达菜单项
#   bash scripts/install-desktop-linux.sh --remove           # 移除全部入口
set -uo pipefail

# HOME 兜底
if [ -z "${HOME:-}" ]; then
  HOME="$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6)"
  [ -n "$HOME" ] || HOME="$PWD"
  export HOME
fi

DIR="$(cd "$(dirname "$0")/.." && pwd)"
LAUNCHER="$DIR/scripts/launch-gui-linux.sh"
APP_DIR="$HOME/.local/share/applications"
DESKTOP_CANDIDATES=("$(xdg-user-dir DESKTOP 2>/dev/null || true)" "$HOME/桌面" "$HOME/Desktop")
ICON_PNG="$HOME/.local/share/workdaddy/icons/workdaddy-launcher.png"

[ -f "$LAUNCHER" ] || { echo "错误: 未找到启动器脚本 $LAUNCHER" >&2; exit 1; }
chmod +x "$LAUNCHER" 2>/dev/null || true

desktop_dir() {
  local d
  for d in "${DESKTOP_CANDIDATES[@]}"; do
    [ -n "$d" ] && [ -d "$d" ] && { printf '%s' "$d"; return 0; }
  done
  return 1
}

entry_body() {  # $1=Name  $2=Comment  $3=Exec 参数  $4=Icon  $5=Keywords
  local extra="${3:-}"
  cat <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=$1
Comment=$2
Exec=bash $LAUNCHER${extra:+ $extra}
Icon=$4
Terminal=false
StartupNotify=true
Categories=Utility;
Keywords=$5
EOF
}

remove_all() {
  local f
  for f in workdaddy-launcher workdaddy-cn workdaddy-ai workdaddy-services; do
    rm -f "$APP_DIR/$f.desktop"
  done
  local d
  d="$(desktop_dir || true)"
  [ -n "$d" ] && rm -f "$d/WorkDaddy 启动器.desktop" "$d/workdaddy-launcher.desktop"
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APP_DIR" 2>/dev/null || true
  echo "==> 已移除 WorkDaddy 桌面入口"
}

SHORTCUTS=0
for arg in "$@"; do
  case "$arg" in
    --remove|-r) remove_all; exit 0 ;;
    --with-shortcuts) SHORTCUTS=1 ;;
    -h|--help)
      echo "用法: bash scripts/install-desktop-linux.sh [--with-shortcuts | --remove]"
      echo "  默认            只装 1 个「WorkDaddy 启动器」（桌面 + 应用菜单）"
      echo "  --with-shortcuts 额外装 3 个直达菜单项（国内版 / 国际版 / 仅后台服务）"
      echo "  --remove         移除全部入口"
      exit 0 ;;
  esac
done

mkdir -p "$APP_DIR"

# 图标：优先用自带 PNG；缺失时退回系统已有的 workbuddy 图标名
ICON_VALUE="$ICON_PNG"
[ -f "$ICON_PNG" ] || ICON_VALUE="workbuddy"

entry_body "WorkDaddy 启动器" "选择渠道启动 WorkBuddy（国内版 / 国际版）" "" "$ICON_VALUE" "workdaddy;workbuddy;启动器;切换器;" > "$APP_DIR/workdaddy-launcher.desktop"

if [ "$SHORTCUTS" = "1" ]; then
  entry_body "WorkDaddy · 国内版" "启动 WorkBuddy 并开启 WorkDaddy 面板" "cn" "$ICON_VALUE" "workdaddy;workbuddy;国内版;" > "$APP_DIR/workdaddy-cn.desktop"
  entry_body "WorkDaddy · 国际版" "启动 WorkBuddy AI 并开启 WorkDaddy 面板" "ai" "$ICON_VALUE" "workdaddy;workbuddy;国际版;海外版;" > "$APP_DIR/workdaddy-ai.desktop"
  entry_body "WorkDaddy · 仅后台服务" "只启动后台服务，不重启应用窗口" "services" "$ICON_VALUE" "workdaddy;后台服务;" > "$APP_DIR/workdaddy-services.desktop"
else
  # 默认模式：清掉此前可能装过的直达入口，避免菜单里留残留
  rm -f "$APP_DIR/workdaddy-cn.desktop" "$APP_DIR/workdaddy-ai.desktop" "$APP_DIR/workdaddy-services.desktop"
fi

chmod +x "$APP_DIR"/workdaddy-*.desktop 2>/dev/null || true

# 桌面图标（GNOME 需要「可执行 + 标记为受信任」才能双击启动）
DESK="$(desktop_dir || true)"
if [ -n "$DESK" ]; then
  cp "$APP_DIR/workdaddy-launcher.desktop" "$DESK/WorkDaddy 启动器.desktop"
  chmod +x "$DESK/WorkDaddy 启动器.desktop"
  # 标记受信任：失败也不致命，用户右键「允许启动」一次即可
  if command -v gio >/dev/null 2>&1; then
    gio set "$DESK/WorkDaddy 启动器.desktop" metadata::trusted true 2>/dev/null || true
  fi
  echo "==> 桌面图标: $DESK/WorkDaddy 启动器.desktop"
else
  echo "⚠️  未找到桌面目录，仅安装到应用菜单"
fi

command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APP_DIR" 2>/dev/null || true

echo "==> 应用菜单:"
echo "    $APP_DIR/workdaddy-launcher.desktop"
if [ "$SHORTCUTS" = "1" ]; then
  for f in workdaddy-cn workdaddy-ai workdaddy-services; do
    echo "    $APP_DIR/$f.desktop"
  done
fi
echo ""
echo "图标: $ICON_VALUE"
if [ -n "$DESK" ]; then
  echo "桌面图标已标记为受信任，直接双击即可（无需右键授权）。"
  echo "若双击无反应，在终端跑一次看输出: bash \"$LAUNCHER\""
fi
