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
DMG_WINDOW_WIDTH=620
DMG_WINDOW_HEIGHT=400
DMG_ICON_SIZE=112
DMG_BACKGROUND_SVG="$DIR/scripts/assets/macos-dmg-background.svg"
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

APP_ICON="$DIR/scripts/assets/WorkDaddy.icns"
if [ ! -f "$APP_ICON" ]; then
  echo "错误：缺少应用图标 $APP_ICON" >&2
  exit 1
fi
cp "$APP_ICON" "$APP/Contents/Resources/AppIcon.icns"
chmod 644 "$APP/Contents/Resources/AppIcon.icns"
echo "==> 应用图标已同步（背景 #e1e1e1）"

# 2) 只覆盖前端代码（保留壳的其余一切：launcher/Info.plist/builtin/node_modules/theme-audit.js）
for f in daemon.js session-db.js secure-transfer.js windows-process-boundary.js workbuddy-compat.js inject.js theme-patches.js credit-segments.js credit-resource-queries.js credit-request-usage.js credit-usage-store.js atomic-file-write.js ui-port.js checkin-result.js lib.js profiles.js workbuddy-target.js cdp-targets.js sentry-report.js install.sh relaunch-with-cdp.sh uninstall.sh apply-update.sh; do
  [ -f "scripts/$f" ] && cp "scripts/$f" "$APP/Contents/Resources/scripts/$f"
done
if [ -f "scripts/picker-internal.js" ]; then
  cp "scripts/picker-internal.js" "$APP/Contents/Resources/scripts/picker-internal.js"
  chmod 644 "$APP/Contents/Resources/scripts/picker-internal.js"
else
  rm -f "$APP/Contents/Resources/scripts/picker-internal.js"
fi
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
  "$APP/Contents/Resources/scripts/workbuddy-compat.js" \
  "$APP/Contents/Resources/scripts/inject.js" \
  "$APP/Contents/Resources/scripts/theme-patches.js"
echo "==> 前端代码已覆盖（权限按壳原样）"

# 3) 打包：staging 放 WorkDaddy.app + Applications 软链，并写入固定 Finder 布局。
STAGE="$(mktemp -d)"
DMG_TEMP_DIR="$(mktemp -d)"
RW_DMG="$DMG_TEMP_DIR/${PACKAGE_APP_NAME}-rw.dmg"
ATTACH_PLIST="$DMG_TEMP_DIR/attach.plist"
MOUNT_DIR=""
DMG_DEVICE=""
cleanup_dmg_build() {
  if [ -n "$DMG_DEVICE" ]; then
    hdiutil detach "$DMG_DEVICE" -force >/dev/null 2>&1 || true
  fi
  rm -rf -- "$STAGE" "$DMG_TEMP_DIR"
}
trap cleanup_dmg_build EXIT

PACKAGE_APP="$STAGE/${PACKAGE_APP_NAME}.app"
cp -R "$APP" "$PACKAGE_APP"
# Modern macOS uses CFBundleIconName when resolving an ICNS application icon.
# Keep it aligned with CFBundleIconFile so LaunchServices does not wrap the
# custom artwork in the generic gray application icon.
if /usr/libexec/PlistBuddy -c 'Print :CFBundleIconName' "$PACKAGE_APP/Contents/Info.plist" >/dev/null 2>&1; then
  /usr/libexec/PlistBuddy -c 'Set :CFBundleIconName AppIcon' "$PACKAGE_APP/Contents/Info.plist"
else
  /usr/libexec/PlistBuddy -c 'Add :CFBundleIconName string AppIcon' "$PACKAGE_APP/Contents/Info.plist"
fi
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

# Finder 不直接显示 SVG 背景；保留 SVG 作为矢量母版，打包时用系统 sips
# 渲染 1x/2x 位图并合成 HiDPI TIFF，避免 Retina 屏幕放大单分辨率背景。
if [ ! -f "$DMG_BACKGROUND_SVG" ]; then
  echo "错误：缺少 DMG 背景矢量资源 $DMG_BACKGROUND_SVG" >&2
  exit 1
fi
mkdir -p "$STAGE/.background"
BACKGROUND_1X="$STAGE/.background/background-1x.png"
BACKGROUND_2X="$STAGE/.background/background-2x.png"
RENDERED_BACKGROUND="$STAGE/.background/background.tiff"
sips -s format png "$DMG_BACKGROUND_SVG" --out "$BACKGROUND_1X" >/dev/null
sips -s format png -z 800 1240 "$DMG_BACKGROUND_SVG" --out "$BACKGROUND_2X" >/dev/null
BACKGROUND_1X_WIDTH="$(sips -g pixelWidth "$BACKGROUND_1X" | awk '/pixelWidth:/ { print $2 }')"
BACKGROUND_1X_HEIGHT="$(sips -g pixelHeight "$BACKGROUND_1X" | awk '/pixelHeight:/ { print $2 }')"
BACKGROUND_2X_WIDTH="$(sips -g pixelWidth "$BACKGROUND_2X" | awk '/pixelWidth:/ { print $2 }')"
BACKGROUND_2X_HEIGHT="$(sips -g pixelHeight "$BACKGROUND_2X" | awk '/pixelHeight:/ { print $2 }')"
if [ "$BACKGROUND_1X_WIDTH" != "$DMG_WINDOW_WIDTH" ] || [ "$BACKGROUND_1X_HEIGHT" != "$DMG_WINDOW_HEIGHT" ]; then
  echo "错误：DMG 1x 背景尺寸必须为 ${DMG_WINDOW_WIDTH}x${DMG_WINDOW_HEIGHT}，实际为 ${BACKGROUND_1X_WIDTH}x${BACKGROUND_1X_HEIGHT}" >&2
  exit 1
