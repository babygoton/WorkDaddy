#!/usr/bin/env bash
# WorkDaddy Linux 一键启用 CDP（退出并以调试端口重启 WorkBuddy）
#
# 流程：
#   1) 确保守护进程在运行（脱离会话后台启动）
#   2) 选择/复用 CDP 端口
#   3) 退出 WorkBuddy（SIGTERM → 超时 SIGKILL，按可执行文件精确匹配 PID）
#   4) 带 --remote-debugging-port 重新启动
#   5) 验证 CDP 端口开放
#
# 用法:
#   bash scripts/relaunch-with-cdp-linux.sh            # 交互式菜单
#   bash scripts/relaunch-with-cdp-linux.sh --yes      # 非交互，直接重启
#   bash scripts/relaunch-with-cdp-linux.sh --restore  # 从备份恢复某账号后重启
#
# 环境变量：
#   WBSWITCH_PROFILE            profile（默认 workbuddy-cn）
#   WBSWITCH_DATA_DIR           备份目录
#   WBSWITCH_CDP_PORT           指定 CDP 端口
#   WBSWITCH_WORKBUDDY_BIN      指定可执行文件（覆盖 workbuddy-target.json）
#   WBSWITCH_WORKBUDDY_LAUNCHER 指定启动器（如 ~/.local/bin/workbuddy-noproxy）
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
  workbuddy-ai)   DEFAULT_DATA_DIR="$XDG_CONFIG_HOME/WorkDaddy/profiles/workbuddy-ai"; DEFAULT_UI_PORT=47833; DEFAULT_CDP_PORT=9223 ;;
  codebuddy-cn)   DEFAULT_DATA_DIR="$XDG_CONFIG_HOME/WorkDaddy/profiles/codebuddy-cn"; DEFAULT_UI_PORT=47834; DEFAULT_CDP_PORT=9224 ;;
  codebuddy-intl) DEFAULT_DATA_DIR="$XDG_CONFIG_HOME/WorkDaddy/profiles/codebuddy-intl"; DEFAULT_UI_PORT=47835; DEFAULT_CDP_PORT=9225 ;;
  *)              PROFILE="workbuddy-cn"; DEFAULT_DATA_DIR="$XDG_CONFIG_HOME/WorkDaddy"; DEFAULT_UI_PORT=47832; DEFAULT_CDP_PORT=9222 ;;
esac
export WBSWITCH_PROFILE="$PROFILE"

DATA_DIR="${WBSWITCH_DATA_DIR:-$DEFAULT_DATA_DIR}"
UI_PORT="${WBSWITCH_PORT:-$DEFAULT_UI_PORT}"
PORT="${WBSWITCH_CDP_PORT:-}"
CDP_PORT_FILE="$DATA_DIR/cdp-port.json"
TARGET_FILE="$DATA_DIR/workbuddy-target.json"

mkdir -p "$DATA_DIR" 2>/dev/null || true

NODE=""
# 海外版以隔离 HOME 运行，该 HOME 下没有托管 runtime，需回退到登录用户的真实家目录
REAL_HOME="${WBSWITCH_LAUNCH_HOME:-}"
if [ -z "$REAL_HOME" ]; then
  REAL_HOME="$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6)"
