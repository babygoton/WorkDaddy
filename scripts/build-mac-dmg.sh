#!/usr/bin/env bash
# WorkDaddy macOS dmg 打包（壳子不动原则）
# ============================================================
# 原则：保留 WorkDaddy.app 的结构、权限和签名；按 profile 仅对 staged launcher
#       与 Info.plist 做必要的目标应用/品牌元数据处理，再覆盖内部前端代码。
# 背景：1.0.4 首版 dmg 打不开，根因是打包源 app 的 launcher 丢了可执行位
#       （-rw-rw-r--），hdiutil 打包后 macOS 拒绝启动不可执行的 CFBundleExecutable。
# 本脚本每次打包前自检并恢复 launcher 可执行位，避免产物因权限或 profile
# 元数据不一致而无法启动。
# 用法: bash scripts/build-mac-dmg.sh
# 产出: release/macos/WorkDaddy-<ver>.dmg（ver 取自 daemon.js 的 DAEMON_VERSION）
# ============================================================
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

VERSION="${WORKDADDY_BUILD_VERSION:-$(grep -o "DAEMON_VERSION = '[^']*'" scripts/daemon.js | head -1 | cut -d"'" -f2)}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "错误：发布版本必须是 x.y.z，实际为 ${VERSION}" >&2
  exit 2
fi
APP="WorkDaddy.app"
PROFILE="${WORKDADDY_BUILD_PROFILE:-}"
if [ -z "$PROFILE" ]; then
  for profile in workbuddy-cn workbuddy-ai; do
    WORKDADDY_BUILD_PROFILE="$profile" bash "$0"
  done
  exit 0
fi
case "$PROFILE" in
  workbuddy-ai) PACKAGE_APP_NAME="WorkDaddy AI"; OUT="release/macos/WorkDaddy-AI-${VERSION}.dmg" ;;
  *) PROFILE="workbuddy-cn"; PACKAGE_APP_NAME="WorkDaddy"; OUT="release/macos/WorkDaddy-${VERSION}.dmg" ;;
esac

echo "==> profile: ${PROFILE}"
echo "==> 版本: ${VERSION}"
echo "==> 产物: ${OUT}"

# 1) 壳完整性自检：launcher 必须有可执行位（1.0.3 原版为 -rwxr-xr-x）
chmod 755 "$APP/Contents/MacOS/launcher"
echo "==> launcher 可执行位已保证: $(stat -f '%Sp' "$APP/Contents/MacOS/launcher")"

# 2) 只覆盖前端代码（保留壳的其余一切：launcher/Info.plist/builtin/node_modules/theme-audit.js）
for f in daemon.js session-db.js secure-transfer.js windows-process-boundary.js workbuddy-compat.js inject.js theme-patches.js credit-segments.js credit-resource-queries.js credit-request-usage.js credit-usage-store.js atomic-file-write.js ui-port.js checkin-result.js growth-active.js lib.js profiles.js workbuddy-target.js cdp-targets.js sentry-report.js install.sh relaunch-with-cdp.sh uninstall.sh apply-update.sh; do
  [ -f "scripts/$f" ] && cp "scripts/$f" "$APP/Contents/Resources/scripts/$f"
done
WALLPAPER_OVERRIDE="scripts/builtin-overrides/wallpaper-06.webp"
if [ -f "$WALLPAPER_OVERRIDE" ]; then
  mkdir -p "$APP/Contents/Resources/scripts/builtin/wallpapers" "$APP/Contents/Resources/scripts/builtin/nebula"
  cp "$WALLPAPER_OVERRIDE" "$APP/Contents/Resources/scripts/builtin/wallpapers/wallpaper-06.webp"
  cp "$WALLPAPER_OVERRIDE" "$APP/Contents/Resources/scripts/builtin/nebula/background.webp"
