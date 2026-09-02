#!/usr/bin/env bash
# WorkDaddy Windows 安装暂存脚本（在 macOS/Linux/Windows Git Bash 上运行）
# 产出的是供 build-win-installer.ps1 消费的临时 ZIP；Windows 正式发行只交付 Setup.exe，
# 安装器完成后会删除该暂存 ZIP，旧 ZIP 仅由更新器兼容读取历史版本。
# 可选：内置 node_modules/ws（面板 DevTools 代理依赖；无则代理功能降级，其余功能不受影响）
set -euo pipefail

# Git Bash on a clean Windows machine may expose a Microsoft Store python3
# stub that exits without running Python.  Accept an explicit interpreter and
# otherwise select the first candidate that can execute a tiny import check.
PYTHON_BIN="${WORKDADDY_PYTHON:-}"
if [ -z "$PYTHON_BIN" ]; then
  for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys' >/dev/null 2>&1; then
      PYTHON_BIN="$candidate"
      break
    fi
  done
fi
if [ -z "$PYTHON_BIN" ]; then
  echo "错误：缺少可用 Python（可设置 WORKDADDY_PYTHON 指向 python.exe）" >&2
  exit 2
fi

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"
mkdir -p release/windows

# 兼容 Windows Git Bash：原生 python3 需要 Windows 风格路径（/c/... → C:\...）
if command -v cygpath >/dev/null 2>&1; then
  winpath() { cygpath -w "$1"; }
else
  winpath() { printf '%s\n' "$1"; }
fi

VERSION="${WORKDADDY_BUILD_VERSION:-$(grep -o "DAEMON_VERSION = '[^']*'" scripts/daemon.js | head -1 | cut -d"'" -f2)}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "错误：发布版本必须是 x.y.z，实际为 ${VERSION}" >&2
  exit 2
fi
PROFILE="${WORKDADDY_BUILD_PROFILE:-}"
if [ -z "$PROFILE" ]; then
  for profile in workbuddy-cn workbuddy-ai; do
    WORKDADDY_BUILD_PROFILE="$profile" bash "$0"
  done
  exit 0
fi
case "$PROFILE" in
  workbuddy-ai) PACKAGE_NAME="WorkDaddy AI"; OUT="release/windows/WorkDaddy-AI-${VERSION}-win64.zip" ;;
  *) PROFILE="workbuddy-cn"; PACKAGE_NAME="WorkDaddy"; OUT="release/windows/WorkDaddy-${VERSION}-win64.zip" ;;
esac

echo "==> profile: ${PROFILE}"
echo "==> 版本: ${VERSION}"
echo "==> 产物: ${OUT}"

# 发行包必须自带固定 Node 运行时；不能把 WorkBuddy 的私有运行时目录当成用户环境依赖。
# 版本、下载地址和校验值与 Dream Skin 的 Windows 打包策略一致，允许通过
# WORKDADDY_NODE_ARCHIVE 指向预下载压缩包以支持离线/受限网络构建。
NODE_VERSION="${WORKDADDY_NODE_VERSION:-22.23.1}"
NODE_ARCHIVE="node-v${NODE_VERSION}-win-x64.zip"
NODE_URL="${WORKDADDY_NODE_URL:-https://npmmirror.com/mirrors/node/v${NODE_VERSION}/${NODE_ARCHIVE}}"
NODE_SHA256="7df0bc9375723f4a86b3aa1b7cc73342423d9677a8df4538aca31a049e309c29"
NODE_CACHE="${WORKDADDY_NODE_CACHE:-$DIR/release/.cache}"
mkdir -p "$NODE_CACHE"

# 正式 Windows 入口是自包含原生 EXE。它负责标准权限、单实例、原生对话框和
# 精确进程检测；普通启动不再经过 cmd/vbs/PowerShell/CIM。
GO_BIN="${WORKDADDY_GO:-go}"
if ! command -v "$GO_BIN" >/dev/null 2>&1 && [ ! -x "$GO_BIN" ]; then
  echo "错误：缺少 Go 1.24+（可设置 WORKDADDY_GO 指向 go.exe）" >&2
  exit 2
