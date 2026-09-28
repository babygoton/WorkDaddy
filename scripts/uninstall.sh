#!/usr/bin/env bash
# 卸载 WorkBuddy 多账号切换器（保留备份数据）
# 用法: bash scripts/uninstall.sh
set -euo pipefail

PROFILE="${WBSWITCH_PROFILE:-workbuddy-cn}"
case "$PROFILE" in
  workbuddy-cn|workbuddy-ai|codebuddy-cn|codebuddy-intl) ;;
  *) echo "未知客户端配置: $PROFILE"; exit 1 ;;
esac
LABEL="com.workbuddy.workdaddy"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LEGACY_LABEL="com.workbuddy.hellobuddy"
LEGACY_PLIST="$HOME/Library/LaunchAgents/${LEGACY_LABEL}.plist"
DEFAULT_DATA_DIR="$HOME/Library/Application Support/WorkDaddy"
if [ "$PROFILE" != workbuddy-cn ]; then DEFAULT_DATA_DIR="$DEFAULT_DATA_DIR/profiles/$PROFILE"; fi
LEGACY_DATA_DIR="$HOME/Library/Application Support/HelloBuddy"
if [ "${WBSWITCH_DATA_DIR:-}" = "$LEGACY_DATA_DIR" ]; then
  DATA_DIR="$DEFAULT_DATA_DIR"
else
  DATA_DIR="${WBSWITCH_DATA_DIR:-$DEFAULT_DATA_DIR}"
fi

echo "==> 停止并移除 launchd 守护进程"
for old_profile in "$PROFILE"; do
  old_label="com.workbuddy.workdaddy.${old_profile}"
  old_plist="$HOME/Library/LaunchAgents/${old_label}.plist"
  launchctl bootout "gui/$(id -u)" "$old_plist" 2>/dev/null || true
  launchctl remove "$old_label" 2>/dev/null || true
  rm -f "$old_plist"
done
if [ "$PROFILE" = workbuddy-cn ]; then
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
launchctl bootout "gui/$(id -u)" "$LEGACY_PLIST" 2>/dev/null || true
launchctl remove "$LEGACY_LABEL" 2>/dev/null || true
rm -f "$LEGACY_PLIST"
fi

echo "==> 完成"
echo "   备份数据保留在: $DATA_DIR"
echo "   旧版 HelloBuddy 备份目录未删除，如需手动核对请查看: $HOME/Library/Application Support/HelloBuddy"
echo "   如需彻底删除备份，请手动执行: rm -rf \"$DATA_DIR\""