fi
# 容器/沙箱里 uid 可能是 0 而家目录是 /root，真实工作目录在 /home/<user>；
# 以「存在海外版应用副本或 .workbuddy」为准再兜底一次。
if [ -z "$REAL_HOME" ] || { [ ! -d "$REAL_HOME/.local/share/workbuddy-ai" ] && [ ! -d "$REAL_HOME/.workbuddy" ]; }; then
  for c in "$HOME" /home/*; do
    [ -d "$c/.local/share/workbuddy-ai" ] || [ -d "$c/.workbuddy" ] || continue
    REAL_HOME="$c"; break
  done
fi
[ -n "$REAL_HOME" ] || REAL_HOME="$HOME"
export WBSWITCH_LAUNCH_HOME="$REAL_HOME"
for c in \
  "$REAL_HOME/.workbuddy/binaries/node/versions/22.22.2/bin/node" \
  "$HOME/.workbuddy/binaries/node/versions/22.22.2/bin/node" \
  "$REAL_HOME/.workbuddy/binaries/node/current/bin/node" \
  "$HOME/.workbuddy/binaries/node/current/bin/node" \
  "$(command -v node 2>/dev/null || true)"; do
  [ -n "$c" ] && [ -x "$c" ] && { NODE="$c"; break; }
done
if [ -z "$NODE" ]; then
  for c in "$REAL_HOME"/.workbuddy/binaries/node/versions/*/bin/node "$HOME"/.workbuddy/binaries/node/versions/*/bin/node; do
    [ -x "$c" ] && { NODE="$c"; break; }
  done
fi
if [ -z "$NODE" ]; then echo "错误: 未找到 node" >&2; exit 1; fi

# 回环请求绕过代理（系统 http_proxy 会让 127.0.0.1 的健康检查被劫持）
curl_local() { curl -s --noproxy '*' -m 2 "$@"; }
REPORTER="$DIR/scripts/sentry-report.js"

# 端口占用检测：优先 nc，其次 lsof，最后 bash /dev/tcp
port_in_use() {
  local p="$1"
  if command -v nc >/dev/null 2>&1; then nc -z -w 1 127.0.0.1 "$p" >/dev/null 2>&1 && return 0 || return 1; fi
  if command -v lsof >/dev/null 2>&1; then lsof -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1 && return 0 || return 1; fi
  (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null && return 0 || return 1
}

# ---------------- 解析 WorkBuddy 可执行文件 ----------------
resolve_binary() {
  if [ -n "${WBSWITCH_WORKBUDDY_BIN:-}" ]; then printf '%s' "$WBSWITCH_WORKBUDDY_BIN"; return 0; fi
  if [ -f "$TARGET_FILE" ]; then
    local bin
    bin="$("$NODE" -e "
      try { const j=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); process.stdout.write(String(j.binary||'')); } catch(_){}
    " "$TARGET_FILE")"
    [ -n "$bin" ] && { printf '%s' "$bin"; return 0; }
  fi
  "$NODE" -e "
    const p = require(process.argv[1]);
    process.stdout.write(p.getProfile(process.argv[2], { platform: 'linux' }).appPath || '');
  " "$DIR/scripts/profiles.js" "$PROFILE"
}
APP_BIN="$(resolve_binary)"

# ---------------- 选择启动器 ----------------
# 优先使用用户自己的启动器（例如 workbuddy-noproxy 会 unset 代理并设 NO_PROXY）。
# WorkBuddy 的登录网关 copilot.tencent.com 走代理时会出现 502/certificate expired，
# 直接 exec 真实二进制会丢掉这层配置，所以启动器存在就用它。
resolve_launcher() {
  if [ -n "${WBSWITCH_WORKBUDDY_LAUNCHER:-}" ]; then printf '%s' "$WBSWITCH_WORKBUDDY_LAUNCHER"; return 0; fi
  # 隔离 HOME 下 $HOME/.local/bin 通常没有东西（海外版就是这种情形），
  # 因此同时搜索登录用户的真实家目录。
  local dirs="$HOME/.local/bin $REAL_HOME/.local/bin"
  case "$PROFILE" in
    workbuddy-cn)   _names="workbuddy-noproxy workbuddy" ;;
    workbuddy-ai)   _names="workbuddy-ai workbuddy-ai-noproxy" ;;
    codebuddy-cn)   _names="codebuddy-cn codebuddy" ;;
    codebuddy-intl) _names="codebuddy" ;;
    *)              _names="" ;;
  esac
  local d n
  for d in $dirs; do
    for n in $_names; do
      if [ -x "$d/$n" ]; then printf '%s' "$d/$n"; return 0; fi
    done
  done
}
LAUNCHER="$(resolve_launcher || true)"
LAUNCH_TARGET="${LAUNCHER:-$APP_BIN}"
# 必须导出给守护进程：切换账号时守护进程要自己重启应用，
# 它靠这个变量才能走启动器（保留 --user-data-dir / MIME 关联 / 免代理环境）。
if [ -n "$LAUNCHER" ]; then export WBSWITCH_WORKBUDDY_LAUNCHER="$LAUNCHER"; fi

# ---------------- CDP 进程识别 ----------------
pids_matching() {
  local binary="$1"
  [ -n "$binary" ] || return 0
  "$NODE" -e '
    const fs = require("fs");
    const target = process.argv[1];
    let canonical = target;
    try { canonical = fs.realpathSync(target); } catch (_) {}
    let entries = [];
    try { entries = fs.readdirSync("/proc"); } catch (_) { process.exit(0); }
    const pids = [];
    for (const e of entries) {
      if (!/^\d+$/.test(e)) continue;
      let raw = "";
      try { raw = fs.readFileSync(`/proc/${e}/cmdline`, "utf8"); } catch (_) { continue; }
      const argv0 = raw.split("\0")[0];
      if (!argv0) continue;
      if (argv0 === target) { pids.push(e); continue; }
      try { if (fs.realpathSync(argv0) === canonical) pids.push(e); } catch (_) {}
    }
    if (pids.length) process.stdout.write(pids.join(" "));
  ' "$APP_BIN"
}

is_workbuddy_cdp() {
  curl_local "http://127.0.0.1:$1/json/version" 2>/dev/null | grep -qiE 'WorkBuddy|CodeBuddy'
}

# 该端口上的页面是否属于「本 profile 的应用」。
#
# 为什么不能只看 /json/version：CN 与 AI 是同一份构建的两个副本，
# /json/version 的 User-Agent 都含 "WorkBuddy/5.5.4"，无法区分实例。
# 若不区分，海外版脚本会把国内版已占用的端口误判成"自己的"，直接复用，
# 结果两个实例抢同一端口、两个守护进程挂到同一个应用上（真实踩过）。
# 这里改用「应用安装目录」作为归属标记 —— CN 是 /opt/WorkBuddy，
# AI 是 ~/.local/share/workbuddy-ai/app，两者页面 URL 互不含对方目录。
is_profile_cdp() {
  local port="$1" list dir
  list="$(curl_local "http://127.0.0.1:$port/json/list" 2>/dev/null)" || return 1
  [ -n "$list" ] || return 1
  dir="$(dirname "${APP_BIN:-}" 2>/dev/null)"
  # 必须校验 dir 形态：APP_BIN 为空时 dirname 会给出 "."，
  # 而 grep -F "." 能匹配任何内容 → 变成"人人都算自己人"。
  if [ -n "$dir" ] && [ "${#dir}" -gt 1 ] && [ "${dir#/}" != "$dir" ] \
     && printf '%s' "$list" | grep -qF "$dir"; then
    return 0
  fi
  # 回退：按端专属字样判断（安装目录非默认时仍可用）
  case "$PROFILE" in
    workbuddy-ai) printf '%s' "$list" | grep -qi 'workbuddy-ai' ;;
    workbuddy-cn) printf '%s' "$list" | grep -qi 'workbuddy\.cn\|WorkBuddy/resources' ;;
    *)            printf '%s' "$list" | grep -qiE 'WorkBuddy|CodeBuddy' ;;
  esac
}

valid_port() { [ "${1:-0}" -ge 1024 ] 2>/dev/null && [ "${1:-0}" -le 65535 ] 2>/dev/null; }

resolve_cdp_port() {
  local saved="" p
  [ -f "$CDP_PORT_FILE" ] && saved="$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$CDP_PORT_FILE" | head -1)"
  local candidates=""
  valid_port "$PORT" && candidates="$candidates $PORT"
  valid_port "$saved" && candidates="$candidates $saved"
  for p in $(seq 9222 9232); do candidates="$candidates $p"; done
  candidates="$candidates 9333"

  # 1) 本 profile 的应用已经在跑 → 复用它的端口（不重复开、不撞兄弟端）
  for p in $candidates; do if is_profile_cdp "$p"; then PORT="$p"; break; fi; done
  # 2) 否则挑一个真正空闲的端口（被兄弟端或别的服务占用的都跳过）
  if ! is_profile_cdp "${PORT:-0}"; then
    for p in $candidates; do
      if ! port_in_use "$p"; then PORT="$p"; break; fi
    done
  fi
  valid_port "${PORT:-0}" || { echo "错误: 9222-9232、9333 均被占用" >&2; exit 1; }

  # 端口先落盘：守护进程启动时会读它，保证「App 的端口」与「守护进程探测的端口」一致
  mkdir -p "$DATA_DIR" 2>/dev/null || true
  printf '{"port":%s,"updatedAt":"%s"}\n' "$PORT" "$(date -u +%FT%TZ)" > "${CDP_PORT_FILE}.tmp.$$"
  mv -f "${CDP_PORT_FILE}.tmp.$$" "$CDP_PORT_FILE"
}

stop_daemon() {
  local lock="$DATA_DIR/.daemon.lock" pid
  [ -f "$lock" ] || return 0
  pid="$("$NODE" -e "
    try { const j=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')); process.stdout.write(String(j.pid||'')); } catch(_){}
  " "$lock" 2>/dev/null)"
  [ -n "$pid" ] || return 0
  kill -0 "$pid" 2>/dev/null || return 0
  echo "==> 停止旧守护进程 pid=$pid（需要按新 CDP 端口重启）"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 15); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
  kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
  rm -f "$lock" 2>/dev/null || true
}

# 必须以 WBSWITCH_CDP_PORT=$PORT 启动：守护进程只探测「profile 默认端口 + 落盘端口」，
# 而 Linux 上端口是动态分配的（9222 常被其他服务占用），不显式告知就会探错端口、
# 连到兄弟实例的页面上（真实踩过：AI 守护进程挂到了 CN 应用）。
ensure_daemon() {
  stop_daemon
  echo "==> 启动守护进程（CDP 端口 $PORT）"
  mkdir -p "$DATA_DIR/accounts"
  WBSWITCH_CDP_PORT="$PORT" setsid nohup "$NODE" "$DIR/scripts/daemon.js" >> "$DATA_DIR/daemon.log" 2>&1 < /dev/null &
  for _ in $(seq 1 15); do
    curl_local "http://127.0.0.1:${UI_PORT}/api/status" >/dev/null 2>&1 && { echo "==> 守护进程就绪"; return 0; }
    sleep 1
  done
  echo "   警告: 守护进程未就绪，日志: $DATA_DIR/daemon.log"
  return 0
}

restore_login() {
  local accounts_dir="$DATA_DIR/accounts"
  echo ""
  echo "==> 扫描本地账号备份 ..."
  if [ ! -d "$accounts_dir" ]; then echo "   未找到备份目录: $accounts_dir"; exit 1; fi
  local map
  map="$("$NODE" -e '
    const fs=require("fs"), path=require("path");
    const dir=process.argv[1];
    const files=fs.readdirSync(dir).filter(f=>f.endsWith(".info")&&!f.endsWith(".tmp"));
    if(!files.length){console.error("NO_ACCOUNTS");process.exit(1);}
    files.forEach((f,i)=>{
      const uid=f.replace(/\.info$/,""); let nickname="",phone="";
      try{const j=JSON.parse(fs.readFileSync(path.join(dir,f),"utf8"));
        const a=j.account||(Array.isArray(j.accounts)&&j.accounts[0]);
        if(a){nickname=a.nickname||"";phone=a.phoneNumber||"";}}catch(_){}
      console.log(`${i+1}|${uid}|${nickname}|${phone}`);
    });
  ' "$accounts_dir")"
  local auth_file
  auth_file="$("$NODE" -e "
    const p=require(process.argv[1]);
    const prof=p.getProfile(process.argv[2],{platform:'linux'});
    process.stdout.write(prof.authFile||'');
  " "$DIR/scripts/profiles.js" "$PROFILE")"
  if [ -z "$auth_file" ]; then echo "   当前 profile 不支持账号切换"; exit 1; fi

  echo ""
  echo "可选账号："
  echo "$map" | while IFS='|' read -r idx uid nickname phone; do
    printf '  %s) %-14s %-13s UID:%s\n' "$idx" "${nickname:-(未命名)}" "${phone:-(-)}" "$uid"
  done
  echo ""
  read -r -p "选择要恢复的账号编号: " n
  local line uid src
  line="$(echo "$map" | grep "^${n}|" || true)"
  [ -z "$line" ] && { echo "   无效编号"; exit 1; }
  uid="$(echo "$line" | cut -d'|' -f2)"
  src="$accounts_dir/${uid}.info"
  [ -f "$src" ] || { echo "   备份文件不存在: $src"; exit 1; }
  mkdir -p "$(dirname "$auth_file")"
  # 先写临时文件再原子替换，避免 WorkBuddy 读到半截 JSON
  cp "$src" "${auth_file}.wbswitch.tmp"
  chmod 600 "${auth_file}.wbswitch.tmp"
  mv -f "${auth_file}.wbswitch.tmp" "$auth_file"
  echo "   已恢复账号 $uid → $auth_file"
  RETRY_AFTER_RESTORE=1
  launch_plugin
}

# 只读探测：本 profile 的应用当前是否已在 CDP 模式、用的是哪个端口。
# 与 resolve_cdp_port 的区别是「不分配、不落盘」，可安全用于状态查询。
probe_cdp_port() {
  local saved="" p
  [ -f "$CDP_PORT_FILE" ] && saved="$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$CDP_PORT_FILE" | head -1)"
  local candidates=""
  valid_port "$saved" && candidates="$candidates $saved"
  valid_port "$PORT" && candidates="$candidates $PORT"
  for p in $(seq 9222 9232); do candidates="$candidates $p"; done
  candidates="$candidates 9333"
  for p in $candidates; do if is_profile_cdp "$p"; then printf '%s' "$p"; return 0; fi; done
  return 1
}

print_status() {
  local cdp daemon app
  cdp="$(probe_cdp_port || true)"
  if curl_local "http://127.0.0.1:${UI_PORT}/api/status" >/dev/null 2>&1; then daemon=up; else daemon=down; fi
  if [ -n "$(pids_matching "$APP_BIN")" ]; then app=running; else app=stopped; fi
  echo "profile=${PROFILE}"
  echo "ui_port=${UI_PORT}"
  echo "daemon=${daemon}"
  echo "app=${app}"
  echo "cdp=${cdp:-none}"
  echo "cdp_ready=$([ -n "$cdp" ] && echo yes || echo no)"
}

launch_plugin() {
  # --ensure：应用已经在 CDP 模式时完全不碰它（避免无谓地关掉用户窗口），
  # 只确保守护进程在跑。桌面图标默认走这个模式。
  if [ "${ENSURE_ONLY:-0}" = "1" ]; then
    local existing
    existing="$(probe_cdp_port || true)"
    if [ -n "$existing" ]; then
      PORT="$existing"
      echo "==> 应用已在 CDP 模式运行（端口 ${PORT}），无需重启"
      ensure_daemon
      echo ""
      echo "✅ 已就绪: http://127.0.0.1:${PORT}"
      echo "   面板入口：WorkBuddy 右下角机器人按钮"
      return 0
    fi
    echo "==> 应用未在 CDP 模式，需要重启才能启用面板"
  fi

  if [ "${ASSUME_YES:-0}" != "1" ] && [ "${RETRY_AFTER_RESTORE:-0}" != "1" ]; then
    echo ""
    echo "警告：即将退出 WorkBuddy 并以 CDP 模式重启（请先保存工作内容，包括当前对话）。"
    read -r -p "确认继续？(y/N) " ans
    case "$ans" in y|Y|yes|YES) ;; *) echo "已取消"; exit 0 ;; esac
  fi

  # 顺序很重要：必须「先定端口 → 再按该端口启动守护进程 → 最后带同一端口启动 App」。
  # 反过来的话（先起守护进程），守护进程会退回 profile 默认端口去探测，
  # 而 Linux 上端口常被其他服务占用导致实际端口不同，就会连到兄弟实例上。
  resolve_cdp_port
  ensure_daemon

  echo "==> 退出 WorkBuddy ..."
  local pids
  pids="$(pids_matching "$APP_BIN")"
  if [ -n "$pids" ]; then
    # SIGTERM 让 Electron 走正常关闭流程（会话落盘），超时再 SIGKILL
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    for _ in $(seq 1 20); do
      [ -z "$(pids_matching "$APP_BIN")" ] && break
      sleep 0.5
    done
    pids="$(pids_matching "$APP_BIN")"
    if [ -n "$pids" ]; then
      echo "   WorkBuddy 未在 10 秒内退出，强制结束"
      # shellcheck disable=SC2086
      kill -9 $pids 2>/dev/null || true
      sleep 1
    fi
  else
    echo "   WorkBuddy 未在运行"
  fi

  if [ -z "$APP_BIN" ] || { [ ! -x "$APP_BIN" ] && [ -z "$LAUNCHER" ]; }; then
    echo "错误: 未找到 WorkBuddy 可执行文件（可用 WBSWITCH_WORKBUDDY_BIN 指定）: $APP_BIN" >&2
    exit 1
  fi

  echo "==> 以 --remote-debugging-port=${PORT} 启动 WorkBuddy"
  echo "   方式: ${LAUNCHER:+启动器 }${LAUNCH_TARGET}"
  # 走启动器时必须把 HOME 还原成「真实家目录」。
  # 启动器用 $HOME 反推真实家目录（见 workbuddy-ai 启动器），若带着隔离 HOME 调用它，
  # 它会把隔离 HOME 当真实家目录，把 $ISOHOME/.config/mimeapps.list 覆盖成自指死链，
  # 之后 xdg-open 就会把 https 交给 ChatGPT 之类的错误应用（真实踩过）。
  local launch_home="$HOME"
  if [ -n "$LAUNCHER" ]; then launch_home="$REAL_HOME"; fi
  if [ "$launch_home" != "$HOME" ]; then
    echo "   环境: HOME=${launch_home}（启动器需按真实家目录推导，不能传隔离 HOME）"
  fi
  # setsid：脱离当前会话，避免终端关闭时连带杀掉 WorkBuddy
  setsid nohup env HOME="$launch_home" "$LAUNCH_TARGET" --remote-debugging-port="$PORT" >/dev/null 2>&1 < /dev/null &
  disown 2>/dev/null || true

  echo "==> 等待 CDP 端口开放（并确认是本 profile 的实例）"
  local ok=0
  for _ in $(seq 1 60); do
    sleep 1
    if is_profile_cdp "$PORT"; then ok=1; break; fi
  done

  if [ "$ok" = "1" ]; then
    echo ""
    echo "✅ CDP 已开启: http://127.0.0.1:${PORT}  （已确认属于 ${PROFILE}）"
    echo "   WorkBuddy 启动后右下角会自动出现账号切换组件（约几秒内）。"
    echo "   若未出现，可手动重新注入: curl --noproxy '*' -X POST http://127.0.0.1:${UI_PORT}/api/inject"
  else
    echo ""
    echo "⚠️  等待 60 秒仍未检测到「本 profile」的 CDP 端口 ${PORT}。"
    echo "   端口上若被另一个实例占用，会出现「能连上但不是自己的」假象，"
    echo "   因此这里按「应用安装目录」做了归属校验，不会误判成功。"
    echo "   排查: curl --noproxy '*' http://127.0.0.1:${PORT}/json/list"
    echo "   若确实无效，改用真实二进制直启（跳过启动器）:"
    echo "     WBSWITCH_WORKBUDDY_LAUNCHER= bash \"$DIR/scripts/relaunch-with-cdp-linux.sh\" --yes"
    [ -f "$REPORTER" ] && "$NODE" "$REPORTER" --stage linux-cdp-timeout \
      --message "等待 60 秒未检测到本 profile 的 WorkBuddy CDP 端口" --extra-json "{\"cdpPort\":${PORT}}" >/dev/null 2>&1 || true
  fi
}

# ---------------- 入口 ----------------
ASSUME_YES=0
ENSURE_ONLY=0
ACTION=""
for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES=1 ;;
    --restore) ACTION="restore" ;;
    --status) ACTION="status" ;;
    --ensure) ENSURE_ONLY=1; ASSUME_YES=1 ;;   # 已在 CDP 模式则不重启应用；且不再交互提问
    --help|-h)
      echo "用法: bash scripts/relaunch-with-cdp-linux.sh [选项]"
      echo "  (无参数)   交互式菜单"
      echo "  --yes      非交互，直接重启并启用 CDP"
      echo "  --ensure   确保 CDP 可用：已在 CDP 模式则不重启应用；否则直接重启（不提问）"
      echo "  --restore  从本地备份恢复某个账号后启动"
      echo "  --status   只读输出当前状态（profile/ui_port/daemon/app/cdp）"
      exit 0 ;;
  esac
done

if [ "$ACTION" = "status" ]; then
  print_status
  exit 0
fi

if [ "$ACTION" = "restore" ]; then
  restore_login
  exit 0
fi

if [ "$ASSUME_YES" = "1" ]; then
  launch_plugin
  exit 0
fi

echo ""
echo "WorkBuddy 多账号切换器（Linux）"
echo "  1) 启动/重启 WorkBuddy 并启用 CDP（默认）"
echo "  2) 恢复登录：从本地备份选择一个账号写入登录文件，再启动 WorkBuddy"
echo "  3) 退出"
read -r -p "请输入选项 [1]: " CHOICE
CHOICE="${CHOICE:-1}"
case "$CHOICE" in
  2) restore_login ;;
  3) echo "已取消"; exit 0 ;;
  *) launch_plugin ;;
esac