fi
NATIVE_LAUNCHER="$NODE_CACHE/WorkDaddyLauncher.exe"
echo "==> 编译原生 Windows 启动器"
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 "$GO_BIN" build -trimpath \
  -ldflags '-s -w -H=windowsgui' -o "$NATIVE_LAUNCHER" ./scripts/windows-native/main.go
test -s "$NATIVE_LAUNCHER"
NODE_ARCHIVE_PATH="${WORKDADDY_NODE_ARCHIVE:-$NODE_CACHE/$NODE_ARCHIVE}"
if [ ! -f "$NODE_ARCHIVE_PATH" ]; then
  echo "==> 下载 Node.js v${NODE_VERSION} Windows x64 运行时"
  curl --fail --location --retry 3 --retry-delay 2 --silent --show-error "$NODE_URL" -o "$NODE_ARCHIVE_PATH"
fi
if command -v shasum >/dev/null 2>&1; then
  NODE_ACTUAL_SHA256="$(shasum -a 256 "$NODE_ARCHIVE_PATH" | awk '{print $1}')"
elif command -v sha256sum >/dev/null 2>&1; then
  NODE_ACTUAL_SHA256="$(sha256sum "$NODE_ARCHIVE_PATH" | awk '{print $1}')"
else
  echo "错误：缺少 shasum/sha256sum，无法验证 Node.js 运行时" >&2
  exit 2
fi
if [ "$NODE_ACTUAL_SHA256" != "$NODE_SHA256" ]; then
  echo "错误：Node.js 运行时 SHA-256 不匹配，期望 ${NODE_SHA256}，实际 ${NODE_ACTUAL_SHA256}" >&2
  exit 2
fi
echo "==> Node.js 运行时校验通过: ${NODE_ARCHIVE}"

# 1) 内置 ws（面板 DevTools 代理需要）；已存在则跳过
if [ ! -d scripts/node_modules/ws ]; then
  echo "==> 生成 node_modules/ws（DevTools 代理依赖）"
  TMPNODE="$(mktemp -d)"
  (cd "$TMPNODE" && npm init -y >/dev/null 2>&1 && npm install ws --no-audit --no-fund >/dev/null 2>&1)
  mkdir -p scripts/node_modules
  rm -rf scripts/node_modules/ws
  mv "$TMPNODE/node_modules/ws" scripts/node_modules/ws
  rm -rf "$TMPNODE"
fi

# 2) 内置资产（官方壁纸 + nebula 主题）。这些文件必须随源码进入构建上下文，
#    不能依赖被 .gitignore 排除的 WorkDaddy.app；否则干净的 Windows CI 会产出
#    安装成功但主题面板为空的安装包。
BUILTIN_SRC="$DIR/scripts/builtin"
if [ ! -f "$BUILTIN_SRC/nebula/theme.json" ] || [ ! -d "$BUILTIN_SRC/wallpapers" ]; then
  echo "错误：缺少内置资产 $BUILTIN_SRC（需要 nebula/theme.json 和 wallpapers/）" >&2
  exit 2
fi
BUILTIN_WALLPAPER_COUNT="$(find "$BUILTIN_SRC/wallpapers" -maxdepth 1 -type f -iname '*.webp' | wc -l | tr -d ' ')"
if [ "$BUILTIN_WALLPAPER_COUNT" -lt 1 ]; then
  echo "错误：内置资产没有任何官方壁纸：$BUILTIN_SRC/wallpapers" >&2
  exit 2
fi
echo "==> 内置资产校验通过：${BUILTIN_WALLPAPER_COUNT} 张壁纸 + nebula 主题"

# 3) 打包：staging 目录，把两个顶层入口文件 + scripts/ 一起打进 zip 根（解压即见一键安装/启动）
#    注意 apply-update.ps1 复用本结构（需 zip 内存在 scripts\daemon.js 做 srcRoot 判定）
STAGE="$(mktemp -d)"
# 清理旧的同名输出（zip 打开 w 模式会覆盖，因此 rm 仅兜底已存在的旧文件；失败不再中断打包）
if [ -f "$OUT" ]; then
  rm -f "$OUT" || true