fi
if [ "$BACKGROUND_2X_WIDTH" != "$((DMG_WINDOW_WIDTH * 2))" ] || [ "$BACKGROUND_2X_HEIGHT" != "$((DMG_WINDOW_HEIGHT * 2))" ]; then
  echo "错误：DMG 2x 背景尺寸必须为 $((DMG_WINDOW_WIDTH * 2))x$((DMG_WINDOW_HEIGHT * 2))，实际为 ${BACKGROUND_2X_WIDTH}x${BACKGROUND_2X_HEIGHT}" >&2
  exit 1
fi
tiffutil -cathidpicheck "$BACKGROUND_1X" "$BACKGROUND_2X" -out "$RENDERED_BACKGROUND" >/dev/null

# 先创建可写镜像，让 Finder 把窗口尺寸、图标位置和背景写进卷根目录的
# .DS_Store；布局完成后再转成只读压缩镜像。
hdiutil create -volname "$PACKAGE_APP_NAME" -srcfolder "$STAGE" -ov -format UDRW "$RW_DMG" >/dev/null
hdiutil attach -readwrite -noverify -noautoopen -plist "$RW_DMG" > "$ATTACH_PLIST"
read -r DMG_DEVICE MOUNT_DIR < <(python3 - "$ATTACH_PLIST" <<'PY'
import plistlib
import sys

with open(sys.argv[1], 'rb') as f:
    attached = plistlib.load(f)
for entity in attached.get('system-entities', []):
    mount_point = entity.get('mount-point')
    device = entity.get('dev-entry')
    if mount_point and device:
        print(device, mount_point)
        break
PY
)
if [ -z "$DMG_DEVICE" ] || [ -z "$MOUNT_DIR" ]; then
  echo "错误：无法识别可写 DMG 的挂载设备或目录" >&2
  exit 1
fi

VOLUME_NAME="$(basename "$MOUNT_DIR")"
sleep 2
osascript - "$VOLUME_NAME" "${PACKAGE_APP_NAME}.app" "$DMG_WINDOW_WIDTH" "$DMG_WINDOW_HEIGHT" "$DMG_ICON_SIZE" <<'APPLESCRIPT'
on run argv
  set volumeName to item 1 of argv
  set appName to item 2 of argv
  set dmgWindowWidth to item 3 of argv as integer
  set dmgWindowHeight to item 4 of argv as integer
  set dmgIconSize to item 5 of argv as integer
  set windowLeft to 200
  set windowTop to 120
  set windowRight to windowLeft + dmgWindowWidth
  set windowBottom to windowTop + dmgWindowHeight

  tell application "Finder"
    tell disk (volumeName as string)
      open
      tell container window
        set current view to icon view
        set toolbar visible to false
        set statusbar visible to false
        set bounds to {windowLeft, windowTop, windowRight, windowBottom}
        set position of every item to {windowRight + 100, 100}
      end tell

      set viewOptions to icon view options of container window
      set arrangement of viewOptions to not arranged
      set icon size of viewOptions to dmgIconSize
      set text size of viewOptions to 13
      set label position of viewOptions to bottom
      set shows item info of viewOptions to false
      set shows icon preview of viewOptions to true
      set background picture of viewOptions to file ".background:background.tiff"

      set position of item appName to {150, 190}
      set position of item "Applications" to {470, 190}
      close
      open
      delay 1
      tell container window
        set statusbar visible to false
        set bounds to {windowLeft, windowTop, windowRight - 10, windowBottom - 10}
      end tell
    end tell

    delay 1
    tell disk (volumeName as string)
      tell container window
        set statusbar visible to false
        set bounds to {windowLeft, windowTop, windowRight, windowBottom}
      end tell
    end tell
    delay 2
  end tell
end run
APPLESCRIPT

sync
for _ in {1..20}; do
  test -f "$MOUNT_DIR/.DS_Store" && break
  sleep 0.25
done
if ! test -f "$MOUNT_DIR/.DS_Store"; then
  echo "错误：Finder 未能把 DMG 窗口布局写入 .DS_Store" >&2
  exit 1
fi
rm -rf -- "$MOUNT_DIR/.fseventsd"
hdiutil detach "$DMG_DEVICE" >/dev/null
DMG_DEVICE=""
rm -f "$OUT"
hdiutil convert "$RW_DMG" -ov -format UDZO -imagekey zlib-level=9 -o "$OUT" >/dev/null

echo "==> 完成: $(ls -lh "$OUT" | awk '{print $5}')"
echo "    校验: hdiutil attach -nobrowse -readonly '$OUT' 后检查"
echo "          Finder 窗口必须为 ${DMG_WINDOW_WIDTH}x${DMG_WINDOW_HEIGHT}，左右图标间显示箭头"
echo "          launcher 权限必须为 rwxr-xr-x、daemon.js 版本为 ${VERSION}"
