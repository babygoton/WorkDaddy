#!/usr/bin/env bash
# WorkDaddy — Linux 安装脚本（用户级安装，无需 root）
#
# 用法:
#   bash scripts/install-linux.sh                 # 安装到 ~/.local/share/WorkDaddy-linux
#   bash scripts/install-linux.sh --profile workbuddy-ai
#   bash scripts/install-linux.sh --systemd       # 同时注册 systemd --user 开机自启
#   bash scripts/install-linux.sh --prefix /opt/WorkDaddy   # 指定安装目录（可能需要 sudo）
#
# 说明：
#   * 只复制运行所需文件，不改 WorkBuddy 任何文件（与 macOS 版一致的「零侵入」原则）。
#   * 默认不注册开机自启（与 macOS 版行为一致）；需要时用 --systemd。
set -uo pipefail

PROFILE="workbuddy-cn"
PREFIX="${XDG_DATA_HOME:-$HOME/.local/share}/WorkDaddy-linux"
USE_SYSTEMD=0

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="${2:-workbuddy-cn}"; shift 2 ;;
    --prefix) PREFIX="${2:-}"; shift 2 ;;
    --systemd) USE_SYSTEMD=1; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

DIR="$(cd "$(dirname "$0")/.." && pwd)"
XDG_DATA_HOME_EFFECTIVE="${XDG_DATA_HOME:-$HOME/.local/share}"

echo "WorkDaddy (Linux) 安装"
echo "  profile : $PROFILE"
echo "  安装目录: $PREFIX"

# ---------- 0. 环境检查 ----------
NODE_BIN="$(command -v node || true)"
# 回退：WorkBuddy 托管的 node。不要写死版本号——客户端升级后旧版本目录会被清掉，
# 这里按版本号排序取最新可用的一个。
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(ls -1 "$HOME"/.workbuddy/binaries/node/versions/*/bin/node 2>/dev/null | sort -V | tail -1)"
fi
if [ -z "$NODE_BIN" ]; then
  echo "错误：未找到 node。请先安装 Node.js >= 18（README 要求 >= 18）。"
  exit 1
fi
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "错误：node 版本过低（$("$NODE_BIN" -v)），需要 >= 18。"
  exit 1
fi
echo "  node    : $("$NODE_BIN" -v) ($NODE_BIN)"

if [ "$(uname -s)" != "Linux" ]; then
  echo "错误：install-linux.sh 仅用于 Linux；macOS 请用 scripts/install.sh，Windows 请用 Install-WorkDaddy.cmd。"
  exit 1
fi

# ---------- 1. 铺文件 ----------
mkdir -p "$PREFIX/scripts" "$PREFIX/scripts/builtin-overrides" || {
  echo "错误：无法创建安装目录 $PREFIX（权限不足？可换 --prefix 到用户目录）"; exit 1;
}
cp -f "$DIR"/scripts/*.js "$PREFIX/scripts/" 2>/dev/null || true
cp -f "$DIR"/scripts/*.sh "$PREFIX/scripts/" 2>/dev/null || true
# builtin/ 是必需资源：内置自动化任务（关弹窗/账号保活/自动签到）、主题与壁纸都在这里。
# 只复制 *.js/*.sh 会把整个子目录漏掉，导致上述功能静默失效。
[ -d "$DIR/scripts/builtin" ] && { mkdir -p "$PREFIX/scripts/builtin"; cp -rf "$DIR/scripts/builtin/." "$PREFIX/scripts/builtin/"; }
[ -d "$DIR/scripts/assets" ] && { mkdir -p "$PREFIX/scripts/assets"; cp -rf "$DIR/scripts/assets/." "$PREFIX/scripts/assets/"; }
[ -d "$DIR/scripts/builtin-overrides" ] && cp -rf "$DIR/scripts/builtin-overrides/." "$PREFIX/scripts/builtin-overrides/" 2>/dev/null || true
cp -f "$DIR/README.md" "$PREFIX/README.md" 2>/dev/null || true
cp -f "$DIR/README-Linux.md" "$PREFIX/README-Linux.md" 2>/dev/null || true
cp -f "$DIR/LICENSE" "$PREFIX/LICENSE" 2>/dev/null || true
chmod +x "$PREFIX"/scripts/*.sh 2>/dev/null || true

# 自检：内置任务缺失时直接报错，不要等到运行时才发现功能没了
AUTOMATION_COUNT="$(find "$PREFIX/scripts/builtin/automations" -type f -name '*.json' 2>/dev/null | wc -l | tr -d '[:space:]')"
if [ "${AUTOMATION_COUNT:-0}" -lt 1 ]; then
  echo "错误：未安装内置自动化任务（scripts/builtin/automations 为空）。" >&2
  echo "      发布包不完整，请重新下载；免打扰/自动签到等依赖内置任务的功能将不可用。" >&2
  exit 1
fi
echo "==> 文件已铺到 $PREFIX（内置任务 ${AUTOMATION_COUNT} 个）"

# ---------- 2. 数据目录 ----------
case "$PROFILE" in
  workbuddy-ai) DATA_DIR="$XDG_DATA_HOME_EFFECTIVE/WorkDaddy/profiles/workbuddy-ai"; UI_PORT=47833 ;;
  *) DATA_DIR="$XDG_DATA_HOME_EFFECTIVE/WorkDaddy"; UI_PORT=47832 ;;
esac
mkdir -p "$DATA_DIR/accounts"
echo "==> 数据目录 $DATA_DIR"

# ---------- 3. systemd --user 自启（可选） ----------
if [ "$USE_SYSTEMD" = "1" ]; then
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "警告：未找到 systemctl，跳过自启注册"
  else
    UNIT_DIR="$HOME/.config/systemd/user"
    mkdir -p "$UNIT_DIR"
    cat > "$UNIT_DIR/workdaddy-${PROFILE}.service" <<EOF
[Unit]
Description=WorkDaddy daemon (${PROFILE})
After=graphical-session.target

[Service]
Type=simple
Environment=WBSWITCH_PROFILE=${PROFILE}
Environment=WBSWITCH_DATA_DIR=${DATA_DIR}
Environment=WBSWITCH_PORT=${UI_PORT}
ExecStart=${NODE_BIN} ${PREFIX}/scripts/daemon.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable "workdaddy-${PROFILE}.service"
    systemctl --user restart "workdaddy-${PROFILE}.service" || true
    echo "==> 已注册并启动 systemd --user 服务: workdaddy-${PROFILE}.service"
  fi
fi

cat <<EOF

安装完成。

下一步（在图形会话中执行）：
  bash "$PREFIX/scripts/relaunch-with-cdp-linux.sh"

它会：退出 WorkBuddy → 以 --remote-debugging-port 重启 → 启动守护进程 → 验证 CDP。
之后 WorkBuddy 右下角会出现 WorkDaddy 机器人按钮。

手动控制守护进程（不注册自启时）：
  WBSWITCH_PROFILE=$PROFILE nohup "$NODE_BIN" "$PREFIX/scripts/daemon.js" >> "$DATA_DIR/daemon.log" 2>&1 &
  管理界面: http://127.0.0.1:${UI_PORT}

卸载：
  bash "$PREFIX/scripts/uninstall-linux.sh"
EOF
