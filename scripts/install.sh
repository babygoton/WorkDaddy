#!/usr/bin/env bash
# 安装 WorkBuddy 多账号切换器（CDP 版）
# 1) 创建备份目录并首次同步当前账号
# 2) 清理旧 launchd 注册并手动启动守护进程（不再登录自启）
# 用法: bash scripts/install.sh
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="${WBSWITCH_PROFILE:-workbuddy-cn}"
case "$PROFILE" in
  workbuddy-ai) DEFAULT_DATA_DIR="$HOME/Library/Application Support/WorkDaddy/profiles/workbuddy-ai"; DEFAULT_UI_PORT=47833 ;;
  codebuddy-cn) DEFAULT_DATA_DIR="$HOME/Library/Application Support/WorkDaddy/profiles/codebuddy-cn"; DEFAULT_UI_PORT=47834 ;;
  codebuddy-intl) DEFAULT_DATA_DIR="$HOME/Library/Application Support/WorkDaddy/profiles/codebuddy-intl"; DEFAULT_UI_PORT=47835 ;;
  *) PROFILE="workbuddy-cn"; DEFAULT_DATA_DIR="$HOME/Library/Application Support/WorkDaddy"; DEFAULT_UI_PORT=47832 ;;
esac
export WBSWITCH_PROFILE="$PROFILE"
LABEL="com.workbuddy.workdaddy.${PROFILE}"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LEGACY_LABEL="com.workbuddy.hellobuddy"
LEGACY_PLIST="$HOME/Library/LaunchAgents/${LEGACY_LABEL}.plist"
LEGACY_DATA_DIR="$HOME/Library/Application Support/HelloBuddy"
if [ "${WBSWITCH_DATA_DIR:-}" = "$LEGACY_DATA_DIR" ]; then
  DATA_DIR="$DEFAULT_DATA_DIR"
else
  DATA_DIR="${WBSWITCH_DATA_DIR:-$DEFAULT_DATA_DIR}"
fi
UI_PORT="${WBSWITCH_PORT:-$DEFAULT_UI_PORT}"
CDP_PORT="${WBSWITCH_CDP_PORT:-}"

# 找一个可用的 node（优先 managed，其次 PATH）
NODE=""
for c in \
  "/Users/h/.workbuddy/binaries/node/versions/22.22.2/bin/node" \
  "/Users/h/.nvm/versions/node/v20.20.2/bin/node" \
  "$(command -v node 2>/dev/null || true)"; do
  if [ -n "$c" ] && [ -x "$c" ]; then NODE="$c"; break; fi
done
if [ -z "$NODE" ]; then
  echo "错误: 未找到 node，请先安装 Node.js"; exit 1
fi

REPORTER="$DIR/scripts/sentry-report.js"
report_install_failure() {
  local code="$1"
  if [ -f "$REPORTER" ]; then
    "$NODE" "$REPORTER" \
      --stage macos-install \
      --message "install.sh 失败 (exit=${code})" \
      --extra-json "{\"exitCode\":${code}}" >/dev/null 2>&1 || true
  fi
}
on_install_exit() {
  local code="$?"
  if [ "$code" -ne 0 ]; then report_install_failure "$code"; fi
  return "$code"
}
trap on_install_exit EXIT

echo "==> 创建备份目录: $DATA_DIR"
mkdir -p "$DATA_DIR/accounts"
chmod 700 "$DATA_DIR"

echo "==> 停止旧版 HelloBuddy 守护进程（保留旧备份，首次同步时自动迁移）"
launchctl bootout "gui/$(id -u)" "$LEGACY_PLIST" 2>/dev/null || true
launchctl remove "$LEGACY_LABEL" 2>/dev/null || true
rm -f "$LEGACY_PLIST"
# 仅停止当前 profile 的旧 daemon，避免安装 WorkDaddy AI 时误杀另一个端。
if [ -f "$DATA_DIR/.daemon.lock" ]; then
  OLD_PID=$("$NODE" -e "try { const fs=require('fs'); const j=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); process.stdout.write(String(j.pid || '')); } catch (_) {}" "$DATA_DIR/.daemon.lock")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    kill "$OLD_PID" 2>/dev/null || true
    for _ in $(seq 1 10); do
      kill -0 "$OLD_PID" 2>/dev/null || break
      sleep 0.2
    done
  fi