fi
# 恢复这些文件的壳权限（与 1.0.3 壳内一致：sh/lib/daemon 755，inject/theme-patches 644）
chmod 755 "$APP/Contents/Resources/scripts/daemon.js" \
  "$APP/Contents/Resources/scripts/lib.js" \
  "$APP/Contents/Resources/scripts/sentry-report.js" \
  "$APP/Contents/Resources/scripts/install.sh" \
  "$APP/Contents/Resources/scripts/relaunch-with-cdp.sh" \
  "$APP/Contents/Resources/scripts/uninstall.sh" \
  "$APP/Contents/Resources/scripts/apply-update.sh"
chmod 644 "$APP/Contents/Resources/scripts/session-db.js" \
  "$APP/Contents/Resources/scripts/workbuddy-target.js" \
  "$APP/Contents/Resources/scripts/secure-transfer.js" \
  "$APP/Contents/Resources/scripts/windows-process-boundary.js" \
  "$APP/Contents/Resources/scripts/credit-request-usage.js" \
  "$APP/Contents/Resources/scripts/credit-usage-store.js" \
  "$APP/Contents/Resources/scripts/atomic-file-write.js" \
  "$APP/Contents/Resources/scripts/ui-port.js" \
  "$APP/Contents/Resources/scripts/checkin-result.js" \
  "$APP/Contents/Resources/scripts/growth-active.js" \
  "$APP/Contents/Resources/scripts/workbuddy-compat.js" \
  "$APP/Contents/Resources/scripts/inject.js" \
  "$APP/Contents/Resources/scripts/theme-patches.js"
echo "==> 前端代码已覆盖（权限按壳原样）"

# 3) 打包：staging 放 WorkDaddy.app + Applications 软链（与 1.0.3 dmg 同构）
STAGE="$(mktemp -d)"
PACKAGE_APP="$STAGE/${PACKAGE_APP_NAME}.app"
cp -R "$APP" "$PACKAGE_APP"
sed -i.bak "s|^PROFILE=.*|PROFILE=\"${PROFILE}\"|" "$PACKAGE_APP/Contents/MacOS/launcher"
rm -f "$PACKAGE_APP/Contents/MacOS/launcher.bak"
# 启动器只能复用当前 profile 的 WorkBuddy CDP；否则 CN 包会把 WorkBuddy AI 的端口
# 当成可复用目标，随后 daemon 按 CN profile 拒绝连接，用户看到的是启动器快速失败。
python3 - "$PACKAGE_APP/Contents/MacOS/launcher" <<'PY'
import re
import sys

path = sys.argv[1]
with open(path, encoding='utf-8') as f:
    source = f.read()
replacement = r'''is_workbuddy_cdp() {
  local p="$1" body
  body="$(curl -fsS --max-time 1 "http://127.0.0.1:${p}/json/version" 2>/dev/null || true)"
  case "$PROFILE" in
    workbuddy-ai)
      printf '%s' "$body" | grep -qiE 'WorkBuddy[[:space:]]*AI|WorkBuddyAI'
      ;;
    workbuddy-cn)
      printf '%s' "$body" | grep -qi 'WorkBuddy' &&
        ! printf '%s' "$body" | grep -qiE 'WorkBuddy[[:space:]]*AI|WorkBuddyAI'
      ;;
    *)
      printf '%s' "$body" | grep -qiE 'WorkBuddy|CodeBuddy'
      ;;
  esac
}'''
updated, count = re.subn(r'is_workbuddy_cdp\(\) \{.*?\n\}', replacement, source, count=1, flags=re.S)
if count != 1:
    raise SystemExit('macOS launcher 缺少可替换的 profile CDP 判定函数')
with open(path, 'w', encoding='utf-8', newline='') as f:
    f.write(updated)
PY
if [ "$PROFILE" = "workbuddy-ai" ]; then
  perl -0pi -e 's/<string>WorkDaddy<\/string>/<string>WorkDaddy AI<\/string>/g' "$PACKAGE_APP/Contents/Info.plist"
  perl -0pi -e 's/<string>com\.workdaddy\.launcher<\/string>/<string>com.workdaddy.ai.launcher<\/string>/g' "$PACKAGE_APP/Contents/Info.plist"