fi
# 3.1) 顶层入口（zip 根）：Install-WorkDaddy.cmd / Start-WorkDaddy.cmd
cp scripts/Install-WorkDaddy.cmd "$STAGE/Install-WorkDaddy.cmd"
cp scripts/Start-WorkDaddy.cmd "$STAGE/Start-WorkDaddy.cmd"
# 3.2) scripts\ 本体（含 node_modules/ws、builtin）
cp -R scripts "$STAGE/scripts"
# 以已校验的仓库资产为准，避免工作树里残留的临时目录进入安装包。
rm -rf "$STAGE/scripts/builtin"
mkdir -p "$STAGE/scripts/builtin"
cp -R "$BUILTIN_SRC/." "$STAGE/scripts/builtin/"
cp "$NATIVE_LAUNCHER" "$STAGE/WorkDaddyLauncher.exe"
printf '%s\n' "$PROFILE" > "$STAGE/scripts/profile-id.txt"
echo "==> 原生入口: WorkDaddyLauncher.exe (${PROFILE})"
# Windows cmd.exe expects CRLF in batch files.  Normalise every staged .cmd
# after copying so a source edit made on macOS cannot leave a mixed-ending
# launcher that silently stops before invoking Node.
"$PYTHON_BIN" - "$(winpath "$STAGE")" <<'PY'
import os
import sys

stage = sys.argv[1]
for root, _, files in os.walk(stage):
    for name in files:
        if not name.lower().endswith('.cmd'):
            continue
        path = os.path.join(root, name)
        with open(path, 'rb') as f:
            text = f.read().decode('utf-8-sig')
        text = text.replace('\r\n', '\n').replace('\r', '\n')
        with open(path, 'w', encoding='utf-8', newline='') as f:
            f.write(text.replace('\n', '\r\n'))
PY
# 3.2b) 只提取 Node 可执行文件和许可证，避免把完整开发压缩包放进用户包。
"$PYTHON_BIN" - "$(winpath "$NODE_ARCHIVE_PATH")" "$(winpath "$STAGE/scripts/runtime/node")" <<'PY'
import os
import sys
import zipfile

archive_path, destination = sys.argv[1:]
with zipfile.ZipFile(archive_path) as archive:
    names = archive.namelist()
    root = next((name.split('/')[0] for name in names if name.endswith('/node.exe')), None)
    if not root:
        raise SystemExit('Node.js archive missing node.exe')
    os.makedirs(destination, exist_ok=True)
    for entry_name, output_name in ((f'{root}/node.exe', 'node.exe'), (f'{root}/LICENSE', 'LICENSE')):
        try:
            info = archive.getinfo(entry_name)
        except KeyError:
            raise SystemExit(f'Node.js archive missing {entry_name}')
        if info.file_size <= 0:
            raise SystemExit(f'Node.js archive entry is empty: {entry_name}')
        with archive.open(info) as source, open(os.path.join(destination, output_name), 'wb') as target:
            target.write(source.read())
PY
test -s "$STAGE/scripts/runtime/node/node.exe"
test -s "$STAGE/scripts/runtime/node/LICENSE"
echo "==> 内置 Node.js: scripts/runtime/node/node.exe"
# 发布版使用当前 override 替换第 6 张壁纸及 nebula 背景；只修改暂存目录，
# 不触碰仓库内的正式资源。
WALLPAPER_OVERRIDE="$DIR/scripts/builtin-overrides/wallpaper-06.webp"
if [ -f "$WALLPAPER_OVERRIDE" ]; then
  cp "$WALLPAPER_OVERRIDE" "$STAGE/scripts/builtin/wallpapers/wallpaper-06.webp"
  cp "$WALLPAPER_OVERRIDE" "$STAGE/scripts/builtin/nebula/background.webp"
fi
test -f "$STAGE/scripts/builtin/nebula/theme.json"
test -n "$(find "$STAGE/scripts/builtin/wallpapers" -maxdepth 1 -type f -iname '*.webp' -print -quit)"
# 3.2a) 打包期 profile 替换（统一用 python3，mac/win 均可用）：
#       1) win-launcher.js 默认 profile
#       2) 三个 ps1 仅替换 param 默认值处的占位符（[string]$Profile = '...'），
#          绝不能全局替换 __WBS_DEFAULT_PROFILE__ —— 否则判断条件
#          $Profile -eq '__WBS_DEFAULT_PROFILE__' 会被替换成 $Profile -eq 'workbuddy-ai'，
#          让 AI 包默认 profile 自身触发"回退到 workbuddy-cn"，桌面快捷方式名/安装目录全部错乱。
PROFILE="$PROFILE" BUILD_VERSION="$VERSION" "$PYTHON_BIN" - "$(winpath "$STAGE/scripts")" <<'PY'
import os
import re
import sys

