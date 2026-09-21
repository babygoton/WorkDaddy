#!/usr/bin/env bash
# 为当前 profile 安装 systemd 用户服务（可选，用于开机自启 WorkDaddy 守护进程）
#
# 上游 macOS 版本故意不做登录自启（多 profile 会互相干扰），Linux 同理：
# 默认不装。确实需要常驻时用本脚本，它会按当前 node / 目录生成正确的 unit。
#
# 用法:
#   bash scripts/systemd-install-linux.sh            # 安装并立即启动
#   bash scripts/systemd-install-linux.sh --remove   # 卸载
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
  workbuddy-ai)   DEFAULT_DATA_DIR="$XDG_CONFIG_HOME/WorkDaddy/profiles/workbuddy-ai"; DEFAULT_UI_PORT=47833 ;;
  codebuddy-cn)   DEFAULT_DATA_DIR="$XDG_CONFIG_HOME/WorkDaddy/profiles/codebuddy-cn"; DEFAULT_UI_PORT=47834 ;;
  codebuddy-intl) DEFAULT_DATA_DIR="$XDG_CONFIG_HOME/WorkDaddy/profiles/codebuddy-intl"; DEFAULT_UI_PORT=47835 ;;
  *)              PROFILE="workbuddy-cn"; DEFAULT_DATA_DIR="$XDG_CONFIG_HOME/WorkDaddy"; DEFAULT_UI_PORT=47832 ;;
esac
DATA_DIR="${WBSWITCH_DATA_DIR:-$DEFAULT_DATA_DIR}"
UNIT="workdaddy-${PROFILE}.service"

# 真实家目录（隔离 HOME 场景下 $HOME 不是它）：以「存在海外版应用副本或 .workbuddy」为准
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
UNIT_DIR="$REAL_HOME/.config/systemd/user"
UNIT_PATH="$UNIT_DIR/$UNIT"

if ! command -v systemctl >/dev/null 2>&1; then
  echo "错误: 未找到 systemctl，本机可能不是 systemd 环境" >&2
  exit 1
fi

if [ "${1:-}" = "--remove" ]; then
  systemctl --user disable --now "$UNIT" 2>/dev/null || true
  rm -f "$UNIT_PATH"
  systemctl --user daemon-reload 2>/dev/null || true
  echo "==> 已卸载 $UNIT"
  exit 0
fi

NODE=""
for c in \
  "$DIR/scripts/runtime/node/node" \
  "$HOME/.workbuddy/binaries/node/versions/22.22.2/bin/node" \
  "$HOME/.workbuddy/binaries/node/current/bin/node" \
  "$(command -v node 2>/dev/null || true)"; do
  [ -n "$c" ] && [ -x "$c" ] && { NODE="$c"; break; }
done
[ -z "$NODE" ] && { echo "错误: 未找到 node" >&2; exit 1; }

# 启动器与真实家目录：守护进程重启应用时用得到。
# 缺了它们，切换账号后的重启会直连应用二进制，丢掉 --user-data-dir 等配置。
LAUNCHER="${WBSWITCH_WORKBUDDY_LAUNCHER:-}"
if [ -z "$LAUNCHER" ]; then
  case "$PROFILE" in
    workbuddy-ai)   for d in "$REAL_HOME/.local/bin" "$HOME/.local/bin"; do [ -x "$d/workbuddy-ai" ] && { LAUNCHER="$d/workbuddy-ai"; break; }; done ;;
    workbuddy-cn)   for d in "$REAL_HOME/.local/bin" "$HOME/.local/bin"; do [ -x "$d/workbuddy-noproxy" ] && { LAUNCHER="$d/workbuddy-noproxy"; break; }; done ;;
  esac
fi

mkdir -p "$UNIT_DIR" "$DATA_DIR"
{
  cat <<EOF
[Unit]
Description=WorkDaddy daemon (${PROFILE})
Documentation=https://github.com/babygoton/WorkDaddy
# 图形会话起来后再启动：守护进程需要 WorkBuddy 的 CDP 端口存在
After=graphical-session.target
PartOf=graphical-session.target

[Service]
Type=simple
# 关键环境：profile / 数据目录 / UI 端口，必须与 install-linux.sh 保持一致
Environment=WBSWITCH_PROFILE=${PROFILE}
Environment=WBSWITCH_DATA_DIR=${DATA_DIR}
Environment=WBSWITCH_PORT=${DEFAULT_UI_PORT}
Environment=HOME=${HOME}
Environment=XDG_CONFIG_HOME=${XDG_CONFIG_HOME}
# 系统代理会把 127.0.0.1 的 CDP 请求也劫持，显式把回环排除
Environment=NO_PROXY=localhost,127.0.0.1,::1
Environment=no_proxy=localhost,127.0.0.1,::1
EOF
  [ -n "${REAL_HOME:-}" ] && echo "Environment=WBSWITCH_LAUNCH_HOME=${REAL_HOME}"
  [ -n "$LAUNCHER" ] && echo "Environment=WBSWITCH_WORKBUDDY_LAUNCHER=${LAUNCHER}"
  cat <<EOF
ExecStart=${NODE} ${DIR}/scripts/daemon.js
Restart=on-failure
RestartSec=5
WorkingDirectory=${DIR}

[Install]
WantedBy=default.target
EOF
} > "$UNIT_PATH"

systemctl --user daemon-reload
systemctl --user enable --now "$UNIT"
sleep 1
if systemctl --user is-active --quiet "$UNIT"; then
  echo "==> 已安装并启动: $UNIT"
  echo "   管理界面 : http://127.0.0.1:${DEFAULT_UI_PORT}"
  echo "   查看状态 : systemctl --user status $UNIT"
  echo "   查看日志 : journalctl --user -u $UNIT -f"
else
  echo "⚠️  服务已写入但未处于 active 状态: $UNIT"
  echo "   排查: systemctl --user status $UNIT"
fi
echo "   提示: 需要 sudo loginctl enable-linger $USER 才能在未登录时也保持运行"