fi
# 注入完成后把目标 WorkBuddy 置前台，避免复用已有 CDP 时 Dock 仍停留在启动器上。
python3 - "$PACKAGE_APP/Contents/MacOS/launcher" <<'PY'
import re
import sys

path = sys.argv[1]
with open(path, encoding='utf-8') as f:
    source = f.read()
activation = '''activate_target_app() {
  # WorkDaddy 只负责启动/注入；前台归属应回到用户实际使用的 WorkBuddy。
  osascript -e "tell application \\\"${APP_NAME}\\\" to activate" >/dev/null 2>&1 || true
}
'''
if 'activate_target_app() {' not in source:
    source, count = re.subn(r'(notify\(\) \{[^\n]*\}\n)', r'\1\n' + activation, source, count=1)
    if count != 1:
        raise SystemExit('macOS launcher 缺少可插入激活函数的位置')
source = source.replace('  echo "[$(date -u +%FT%TZ)] manual inject result: ${INJECT_RESULT:0:500}"\n  exit 0',
                        '  echo "[$(date -u +%FT%TZ)] manual inject result: ${INJECT_RESULT:0:500}"\n  activate_target_app\n  exit 0')
source = source.replace('  echo "[$(date -u +%FT%TZ)] manual inject result: ${INJECT_RESULT:0:500}"\nelse',
                        '  echo "[$(date -u +%FT%TZ)] manual inject result: ${INJECT_RESULT:0:500}"\n  activate_target_app\nelse')
with open(path, 'w', encoding='utf-8', newline='') as f:
    f.write(source)
PY
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString ${VERSION}" "$PACKAGE_APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion ${VERSION}" "$PACKAGE_APP/Contents/Info.plist"
# 无论源码壳当前版本如何，每次产物都必须让 daemon 版本与安装包版本一致。
perl -0pi -e "s/(const DAEMON_VERSION = ')[^']+(';)/\${1}${VERSION}\${2}/" \
  "$PACKAGE_APP/Contents/Resources/scripts/daemon.js"
# 壳内可能残留旧的 release-x.y.z；只替换 Build ID 的版本段，保留日期/功能后缀。
perl -0pi -e "s/(const DAEMON_BUILD_ID = 'release-)[0-9]+\\.[0-9]+\\.[0-9]+/\${1}${VERSION}/" \
  "$PACKAGE_APP/Contents/Resources/scripts/daemon.js"
if ! grep -q "const DAEMON_VERSION = '${VERSION}';" "$PACKAGE_APP/Contents/Resources/scripts/daemon.js" \
  || ! grep -q "const DAEMON_BUILD_ID = 'release-${VERSION}-" "$PACKAGE_APP/Contents/Resources/scripts/daemon.js"; then
  echo "错误：产物 daemon.js 的版本或 Build ID 与 ${VERSION} 不一致" >&2
  exit 1
fi
# app 壳可能携带滞后的 package.json；同步版本元数据，避免旧值覆盖关于页/诊断信息。
if [ -f "$PACKAGE_APP/Contents/Resources/scripts/package.json" ]; then
  perl -0pi -e "s/(\"version\"\s*:\s*\")([^\"]+)(\")/\${1}${VERSION}\${3}/" \
    "$PACKAGE_APP/Contents/Resources/scripts/package.json"
fi
ln -s /Applications "$STAGE/Applications"
rm -f "$OUT"
hdiutil create -volname "$PACKAGE_APP_NAME" -srcfolder "$STAGE" -ov -format UDZO -imagekey zlib-level=9 "$OUT" >/dev/null
rm -rf "$STAGE"

echo "==> 完成: $(ls -lh "$OUT" | awk '{print $5}')"
echo "    校验: hdiutil attach -nobrowse -readonly '$OUT' 后检查"
echo "          launcher 权限必须为 rwxr-xr-x、daemon.js 版本为 ${VERSION}"