fi

# 迁移旧版「未绑定 profile」守护进程（com.workbuddy.workdaddy，未设置 WBSWITCH_PROFILE）。
# 旧版 daemon 会扫描 9222-9232 全部 CDP 端口，仅凭标题 "WorkBuddy" 判定注入目标，
# 会误连兄弟客户端（如 WorkBuddy AI）页面并反复清理对方组件，导致按钮消失。
# 新安装统一使用带 profile 后缀的 label（com.workbuddy.workdaddy.<profile>），
# 此处卸载并移除旧 plist，仅当安装的是它代表的 workbuddy-cn 时才做（其他 profile 由各自安装清理）。
if [ "$PROFILE" = "workbuddy-cn" ] && [ -f "$HOME/Library/LaunchAgents/com.workbuddy.workdaddy.plist" ]; then
  echo "==> 迁移旧版未绑定 profile 守护进程 com.workbuddy.workdaddy（新版本已按客户端拆分绑定）"
  launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.workbuddy.workdaddy.plist" 2>/dev/null || true
  launchctl remove "com.workbuddy.workdaddy" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/com.workbuddy.workdaddy.plist"
fi

echo "==> 首次同步当前登录账号"
if ! "$NODE" "$DIR/scripts/sync.js"; then
  "$NODE" "$REPORTER" --stage macos-sync --message "首次同步当前账号失败" >/dev/null 2>&1 || true
  echo "   (首次同步失败，守护进程启动后会自动重试)"
fi

echo "==> 清理旧 launchd 注册（WorkDaddy / WorkDaddy AI 不再登录自启）"
for old_profile in "$PROFILE"; do
  old_label="com.workbuddy.workdaddy.${old_profile}"
  old_plist="$HOME/Library/LaunchAgents/${old_label}.plist"
  launchctl bootout "gui/$(id -u)" "$old_plist" 2>/dev/null || true
  launchctl remove "$old_label" 2>/dev/null || true
  rm -f "$old_plist"
done
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl remove "$LABEL" 2>/dev/null || true
rm -f "$PLIST"

echo "==> 启动守护进程（后台）"
WBSWITCH_PROFILE="$PROFILE" WBSWITCH_DATA_DIR="$DATA_DIR" WBSWITCH_PORT="$UI_PORT" nohup "$NODE" "$DIR/scripts/daemon.js" >> "$DATA_DIR/daemon.log" 2>&1 &
disown 2>/dev/null || true
echo "   pid: $!"

echo "==> 等待守护进程就绪"
UI_UP=0
for i in $(seq 1 10); do
  if curl -s -m 1 "http://127.0.0.1:${UI_PORT}/api/status" >/dev/null 2>&1; then UI_UP=1; break; fi
  sleep 1
done

echo ""
echo "=============================================="
echo "✅ 安装完成！"
echo "   Web 界面 : http://127.0.0.1:${UI_PORT}"
echo "   备份目录 : ${DATA_DIR}"
echo "   CDP 端口 : ${CDP_PORT:-自动选择 (9222-9232/9333，端口占用会自动切换)}"
echo "   开机自启 : 已禁用（需要时手动启动对应 WorkDaddy 端）"
echo ""
echo "下一步：让 CDP 生效（可选但推荐）"
echo "   bash \"$DIR/scripts/relaunch-with-cdp.sh\""
echo "   将以自动选择的 --remote-debugging-port 重启 WorkBuddy，"
echo "   之后登录/切换账号会实时自动备份，切换后可直接刷新窗口。"
echo "=============================================="

# 尝试打开管理界面
open "http://127.0.0.1:${UI_PORT}" 2>/dev/null || true
exit 0
