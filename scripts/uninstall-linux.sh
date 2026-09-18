#!/usr/bin/env bash
# WorkDaddy Linux 卸载脚本（默认保留备份数据）
#
# 用法:
#   bash scripts/uninstall-linux.sh          # 仅停止守护进程，保留备份
#   bash scripts/uninstall-linux.sh --purge  # 停止并删除备份目录（不可恢复）
set -uo pipefail

# HOME 兜底：部分沙箱/服务化环境不导出 HOME，配合 set -u 会直接报 unbound variable
if [ -z "${HOME:-}" ]; then
  HOME="$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6)"
  [ -n "$HOME" ] || HOME="$PWD"
  export HOME
fi

DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="${WBSWITCH_PROFILE:-workbuddy-cn}"
XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"

case "$PROFILE" in
  workbuddy-ai)   DEFAULT_DATA_DIR="$XDG_CONFIG_HOME/WorkDaddy/profiles/workbuddy-ai" ;;
  codebuddy-cn)   DEFAULT_DATA_DIR="$XDG_CONFIG_HOME/WorkDaddy/profiles/codebuddy-cn" ;;
  codebuddy-intl) DEFAULT_DATA_DIR="$XDG_CONFIG_HOME/WorkDaddy/profiles/codebuddy-intl" ;;
  *)              DEFAULT_DATA_DIR="$XDG_CONFIG_HOME/WorkDaddy" ;;
esac
DATA_DIR="${WBSWITCH_DATA_DIR:-$DEFAULT_DATA_DIR}"

NODE=""
for c in "$(command -v node 2>/dev/null || true)" "$HOME/.workbuddy/binaries/node/current/bin/node"; do
  [ -n "$c" ] && [ -x "$c" ] && { NODE="$c"; break; }
done

echo "==> 停止守护进程"
if [ -f "$DATA_DIR/.daemon.lock" ]; then
  pid=""
  if [ -n "$NODE" ]; then
    pid="$("$NODE" -e "try{const j=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.stdout.write(String(j.pid||''))}catch(_){}" "$DATA_DIR/.daemon.lock")"
  else
    pid="$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$DATA_DIR/.daemon.lock" | head -1)"
  fi
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 15); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
    echo "   已停止 pid=$pid"
  else
    echo "   守护进程未运行"
  fi
else
  echo "   未找到锁文件: $DATA_DIR/.daemon.lock"
fi

# 可选：清理 systemd user 服务
if command -v systemctl >/dev/null 2>&1; then
  unit="workdaddy-${PROFILE}.service"
  if systemctl --user list-unit-files 2>/dev/null | grep -q "$unit"; then
    echo "==> 禁用 systemd 用户服务 $unit"
    systemctl --user disable --now "$unit" 2>/dev/null || true
    rm -f "$HOME/.config/systemd/user/$unit"
    systemctl --user daemon-reload 2>/dev/null || true
  fi
fi

PURGE=0
for arg in "$@"; do [ "$arg" = "--purge" ] && PURGE=1; done

if [ "$PURGE" = "1" ]; then
  echo ""
  echo "⚠️  即将删除备份目录（含全部账号备份）: $DATA_DIR"
  read -r -p "确认删除？(y/N) " ans
  case "$ans" in
    y|Y|yes|YES)
      # 用 gio trash 优于 rm：误删可从回收站恢复
      if command -v gio >/dev/null 2>&1; then
        gio trash "$DATA_DIR" && echo "   已移入回收站: $DATA_DIR"
      else
        rm -rf "$DATA_DIR" && echo "   已删除: $DATA_DIR"
      fi
      ;;
    *) echo "   已取消删除" ;;
  esac
else
  echo ""
  echo "==> 完成（备份数据保留）"
  echo "   备份目录: $DATA_DIR"
  echo "   如需彻底删除: bash scripts/uninstall-linux.sh --purge"
fi
