#!/usr/bin/env bash
# 一键修复/启用 CDP 模式：
#   1) 把守护进程注册到 launchd（独立于 WorkBuddy 存活，重启应用/重启电脑都不影响）
#   2) 彻底退出 WorkBuddy（注意：其进程名是 Electron，不能按 "WorkBuddy" 杀）
#   3) 带 --remote-debugging-port 直接执行应用二进制启动（保证参数生效）
#   4) 验证 CDP 端口开放
#
# 交互式菜单：
#   1) 启动/重启 WorkBuddy 并启用 CDP（默认）
#   2) 恢复登录：从本地备份选择一个账号写入登录文件，再启动 WorkBuddy
#   3) 退出
#
# 用法: bash scripts/relaunch-with-cdp.sh [CDP端口，默认 9222]
set -uo pipefail

PORT="${WBSWITCH_CDP_PORT:-${1:-9222}}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.workbuddy.workdaddy"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LEGACY_LABEL="com.workbuddy.hellobuddy"
LEGACY_PLIST="$HOME/Library/LaunchAgents/${LEGACY_LABEL}.plist"
DEFAULT_DATA_DIR="$HOME/Library/Application Support/WorkDaddy"
LEGACY_DATA_DIR="$HOME/Library/Application Support/HelloBuddy"
if [ "${WBSWITCH_DATA_DIR:-}" = "$LEGACY_DATA_DIR" ]; then
  DATA_DIR="$DEFAULT_DATA_DIR"
else
  DATA_DIR="${WBSWITCH_DATA_DIR:-$DEFAULT_DATA_DIR}"
fi
AUTH_FILE="${WBSWITCH_AUTH_FILE:-$HOME/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info}"
APP_BIN="/Applications/WorkBuddy.app/Contents/MacOS/Electron"

