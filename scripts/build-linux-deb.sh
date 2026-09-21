#!/usr/bin/env bash
# Build a self-contained Ubuntu/Debian amd64 package. macOS can cross-package it,
# but runtime verification still requires a Linux x86_64 host.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ]; then
  CROSS_PACKAGE=0
elif [ "$(uname -s)" = Darwin ]; then
  CROSS_PACKAGE=1
else
  echo '构建需要 Linux x86_64 或 macOS；运行验收仍需 Linux x86_64' >&2
  exit 2
fi
for command in curl tar; do
  command -v "$command" >/dev/null 2>&1 || { echo "缺少构建工具: $command" >&2; exit 2; }
done
if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
  echo '缺少 SHA-256 校验工具' >&2
  exit 2
fi
if [ "$CROSS_PACKAGE" = 1 ]; then
  for command in python3 node; do
    command -v "$command" >/dev/null 2>&1 || { echo "缺少交叉打包工具: $command" >&2; exit 2; }
  done
else
  command -v dpkg-deb >/dev/null 2>&1 || { echo '缺少构建工具: dpkg-deb' >&2; exit 2; }
fi

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
    curl --fail --location --http1.1 --retry 3 --retry-all-errors --silent --show-error "$url" -o "$output"
  fi
  local actual
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$output" | awk '{print $1}')"
  else
    actual="$(shasum -a 256 "$output" | awk '{print $1}')"
  fi
  [ "$actual" = "$expected" ] || {
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

BUILD_NODE="$SCRIPTS/runtime/node/node"
if [ "$CROSS_PACKAGE" = 1 ]; then BUILD_NODE="$(command -v node)"; fi
"$BUILD_NODE" - "$SCRIPTS/daemon.js" "$VERSION" <<'NODE'
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
"$BUILD_NODE" --check "$SCRIPTS/daemon.js"
"$BUILD_NODE" -e "require(process.argv[1]); require('node:sqlite')" "$SCRIPTS/node_modules/ws"

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
if [ "$CROSS_PACKAGE" = 1 ]; then
  python3 - "$STAGE" "$OUT" "$VERSION" <<'PY'
import pathlib
import sys
import tarfile
import tempfile

stage, output, version = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3]

def add_entry(archive, path, name):
    info = archive.gettarinfo(str(path), name)
    info.uid = info.gid = 0
    info.uname = info.gname = 'root'
    if info.isfile():
        with path.open('rb') as source:
            archive.addfile(info, source)
    else:
        archive.addfile(info)

def add_tree(archive, root, prefix='.'):
    for path in sorted(root.rglob('*')):
        add_entry(archive, path, prefix + '/' + path.relative_to(root).as_posix())

with tempfile.TemporaryDirectory() as tmp:
    control = pathlib.Path(tmp, 'control.tar.xz')
    data = pathlib.Path(tmp, 'data.tar.xz')
    with tarfile.open(control, 'w:xz') as archive:
        add_tree(archive, stage / 'DEBIAN')
    with tarfile.open(data, 'w:xz') as archive:
        for root in ('opt', 'usr'):
            add_entry(archive, stage / root, './' + root)
            add_tree(archive, stage / root, './' + root)
    with output.open('wb') as deb:
        deb.write(b'!<arch>\n')
        for name, contents in (('debian-binary', b'2.0\n'), ('control.tar.xz', control), ('data.tar.xz', data)):
            size = len(contents) if isinstance(contents, bytes) else contents.stat().st_size
            header = f'{name:<16}{0:<12}{0:<6}{0:<6}{"100644":<8}{size:<10}`\n'.encode('ascii')
            deb.write(header)
            if isinstance(contents, bytes):
                deb.write(contents)
            else:
                with contents.open('rb') as source:
                    while chunk := source.read(1024 * 1024):
                        deb.write(chunk)
            if size % 2:
                deb.write(b'\n')

    with output.open('rb') as deb:
        if deb.read(8) != b'!<arch>\n':
            raise SystemExit('Invalid Debian archive header')
        for expected in ('debian-binary', 'control.tar.xz', 'data.tar.xz'):
            header = deb.read(60)
            if header[:16].decode('ascii').strip() != expected or header[58:] != b'`\n':
                raise SystemExit(f'Invalid Debian archive member: {expected}')
            size = int(header[48:58].decode('ascii').strip())
            deb.seek(size + size % 2, 1)

    if version != next(line.split(': ', 1)[1] for line in (stage / 'DEBIAN/control').read_text().splitlines() if line.startswith('Version: ')):
        raise SystemExit('Debian metadata version mismatch')
    with tarfile.open(data, 'r:xz') as archive:
        names = archive.getnames()
        for required in ('./opt/workdaddy/scripts/runtime/node/node', './opt/workdaddy/scripts/daemon.js'):
            if required not in names:
                raise SystemExit(f'Missing payload file: {required}')
        if any('安装失败自主解决提示词' in name or name.endswith('.zip') for name in names):
            raise SystemExit('Forbidden payload file')
        daemon = archive.extractfile('./opt/workdaddy/scripts/daemon.js').read().decode()
        node = archive.extractfile('./opt/workdaddy/scripts/runtime/node/node').read(5)
        if f"const DAEMON_VERSION = '{version}';" not in daemon or node != b'\x7fELF\x02':
            raise SystemExit('Payload version or Linux x64 runtime mismatch')
PY
else
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
fi
echo "Linux 安装包: $OUT"
