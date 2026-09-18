#!/usr/bin/env bash
# Build a self-contained Ubuntu/Debian amd64 package. Run on a Linux build host.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != x86_64 ]; then
  echo 'Linux x86_64 构建机必需；请在 Ubuntu/Debian 上构建并验收' >&2
  exit 2
fi
for command in dpkg-deb curl sha256sum tar; do
  command -v "$command" >/dev/null 2>&1 || { echo "缺少构建工具: $command" >&2; exit 2; }
done

SOURCE_VERSION="$(sed -n "s/^const DAEMON_VERSION = '\([^']*\)';/\1/p" scripts/daemon.js | head -1)"
VERSION="${WORKDADDY_BUILD_VERSION:-$SOURCE_VERSION}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "版本号必须是 x.y.z: $VERSION" >&2
  exit 2
fi

NODE_ARCHIVE_NAME=node-v22.23.1-linux-x64.tar.xz
NODE_SHA256=9749e988f437343b7fa832c69ded82a312e41a03116d766797ac14f6f9eee578
WS_ARCHIVE_NAME=ws-8.18.3.tgz
WS_SHA256=424be604c8e7926fc29a1f067bf2dac256af3bcea62fe30395018bbaf8a9be2a
TEMP="$(mktemp -d)"
trap 'rm -rf -- "$TEMP"' EXIT
STAGE="$TEMP/stage"
SCRIPTS="$STAGE/opt/workdaddy/scripts"
mkdir -p "$SCRIPTS/runtime/node" "$SCRIPTS/node_modules/ws" "$SCRIPTS/assets" \
  "$STAGE/DEBIAN" "$STAGE/usr/share/applications" \
  "$STAGE/usr/share/icons/hicolor/1024x1024/apps" release/linux

fetch_archive() {
  local source="${1:-}" url="$2" expected="$3" output="$4"
  if [ -n "$source" ]; then
    [ -f "$source" ] || { echo "归档文件不存在: $source" >&2; exit 2; }
    cp "$source" "$output"
  else
    curl --fail --location --retry 3 --silent --show-error "$url" -o "$output"
  fi
  printf '%s  %s\n' "$expected" "$output" | sha256sum --check --status || {
    echo "归档文件 SHA-256 校验失败: $(basename "$output")" >&2
    exit 2
  }
}

fetch_archive "${WORKDADDY_NODE_ARCHIVE:-}" \
  "https://nodejs.org/dist/v22.23.1/$NODE_ARCHIVE_NAME" "$NODE_SHA256" "$TEMP/$NODE_ARCHIVE_NAME"
fetch_archive "${WORKDADDY_WS_ARCHIVE:-}" \
  "https://registry.npmjs.org/ws/-/$WS_ARCHIVE_NAME" "$WS_SHA256" "$TEMP/$WS_ARCHIVE_NAME"
mkdir -p "$TEMP/node"
tar -xJf "$TEMP/$NODE_ARCHIVE_NAME" -C "$TEMP/node"
cp "$TEMP/node/node-v22.23.1-linux-x64/bin/node" "$SCRIPTS/runtime/node/node"
cp "$TEMP/node/node-v22.23.1-linux-x64/LICENSE" "$SCRIPTS/runtime/node/LICENSE"
chmod 755 "$SCRIPTS/runtime/node/node"
tar -xzf "$TEMP/$WS_ARCHIVE_NAME" -C "$SCRIPTS/node_modules/ws" --strip-components=1

# Explicit source list: no account data, macOS bundle, repair prompt, tests or staging archives.
cp scripts/*.js "$SCRIPTS/"
cp scripts/*-linux.sh "$SCRIPTS/"
cp -R scripts/builtin "$SCRIPTS/builtin"
cp -R scripts/builtin-overrides "$SCRIPTS/builtin-overrides"
cp scripts/assets/workdaddy-logo.svg scripts/assets/workdaddy-app-icon-source.svg \
  scripts/assets/workbuddy-buddy-mark.svg "$SCRIPTS/assets/"
cp scripts/assets/workdaddy-icon-foreground.png \
  "$STAGE/usr/share/icons/hicolor/1024x1024/apps/workdaddy.png"
chmod 755 "$SCRIPTS/"*-linux.sh

"$SCRIPTS/runtime/node/node" - "$SCRIPTS/daemon.js" "$VERSION" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const version = process.argv[3];
let source = fs.readFileSync(file, 'utf8');
for (const [field, value] of [
  ['DAEMON_VERSION', version],
  ['DAEMON_BUILD_ID', `release-${version}-linux-deb`],
]) {
  const expression = new RegExp(`^const ${field} = '[^']+';`, 'm');
  if (!expression.test(source)) throw new Error(`缺少 ${field}`);
  source = source.replace(expression, `const ${field} = '${value}';`);
}
fs.writeFileSync(file, source);
NODE
"$SCRIPTS/runtime/node/node" --check "$SCRIPTS/daemon.js"
"$SCRIPTS/runtime/node/node" -e "require(process.argv[1]); require('node:sqlite')" "$SCRIPTS/node_modules/ws"

cat > "$STAGE/DEBIAN/control" <<EOF
Package: workdaddy
Version: $VERSION
Section: utils
Priority: optional
Architecture: amd64
Maintainer: WorkDaddy <babygoton@users.noreply.github.com>
Depends: libc6 (>= 2.28), libstdc++6, bash, curl, ca-certificates, procps, util-linux, xdg-utils, zenity
Description: WorkDaddy desktop enhancement for WorkBuddy
 Local CDP integration for separately installed WorkBuddy CN and WorkBuddy AI.
EOF

for profile in cn ai; do
  if [ "$profile" = cn ]; then name=WorkDaddy; else name='WorkDaddy AI'; fi
  cat > "$STAGE/usr/share/applications/workdaddy-$profile.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=$name
Exec=/opt/workdaddy/scripts/launch-gui-linux.sh $profile
TryExec=/opt/workdaddy/scripts/launch-gui-linux.sh
Icon=workdaddy
Terminal=false
Categories=Utility;
EOF
done

OUT="$ROOT/release/linux/WorkDaddy_${VERSION}_amd64.deb"
dpkg-deb --build --root-owner-group "$STAGE" "$OUT"
test "$(dpkg-deb --field "$OUT" Version)" = "$VERSION"
dpkg-deb --contents "$OUT" > "$TEMP/manifest"
grep -q '/opt/workdaddy/scripts/runtime/node/node$' "$TEMP/manifest"
grep -q '/opt/workdaddy/scripts/daemon.js$' "$TEMP/manifest"
if grep -q '安装失败自主解决提示词\|\.zip$' "$TEMP/manifest"; then
  echo '发行包包含禁止交付的文件' >&2
  exit 2
fi
mkdir -p "$TEMP/verify"
dpkg-deb --extract "$OUT" "$TEMP/verify"
grep -qx "const DAEMON_VERSION = '$VERSION';" "$TEMP/verify/opt/workdaddy/scripts/daemon.js"
"$TEMP/verify/opt/workdaddy/scripts/runtime/node/node" --check \
  "$TEMP/verify/opt/workdaddy/scripts/daemon.js"
echo "Linux 安装包: $OUT"