# 统一使用的 node 路径（WorkBuddyAI/WorkBuddy managed runtime 优先）。
NODE_BIN=""
for base in "$HOME/.workbuddy-ai/binaries/node/versions" "$HOME/.workbuddy/binaries/node/versions"; do
  for c in "$base"/*/bin/node; do
    if [ -x "$c" ]; then NODE_BIN="$c"; break 2; fi
  done
done
if [ -z "$NODE_BIN" ]; then NODE_BIN="$(command -v node 2>/dev/null || true)"; fi
if [ -z "$NODE_BIN" ]; then echo "错误: 未找到 node"; exit 1; fi

# 清理旧版常驻服务，但保留 HelloBuddy 数据目录；新 daemon 会在启动时迁移旧账号。
launchctl bootout "gui/$(id -u)" "$LEGACY_PLIST" 2>/dev/null || true
launchctl remove "$LEGACY_LABEL" 2>/dev/null || true
rm -f "$LEGACY_PLIST"
"$NODE_BIN" -e "const lib = require(process.argv[1]); const r = lib.migrateLegacyDataDir(process.argv[2]); if (r.migrated) console.log('已迁移 ' + r.migrated + ' 个旧版账号备份');" "$DIR/scripts/lib.js" "$DATA_DIR" 2>/dev/null || true

# ---------- 功能函数（必须先于调用定义） ----------

restore_login() {
  local accounts_dir="$DATA_DIR/accounts"
  echo ""
  echo "==> 扫描本地账号备份 ..."
  if [ ! -d "$accounts_dir" ]; then
    echo "   未找到备份目录: $accounts_dir"
    exit 1
  fi

  local map
  map=$("$NODE_BIN" -e "
    const fs = require('fs'), path = require('path');
    const dir = process.argv[1];
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.info') && !f.endsWith('.tmp'));
    if (!files.length) { console.error('NO_ACCOUNTS'); process.exit(1); }
    files.forEach((f, i) => {
      const uid = f.replace(/\\.info$/, '');
      let nickname = '', phone = '';
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const acct = j.account || (Array.isArray(j.accounts) && j.accounts[0]);
        if (acct) { nickname = acct.nickname || ''; phone = acct.phoneNumber || ''; }
      } catch (_) {}
      console.log(\`\${i + 1}|\${uid}|\${nickname}|\${phone}\`);
    });
  " "$accounts_dir")

  if [ -z "$map" ]; then
    echo "   没有可用的账号备份"
    exit 1
  fi

  echo ""
  echo "可选账号："
  echo "$map" | while IFS='|' read -r idx uid nickname phone; do
    printf '  %s) %-12s  %-13s  UID:%s\n' "$idx" "${nickname:-(未命名)}" "${phone:-(-)}" "$uid"
  done
  echo ""

  read -r -p "选择要恢复的账号编号: " n
  local line
  line=$(echo "$map" | grep "^${n}|" || true)
  if [ -z "$line" ]; then
    echo "   无效编号"
    exit 1
  fi

  local uid
  uid=$(echo "$line" | cut -d'|' -f2)
  local src="$accounts_dir/${uid}.info"
  if [ ! -f "$src" ]; then
    echo "   备份文件不存在: $src"
    exit 1
  fi

  cp "$src" "$AUTH_FILE"
  chmod 600 "$AUTH_FILE"
  echo "   已恢复账号 $uid 到登录文件"

  launch_plugin
}

launch_plugin() {
  echo ""
  echo "警告：即将退出 WorkBuddy 并以 CDP 模式重启（请先保存工作内容，包括当前对话）。"
  read -r -p "确认继续？(y/N) " ans
  case "$ans" in
    y|Y|yes|YES) ;;
    *) echo "已取消"; exit 0 ;;
  esac

  # ---------- 1. 注册 launchd 守护进程（若尚未注册） ----------
  if [ -f "$PLIST" ] && ! launchctl print "gui/$(id -u)/${LABEL}" >/dev/null 2>&1; then
    echo "==> 注册 launchd 守护进程（使后台服务独立于 WorkBuddy 存活）"
    # 先停掉可能存在的临时守护进程，避免双实例抢端口
    pkill -f "scripts/daemon.js" 2>/dev/null || true
    sleep 1
    if launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then
      echo "   launchd 注册成功"
    else
      echo "   警告：launchd 注册失败，改用 nohup 方式启动守护进程（重启电脑后需重新执行本脚本）"
      mkdir -p "$DATA_DIR/accounts"
      WBSWITCH_DATA_DIR="$DATA_DIR" nohup "$NODE_BIN" "$DIR/scripts/daemon.js" >> "$DATA_DIR/daemon.log" 2>&1 &
      disown 2>/dev/null || true
    fi
  else
    echo "==> launchd 守护进程已注册，跳过"
  fi

  # 等待守护进程就绪
  API_PORT=""
  for i in $(seq 1 10); do
    local base_api_port="${WBSWITCH_PORT:-47832}"
    for candidate in $(seq "$base_api_port" $((base_api_port + 7))); do
      if curl -fsS -m 1 "http://127.0.0.1:${candidate}/healthz" >/dev/null 2>&1; then
        API_PORT="$candidate"
        echo "==> 守护进程运行中（端口 ${API_PORT}）"
        break 2
      fi
    done
    sleep 1
  done

  # ---------- 2. 彻底退出 WorkBuddy ----------
  echo "==> 退出 WorkBuddy ..."
  osascript -e 'quit app "WorkBuddy"' 2>/dev/null || true
  sleep 3
  # 兜底：按真实进程路径精确清理（进程名是 Electron，切勿 killall Electron 以免误伤其他应用）
  pkill -f "/Applications/WorkBuddy.app/Contents/MacOS/Electron" 2>/dev/null || true
  sleep 2
  if pgrep -f "/Applications/WorkBuddy.app/Contents/MacOS/Electron" >/dev/null 2>&1; then
    echo "   警告：WorkBuddy 仍在运行，强制结束"
    pkill -9 -f "/Applications/WorkBuddy.app/Contents/MacOS/Electron" 2>/dev/null || true
    sleep 2
  fi

  # ---------- 3. 带调试端口启动 ----------
  echo "==> 以 --remote-debugging-port=${PORT} 启动 WorkBuddy"
  if [ ! -x "$APP_BIN" ]; then
    echo "   错误：未找到 $APP_BIN"
    exit 1
  fi
  nohup "$APP_BIN" --remote-debugging-port="$PORT" >/dev/null 2>&1 &
  disown 2>/dev/null || true

  # ---------- 4. 验证 ----------
  echo "==> 等待 CDP 端口开放"
  OK=0
  for i in $(seq 1 15); do
    sleep 1
    if curl -s -m 2 "http://127.0.0.1:${PORT}/json/version" | grep -qiE 'WorkBuddy|CodeBuddy'; then
      OK=1
      break
    fi
  done

  if [ "$OK" = "1" ]; then
    API_PORT="${API_PORT:-${WBSWITCH_PORT:-47832}}"
    TOKEN_FILE="$DATA_DIR/api-token"
    if [ -s "$TOKEN_FILE" ]; then
      curl -fsS -m 3 -X POST -H "X-WorkDaddy-Token: $(cat "$TOKEN_FILE")" \
        "http://127.0.0.1:${API_PORT}/api/inject" >/dev/null 2>&1 || true
    fi
    echo ""
    echo "CDP 已开启: http://127.0.0.1:${PORT}"
    echo "   WorkBuddy 启动后右下角会自动出现账号切换组件（约几秒内）。"
    echo "   若未出现，请重新运行本脚本；本地 API 已启用令牌保护。"
  else
    echo ""
    echo "警告：等待 15 秒仍未检测到 WorkBuddy CDP 端口 ${PORT}。"
    echo "   WorkBuddy 可能忽略了该参数，或启动较慢。可再等几秒后执行："
    echo "   curl http://127.0.0.1:${PORT}/json/version"
  fi
}

# ---------- 交互式菜单（函数已定义，可安全调用） ----------

echo ""
echo "WorkBuddy 多账号切换器"
echo "  1) 启动/重启 WorkBuddy 并启用 CDP（默认）"
echo "  2) 恢复登录：从本地备份选择一个账号写入登录文件，再启动 WorkBuddy"
echo "  3) 退出"
read -r -p "请输入选项 [1]: " CHOICE
CHOICE="${CHOICE:-1}"

case "$CHOICE" in
  2)
    restore_login
    ;;
  3)
    echo "已取消"
    exit 0
    ;;
  *)
    launch_plugin
    ;;
esac
