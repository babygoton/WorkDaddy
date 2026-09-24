#!/usr/bin/env bash
# Build a self-contained Ubuntu/Debian amd64 or arm64 package. macOS and a
# different-architecture Linux host can cross-package it; runtime verification
# still requires a matching Linux host.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
DEB_ARCH="${WORKDADDY_BUILD_ARCH:-amd64}"
case "$DEB_ARCH" in
  amd64)
    NODE_ARCH=x64
    NODE_SHA256=9749e988f437343b7fa832c69ded82a312e41a03116d766797ac14f6f9eee578
    ELF_MACHINE_HEX=3e00
    ;;
  arm64)
    NODE_ARCH=arm64
    NODE_SHA256=0294e8b915ab75f92c7513d2fcb830ae06e10684e6c603e99a87dbf8835389c1
    ELF_MACHINE_HEX=b700
    ;;
  *)
    echo "不支持的 Linux 架构: $DEB_ARCH（仅支持 amd64/arm64）" >&2
    exit 2
    ;;
esac

HOST_ARCH="$(uname -m)"
case "$HOST_ARCH" in
  x86_64|amd64) HOST_DEB_ARCH=amd64 ;;
  aarch64|arm64) HOST_DEB_ARCH=arm64 ;;
  *) HOST_DEB_ARCH=unknown ;;
esac
if [ "$(uname -s)" = Linux ] && [ "$HOST_DEB_ARCH" != unknown ]; then
  CROSS_PACKAGE=0
elif [ "$(uname -s)" = Darwin ]; then
  CROSS_PACKAGE=1
else
  echo '构建需要 Linux x86_64/aarch64 或 macOS；运行验收仍需同架构 Linux' >&2
  exit 2
fi
CAN_RUN_BUNDLED=0
if [ "$(uname -s)" = Linux ] && [ "$HOST_DEB_ARCH" = "$DEB_ARCH" ]; then CAN_RUN_BUNDLED=1; fi
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
  if [ "$CAN_RUN_BUNDLED" = 0 ]; then
    command -v node >/dev/null 2>&1 || { echo '交叉架构构建需要主机 Node.js' >&2; exit 2; }
  fi
fi

SOURCE_VERSION="$(sed -n "s/^const DAEMON_VERSION = '\([^']*\)';/\1/p" scripts/daemon.js | head -1)"
VERSION="${WORKDADDY_BUILD_VERSION:-$SOURCE_VERSION}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "版本号必须是 x.y.z: $VERSION" >&2
  exit 2
fi

NODE_ARCHIVE_NAME=node-v22.23.1-linux-$NODE_ARCH.tar.xz
WS_ARCHIVE_NAME=ws-8.18.3.tgz
WS_SHA256=424be604c8e7926fc29a1f067bf2dac256af3bcea62fe30395018bbaf8a9be2a
TEMP="$(mktemp -d)"
trap 'rm -rf -- "$TEMP"' EXIT
COMMON="$TEMP/common"
COMMON_SCRIPTS="$COMMON/opt/workdaddy/scripts"
mkdir -p "$COMMON_SCRIPTS/runtime/node" "$COMMON_SCRIPTS/node_modules/ws" "$COMMON_SCRIPTS/assets" \
  "$COMMON/usr/share/icons/hicolor/1024x1024/apps" release/linux

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
cp "$TEMP/node/node-v22.23.1-linux-$NODE_ARCH/bin/node" "$COMMON_SCRIPTS/runtime/node/node"
cp "$TEMP/node/node-v22.23.1-linux-$NODE_ARCH/LICENSE" "$COMMON_SCRIPTS/runtime/node/LICENSE"
chmod 755 "$COMMON_SCRIPTS/runtime/node/node"
tar -xzf "$TEMP/$WS_ARCHIVE_NAME" -C "$COMMON_SCRIPTS/node_modules/ws" --strip-components=1

