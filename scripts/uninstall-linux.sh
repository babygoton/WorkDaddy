#!/usr/bin/env bash
# WorkDaddy — Linux 卸载脚本
#
# 用法:
#   bash scripts/uninstall-linux.sh                       # 默认卸载 ~/.local/share/WorkDaddy-linux
#   bash scripts/uninstall-linux.sh --prefix /opt/WorkDaddy
#   bash scripts/uninstall-linux.sh --keep-data           # 保留账号备份与配置
set -uo pipefail

PREFIX="${XDG_DATA_HOME:-$HOME/.local/share}/WorkDaddy-linux"
KEEP_DATA=0

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="${2:-}"; shift 2 ;;
    --keep-data) KEEP_DATA=1; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

XDG_DATA_HOME_EFFECTIVE="${XDG_DATA_HOME:-$HOME/.local/share}"

echo "WorkDaddy (Linux) 卸载"
echo "  安装目录: $PREFIX"

# 1. 停掉 systemd 服务（若注册过）
if command -v systemctl >/dev/null 2>&1; then
  for unit in "$HOME"/.config/systemd/user/workdaddy-*.service; do
    [ -f "$unit" ] || continue
    name="$(basename "$unit")"
    echo "==> 停止并禁用 $name"
    systemctl --user stop "$name" 2>/dev/null || true
    systemctl --user disable "$name" 2>/dev/null || true
    rm -f "$unit"
  done
  systemctl --user daemon-reload 2>/dev/null || true
fi

# 2. 停掉仍在跑的 daemon 进程
pkill -f "scripts/daemon.js" 2>/dev/null || true
sleep 1

# 3. 删除安装目录
if [ -d "$PREFIX" ]; then
  rm -rf "$PREFIX"
  echo "==> 已删除 $PREFIX"
else
  echo "==> 安装目录不存在，跳过"
fi

# 4. 删除数据目录（账号备份、配置、日志）
if [ "$KEEP_DATA" = "1" ]; then
  echo "==> 按 --keep-data 保留 $XDG_DATA_HOME_EFFECTIVE/WorkDaddy"
else
  rm -rf "$XDG_DATA_HOME_EFFECTIVE/WorkDaddy"
  echo "==> 已删除 $XDG_DATA_HOME_EFFECTIVE/WorkDaddy（账号备份一并清除）"
fi

echo ""
echo "卸载完成。WorkBuddy 本身未被修改；若它仍在以 CDP 模式运行，"
echo "正常退出并重新打开即可回到默认状态。"
