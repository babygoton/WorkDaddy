#!/usr/bin/env bash
# WorkDaddy — Linux 发布包构建脚本
#
# 产出（release/linux/）：
#   WorkDaddy-<version>-linux-x64.tar.gz   通用压缩包（解压即用）
#   workdaddy-<version>_amd64.deb          Debian/Ubuntu 安装包（装到 /opt/WorkDaddy）
#
# 用法:
#   bash scripts/build-linux-tar.sh                  # 两个都打
#   bash scripts/build-linux-tar.sh --deb-only
#   WORKDADDY_BUILD_VERSION=1.2.3 bash scripts/build-linux-tar.sh
#
# 依赖：bash / tar /（打 deb 时需要 dpkg-deb）
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

VERSION="${WORKDADDY_BUILD_VERSION:-$(grep -o "DAEMON_VERSION = '[^']*'" scripts/daemon.js | head -1 | cut -d"'" -f2)}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "错误：发布版本必须是 x.y.z，实际为 ${VERSION}" >&2
  exit 2
fi

DEB_ONLY=0
[ "${1:-}" = "--deb-only" ] && DEB_ONLY=1

OUT="$DIR/release/linux"
mkdir -p "$OUT"
# staging 用一次性临时目录：不删任何既有文件，也避免误伤工作区
TMPROOT="$(mktemp -d)"
STAGE="$TMPROOT/WorkDaddy-linux"
mkdir -p "$STAGE/scripts"

# ---- 1. daemon 依赖的模块清单（与 build-mac-dmg.sh 保持一致，缺一不可）----
for f in daemon.js toast-runtime.js toast-options.js primary-account.js completion-report.js \
         automation-runtime.js automation-packages.js automation-compatibility.js automation-transfer.js \
         automation-zip.js automation.js automation-picker.js token-refresh.js session-db.js \
         third-party-models.js secure-transfer.js session-transfer.js windows-process-boundary.js \
         workbuddy-compat.js inject.js theme-patches.js theme-text-shadow.js theme-vars.js \
         credit-segments.js credit-resource-queries.js credit-request-usage.js credit-history-sync.js \
         credit-usage-store.js credit-rotation.js token-stats.js growth-active.js atomic-file-write.js \
         ui-port.js checkin-result.js checkin-consent.js lib.js profiles.js workbuddy-target.js \
         cdp-targets.js sentry-report.js usage-report.js windows-installer-launch.js \
         install-linux.sh uninstall-linux.sh relaunch-with-cdp-linux.sh apply-update-linux.sh \
         install.sh uninstall.sh relaunch-with-cdp.sh apply-update.sh; do
  [ -f "scripts/$f" ] && cp "scripts/$f" "$STAGE/scripts/$f"
done

# ---- 2. 运行时资源（品牌素材、内置自动化预设、内置壁纸）----
[ -d scripts/assets ] && { mkdir -p "$STAGE/scripts/assets"; cp -r scripts/assets/. "$STAGE/scripts/assets/"; }
[ -d scripts/builtin ] && { mkdir -p "$STAGE/scripts/builtin"; cp -r scripts/builtin/. "$STAGE/scripts/builtin/"; }
[ -d scripts/builtin-overrides ] && { mkdir -p "$STAGE/scripts/builtin-overrides"; cp -r scripts/builtin-overrides/. "$STAGE/scripts/builtin-overrides/"; }

# ---- 3. 文档与版本标记 ----
cp -f README.md README-Linux.md LICENSE "$STAGE/" 2>/dev/null || true
printf '%s\n' "$VERSION" > "$STAGE/version.txt"
chmod +x "$STAGE"/scripts/*.sh

# ---- 4. 校验：daemon.js 直接 require 的本地模块必须都已 stage ----
MISSING=0
grep -oE "require\(['\"]\./[a-zA-Z0-9_.-]+\.js['\"]\)" scripts/daemon.js \
  | sed -E "s/.*\.\/([^'\"]+)\.js.*/\1.js/" | sort -u > "$TMPROOT/.required-modules"
while IFS= read -r mod; do
  [ -n "$mod" ] || continue
  # 仓库里根本不存在的模块（如 macOS 构建期生成的 plist-reader.js）跳过
  [ -f "scripts/$mod" ] || continue
  [ -f "$STAGE/scripts/$mod" ] || { echo "错误：缺少依赖模块 $mod" >&2; MISSING=1; }
done < "$TMPROOT/.required-modules"
rm -f "$TMPROOT/.required-modules"
[ "$MISSING" = "1" ] && exit 2

# ---- 5. 打 tar.gz ----
TARBALL="$OUT/WorkDaddy-${VERSION}-linux-x64.tar.gz"
if [ "$DEB_ONLY" = "0" ]; then
  tar -czf "$TARBALL" -C "$TMPROOT" "WorkDaddy-linux"
  echo "==> $TARBALL"
fi

# ---- 6. 打 .deb ----
if command -v dpkg-deb >/dev/null 2>&1; then
  DEB_ROOT="$OUT/deb-root-$$"   # 放磁盘：tmpfs 容量不足以复制壁纸等资源
  mkdir -p "$DEB_ROOT/opt/WorkDaddy" "$DEB_ROOT/DEBIAN" "$DEB_ROOT/usr/bin"
  cp -r "$STAGE"/. "$DEB_ROOT/opt/WorkDaddy/"
  cat > "$DEB_ROOT/DEBIAN/control" <<EOF
Package: workdaddy
Version: ${VERSION}
Section: net
Priority: optional
Architecture: amd64
Depends: nodejs (>= 18)
Maintainer: WorkDaddy Linux Port <noreply@example.com>
Description: WorkBuddy desktop enhancement (Linux port)
 WorkDaddy enhances the WorkBuddy desktop client via CDP injection:
 multi-account switching, auto check-in, session transfer, themes,
 automation tasks and uninterrupted long-running agent jobs.
 It is not affiliated with or endorsed by the official WorkBuddy product.
EOF
  # 两个便捷入口：启动守护进程 / 以 CDP 模式重启 WorkBuddy
  cat > "$DEB_ROOT/usr/bin/workdaddy" <<'EOF'
#!/usr/bin/env bash
exec node /opt/WorkDaddy/scripts/daemon.js "$@"
EOF
  cat > "$DEB_ROOT/usr/bin/workdaddy-cdp" <<'EOF'
#!/usr/bin/env bash
exec bash /opt/WorkDaddy/scripts/relaunch-with-cdp-linux.sh "$@"
EOF
  chmod +x "$DEB_ROOT/usr/bin/workdaddy" "$DEB_ROOT/usr/bin/workdaddy-cdp"
  DEB="$OUT/workdaddy_${VERSION}_amd64.deb"
  dpkg-deb --build --root-owner-group "$DEB_ROOT" "$DEB" >/dev/null
  echo "==> $DEB"
else
  echo "警告：未找到 dpkg-deb，跳过 .deb 构建（tar.gz 已生成）"
fi

echo ""
echo "构建完成，版本 ${VERSION}"