scripts = sys.argv[1]
profile = os.environ['PROFILE']
build_version = os.environ.get('BUILD_VERSION', '')

# win-launcher.js：默认 profile（仅当源码仍是 || 'workbuddy-cn' 时替换）
wl = os.path.join(scripts, 'win-launcher.js')
with open(wl, encoding='utf-8') as f:
    s = f.read()
old = "process.env.WBSWITCH_PROFILE || 'workbuddy-cn'"
new = "process.env.WBSWITCH_PROFILE || '%s'" % profile
if old in s:
    s = s.replace(old, new, 1)
with open(wl, 'w', encoding='utf-8', newline='') as f:
    f.write(s)

# 每个产物都强制同步 daemon 版本，避免 app 壳残留旧 daemon（例如 1.0.6）导致
# 文件名/Info.plist 是新版本但实际运行代码仍报告旧版本。
daemon = os.path.join(scripts, 'daemon.js')
with open(daemon, encoding='utf-8') as f:
    s = f.read()
s = re.sub(r"(const DAEMON_VERSION = ')[^']+(';)", r"\g<1>" + build_version + r"\g<2>", s, count=1)

# Build ID 也必须跟随发布版本。保留日期/功能后缀用于区分同版本构建，
# 只替换 release- 后面的 x.y.z，避免旧源码残留例如 release-1.0.13。
build_id = re.search(r"const DAEMON_BUILD_ID = '([^']+)'", s)
if not build_id:
    raise SystemExit('daemon.js 缺少 DAEMON_BUILD_ID')
current_build_id = build_id.group(1)
if current_build_id.startswith('release-'):
    suffix = current_build_id[len('release-'):]
    suffix = re.sub(r'^\d+\.\d+\.\d+(?=-|$)', build_version, suffix, count=1)
    next_build_id = 'release-' + suffix
else:
    raise SystemExit('DAEMON_BUILD_ID 格式必须为 release-x.y.z-...')
s = re.sub(r"(const DAEMON_BUILD_ID = ')[^']+(';)", r"\g<1>" + next_build_id + r"\g<2>", s, count=1)
with open(daemon, 'w', encoding='utf-8', newline='') as f:
    f.write(s)

if not re.search(r"const DAEMON_VERSION = '" + re.escape(build_version) + r"';", s):
    raise SystemExit('staged daemon.js DAEMON_VERSION 与包版本不一致')
if not re.search(r"const DAEMON_BUILD_ID = 'release-" + re.escape(build_version) + r"(?:-[^']*)?';", s):
    raise SystemExit('staged daemon.js DAEMON_BUILD_ID 与包版本不一致')

# 同步可选 package.json 的版本元数据，避免旧壳版本覆盖关于页展示。
package_json = os.path.join(scripts, 'package.json')
if build_version and os.path.exists(package_json):
    with open(package_json, encoding='utf-8') as f:
        s = f.read()
    s = re.sub(r'("version"\s*:\s*")[^"]+(")', r'\g<1>' + build_version + r'\g<2>', s, count=1)
    with open(package_json, 'w', encoding='utf-8', newline='') as f:
        f.write(s)

# 三个 ps1：只替换 param 默认值（[string]$Profile = '__WBS_DEFAULT_PROFILE__'）。
# 写回必须用 utf-8-sig（保留 UTF-8 BOM）：源 ps1 带 BOM，Windows PowerShell/ISE 依赖
# BOM 识别 UTF-8；一旦写成无 BOM 的 UTF-8，会被按 ANSI 代码页解析中文 → 乱码语法报错。
for name in ('install-win.ps1', 'uninstall-win.ps1', 'apply-update.ps1'):
    p = os.path.join(scripts, name)
    with open(p, encoding='utf-8-sig') as f:
        s = f.read()
    pat = "[string]$Profile = '__WBS_DEFAULT_PROFILE__'"
    if pat in s:
        s = s.replace(pat, "[string]$Profile = '%s'" % profile, 1)
    with open(p, 'w', encoding='utf-8-sig', newline='') as f:
        f.write(s)