# Explicit source list: no account data, macOS bundle, repair prompt, tests or staging archives.
cp scripts/*.js "$COMMON_SCRIPTS/"
cp scripts/*-linux.sh "$COMMON_SCRIPTS/"
cp -R scripts/builtin "$COMMON_SCRIPTS/builtin"
cp -R scripts/builtin-overrides "$COMMON_SCRIPTS/builtin-overrides"
cp scripts/assets/workdaddy-logo.svg scripts/assets/workdaddy-app-icon-source.svg \
  scripts/assets/workbuddy-buddy-mark.svg "$COMMON_SCRIPTS/assets/"
cp scripts/assets/workdaddy-icon-foreground.png \
  "$COMMON/usr/share/icons/hicolor/1024x1024/apps/workdaddy.png"
chmod 755 "$COMMON_SCRIPTS/"*-linux.sh

BUILD_NODE="$COMMON_SCRIPTS/runtime/node/node"
if [ "$CAN_RUN_BUNDLED" = 0 ]; then BUILD_NODE="$(command -v node)"; fi
"$BUILD_NODE" - "$COMMON_SCRIPTS/daemon.js" "$VERSION" <<'NODE'
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
"$BUILD_NODE" --check "$COMMON_SCRIPTS/daemon.js"
"$BUILD_NODE" -e "require(process.argv[1]); require('node:sqlite')" "$COMMON_SCRIPTS/node_modules/ws"

build_package() {
  local profile="$1" package_name="$2" install_root="$3" display_name="$4" output_name="$5"
  local stage="$TEMP/stage-$profile"
  local scripts="$stage$install_root/scripts"
  mkdir -p "$scripts" "$stage/DEBIAN" "$stage/usr/share/applications" \
    "$stage/usr/share/icons/hicolor/1024x1024/apps"
  cp -R "$COMMON/opt/workdaddy/scripts/." "$scripts/"
  cp "$COMMON/usr/share/icons/hicolor/1024x1024/apps/workdaddy.png" \
    "$stage/usr/share/icons/hicolor/1024x1024/apps/workdaddy-$profile.png"
  chmod 755 "$scripts/"*-linux.sh

  cat > "$stage/DEBIAN/control" <<EOF
Package: $package_name
Version: $VERSION
Section: utils
Priority: optional
Architecture: $DEB_ARCH
Maintainer: WorkDaddy <babygoton@users.noreply.github.com>
Depends: libc6 (>= 2.28), libstdc++6, bash, curl, ca-certificates, procps, util-linux, xdg-utils, zenity
Description: $display_name desktop enhancement for WorkBuddy
 Local CDP integration for the separately installed $display_name client.
EOF

  cat > "$stage/usr/share/applications/workdaddy-$profile.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=$display_name
Exec=$install_root/scripts/launch-gui-linux.sh $profile
TryExec=$install_root/scripts/launch-gui-linux.sh
Icon=workdaddy-$profile
Terminal=false
Categories=Utility;
EOF

  local out="$ROOT/release/linux/$output_name"
  if [ "$CROSS_PACKAGE" = 1 ]; then
    python3 - "$stage" "$out" "$VERSION" "$install_root" "$package_name" "$DEB_ARCH" <<'PY'
import pathlib
import sys
import tarfile
import tempfile

stage, output, version, install_root, package_name, architecture = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6]

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
    if package_name != next(line.split(': ', 1)[1] for line in (stage / 'DEBIAN/control').read_text().splitlines() if line.startswith('Package: ')):
        raise SystemExit('Debian metadata package mismatch')
    with tarfile.open(data, 'r:xz') as archive:
        names = archive.getnames()
        prefix = './' + install_root.lstrip('/') + '/scripts/'
        for required in (prefix + 'runtime/node/node', prefix + 'daemon.js'):
            if required not in names:
                raise SystemExit(f'Missing payload file: {required}')
        if any('安装失败自主解决提示词' in name or name.endswith('.zip') for name in names):
            raise SystemExit('Forbidden payload file')
        daemon = archive.extractfile(prefix + 'daemon.js').read().decode()
        node = archive.extractfile(prefix + 'runtime/node/node').read(20)
        expected_machine = {'amd64': 62, 'arm64': 183}[architecture]
        actual_machine = int.from_bytes(node[18:20], 'little') if node[:5] == b'\x7fELF\x02' else -1
        if f"const DAEMON_VERSION = '{version}';" not in daemon or actual_machine != expected_machine:
            raise SystemExit('Payload version or Linux runtime architecture mismatch')
PY
  else
    dpkg-deb --build --root-owner-group "$stage" "$out"
    test "$(dpkg-deb --field "$out" Version)" = "$VERSION"
    test "$(dpkg-deb --field "$out" Package)" = "$package_name"
    dpkg-deb --contents "$out" > "$TEMP/manifest-$profile"
    grep -q "$install_root/scripts/runtime/node/node$" "$TEMP/manifest-$profile"
    grep -q "$install_root/scripts/daemon.js$" "$TEMP/manifest-$profile"
    if grep -q '安装失败自主解决提示词\|\.zip$' "$TEMP/manifest-$profile"; then
      echo '发行包包含禁止交付的文件' >&2
      exit 2
    fi
    local verify="$TEMP/verify-$profile"
    mkdir -p "$verify"
    dpkg-deb --extract "$out" "$verify"
    grep -qx "const DAEMON_VERSION = '$VERSION';" "$verify$install_root/scripts/daemon.js"
    local machine_hex
    machine_hex="$(od -An -tx1 -j18 -N2 "$verify$install_root/scripts/runtime/node/node" | tr -d ' \n')"
    [ "$machine_hex" = "$ELF_MACHINE_HEX" ] || { echo "Node 运行时架构错误: $machine_hex" >&2; exit 2; }
    if [ "$CAN_RUN_BUNDLED" = 1 ]; then
      "$verify$install_root/scripts/runtime/node/node" --check "$verify$install_root/scripts/daemon.js"
    else
      node --check "$verify$install_root/scripts/daemon.js"
    fi
  fi
  echo "Linux 安装包: $out"
}

build_package cn workdaddy /opt/workdaddy 'WorkDaddy' "WorkDaddy_${VERSION}_${DEB_ARCH}.deb"
build_package ai workdaddy-ai /opt/workdaddy-ai 'WorkDaddy AI' "WorkDaddy-AI_${VERSION}_${DEB_ARCH}.deb"