PY
# 3.2a) Logo 图标：放入 scripts\（install-win.ps1 从 SrcDir 同名找并复制到安装目录根）
if [ -f "$DIR/release/WorkDaddy.ico" ]; then
  cp "$DIR/release/WorkDaddy.ico" "$STAGE/scripts/WorkDaddy.ico"
  echo "==> 内置 logo 图标 -> scripts/WorkDaddy.ico"
else
  echo "==> 警告: 未找到 release/WorkDaddy.ico，桌面图标将回退为 cmd 默认"
fi
# 3.3) 排除开发/临时文件 + 顶层入口在 scripts\ 内的重复副本
#      （Install-WorkDaddy.cmd / Start-WorkDaddy.cmd 只应存在于 zip 根，避免用户误进
#       scripts\ 双击导致相对路径解析成 scripts\scripts\install-win.ps1 报错）
rm -rf "$STAGE/scripts/win/probe" "$STAGE/scripts/win/probe/"* 2>/dev/null || true
rm -f "$STAGE/scripts/Install-WorkDaddy.cmd" "$STAGE/scripts/Start-WorkDaddy.cmd" 2>/dev/null || true
find "$STAGE" -name '*.log' -delete 2>/dev/null || true
find "$STAGE" -name '.DS_Store' -delete 2>/dev/null || true
# 3.3a) AI 包品牌化：cmd 描述/桌面图标/安装目录名跟随工包显示为 WorkDaddy AI
#       （仅 workbuddy-ai；CN 包保持 WorkDaddy。文件名 Install-WorkDaddy.cmd、
#        数据目录 %APPDATA%\WorkDaddy、WorkDaddy.ico 不随包变，保持原样。）
if [ "$PROFILE" = "workbuddy-ai" ]; then
  echo "==> AI 包品牌化：cmd 描述 / 桌面图标 / 安装目录名 → WorkDaddy AI"
"$PYTHON_BIN" - "$(winpath "$STAGE")" <<'PY'
import os
import sys

stage = sys.argv[1]

def patch(path, pairs):
    p = os.path.join(stage, path)
    if not os.path.exists(p):
        return
    with open(p, 'rb') as f:
        raw = f.read()
    has_bom = raw.startswith(b'\xef\xbb\xbf')
    s = raw.decode('utf-8-sig')
    for old, new in pairs:
        if old in s:
            s = s.replace(old, new)
    encoded = s.encode('utf-8')
    with open(p, 'wb') as f:
        f.write((b'\xef\xbb\xbf' if has_bom else b'') + encoded)

# zip 根两个入口 cmd
patch('Install-WorkDaddy.cmd', [
    ('WorkDaddy 一键安装', 'WorkDaddy AI 一键安装'),
    (r'%LOCALAPPDATA%\Programs\WorkDaddy', r'%LOCALAPPDATA%\Programs\WorkDaddy AI'),
    ('extracted WorkDaddy zip', 'extracted WorkDaddy AI zip'),
])
patch('Start-WorkDaddy.cmd', [
    ('WorkDaddy 一键启动', 'WorkDaddy AI 一键启动'),
    ('「WorkDaddy」图标', '「WorkDaddy AI」图标'),
    ('WorkDaddy launcher starting', 'WorkDaddy AI launcher starting'),
])
# scripts\ 内安装/启动/自检脚本（%LOCALAPPDATA%\Programs\WorkDaddy → WorkDaddy AI；数据目录不替换）
patch('scripts/install-win.cmd', [
    ('WorkDaddy Windows 安装核心', 'WorkDaddy AI Windows 安装核心'),
    # 成功提示 base64（WorkDaddy → WorkDaddy AI、WorkBuddy → WorkBuddy AI）
    ('5a6J6KOF5a6M5oiQ44CCV29ya0J1ZGR5IOWNs+WwhuS7peiwg+ivleaooeW8j+mHjeWQr++8jOivt+eojeetieeJh+WIu+OAgg==',
     '5a6J6KOF5a6M5oiQ44CCV29ya0J1ZGR5IEFJIOWNs+WwhuS7peiwg+ivleaooeW8j+mHjeWQr++8jOivt+eojeetieeJh+WIu+OAgg=='),
    ('6K+35omL5Yqo5YWz6Zet5b2T5YmN56qX5Y+j77yM5bm25YmN5b6A5qGM6Z2i5Y+z6ZSuIFdvcmtEYWRkeSDlv6vmjbfmlrnlvI/vvIzngrnlh7vku6XnrqHnkIblkZjouqvku73ov5DooYzvvIzmhJ/osKLkvb/nlKjvvZ4=',
     '6K+35omL5Yqo5YWz6Zet5b2T5YmN56qX5Y+j77yM5bm25YmN5b6A5qGM6Z2i5Y+z6ZSuIFdvcmtEYWRkeSBBSSDlv6vmjbfmlrnlvI/vvIzngrnlh7vku6XnrqHnkIblkZjouqvku73ov5DooYzvvIzmhJ/osKLkvb/nlKjvvZ4='),
])
patch('scripts/launcher.cmd', [
    ('WorkDaddy Windows 启动器', 'WorkDaddy AI Windows 启动器'),
    ('WorkDaddy launcher starting', 'WorkDaddy AI launcher starting'),
    ('Done: WorkDaddy is ready', 'Done: WorkDaddy AI is ready'),
])
patch('scripts/verify-win.cmd', [
    ('WorkDaddy Windows 安装包自检', 'WorkDaddy AI Windows 安装包自检'),
    ('WorkDaddy 安装包自检', 'WorkDaddy AI 安装包自检'),
    (r'%LOCALAPPDATA%\Programs\WorkDaddy', r'%LOCALAPPDATA%\Programs\WorkDaddy AI'),
    (r'Desktop\WorkDaddy.lnk', r'Desktop\WorkDaddy AI.lnk'),
    ('桌面已有 WorkDaddy 图标', '桌面已有 WorkDaddy AI 图标'),
])
print('==>  品牌化替换完成（Install/Start/install-win/launcher/verify-win + base64 提示）')
PY
fi
# 3.3.5) 非 ASCII 文件名守护：Windows 安装包路径必须保持 ASCII。
#        macOS 自带 Info-ZIP 会使用 UTF-8 条目写入；安装/更新脚本本身仍全部使用 ASCII 路径。
NON_ASCII_PATHS="$(find "$STAGE" -not -path '*/node_modules/*' 2>/dev/null | LC_ALL=C grep '[^ -~]' || true)"
if [ -n "$NON_ASCII_PATHS" ]; then
  echo "==> ERROR: 发布包包含非 ASCII 文件路径，已终止打包！"
  printf '%s\n' "$NON_ASCII_PATHS" | head -20
  rm -rf "$STAGE" 2>/dev/null || true
  exit 3
fi
echo "==> 非 ASCII 文件名守护通过"
# 3.4) 打包：优先使用 Python zipfile，确保 Windows 条目编码稳定。
#      macOS 自带 zip 会把非 ASCII 文件名按本地代码页写入，Windows/Python 解压后会出现乱码。
if [ -n "$PYTHON_BIN" ]; then
  "$PYTHON_BIN" - "$(winpath "$STAGE")" "$(winpath "$DIR/$OUT")" <<'PY'
import os
import sys
import zipfile

stage, output = sys.argv[1:]
with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    for root, dirs, files in os.walk(stage):
        dirs.sort()
        files.sort()
        for name in dirs:
            source = os.path.join(root, name)
            arcname = os.path.relpath(source, stage).replace(os.sep, '/') + '/'
            archive.write(source, arcname)
        for name in files:
            source = os.path.join(root, name)
            arcname = os.path.relpath(source, stage).replace(os.sep, '/')
            archive.write(source, arcname)
PY
    elif command -v zip >/dev/null 2>&1; then
  (cd "$STAGE" && zip -r -q "$DIR/$OUT" .)
else
  tar -a -cf "$DIR/$OUT" -C "$STAGE" .
fi
# 3.5) 清理 staging（Windows Git Bash 下 rm 可能触发安全删除钩子导致非零退出；改用 find -delete 兜底）
if [ -d "$STAGE" ]; then
  find "$STAGE" -depth -delete 2>/dev/null || rm -rf "$STAGE" || true
fi

echo "==> 安装暂存包完成: $(ls -lh "$OUT" | awk '{print $5}')"
echo "==> 下一步由 build-win-installer.ps1 生成 Setup.exe；正式发行不保留该 ZIP。"
