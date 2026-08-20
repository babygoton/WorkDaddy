#!/usr/bin/env bash
# WorkDaddy Windows 发布包打包脚本（在 macOS/Linux/Git Bash 上运行即可产出 Windows zip）
# 产出：release/WorkDaddy-<ver>-win64.zip（顶层含 scripts\，供 install-win.cmd / apply-update.ps1 使用）
# 可选：内置 node_modules/ws（面板 DevTools 代理依赖；无则代理功能降级，其余功能不受影响）
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

VERSION="$(grep -o "DAEMON_VERSION = '[^']*'" scripts/daemon.js | head -1 | cut -d"'" -f2)"
OUT="release/WorkDaddy-${VERSION}-win64.zip"

echo "==> 版本: ${VERSION}"
echo "==> 产物: ${OUT}"

STAGE="$(mktemp -d)"
TMPNODE=""
cleanup() {
  rm -rf "$STAGE"
  if [ -n "$TMPNODE" ]; then rm -rf "$TMPNODE"; fi
}
trap cleanup EXIT

# 1) 内置资产来源（若本次 checkout 没有 macOS app，则 Windows 包按无内置壁纸模式发布）。
BUILTIN_SRC="$DIR/WorkDaddy.app/Contents/Resources/scripts/builtin"

# 2) 打包：staging 目录，把两个顶层入口文件 + scripts/ 一起打进 zip 根（解压即见一键安装/启动）
#    注意 apply-update.ps1 复用本结构（需 zip 内存在 scripts\daemon.js 做 srcRoot 判定）
mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
# 2.1) 顶层入口（zip 根）：Install-WorkDaddy.cmd / Start-WorkDaddy.cmd
cp scripts/Install-WorkDaddy.cmd "$STAGE/Install-WorkDaddy.cmd"
cp scripts/Start-WorkDaddy.cmd "$STAGE/Start-WorkDaddy.cmd"
# 兼容 1.0.5 updater：旧版更新完成后固定寻找 <AppDir>\launcher.cmd。
printf '%s\r\n' \
  '@echo off' \
  'setlocal' \
  'if exist "%~dp0scripts\repair-entrypoints.ps1" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\repair-entrypoints.ps1" -AppDir "%~dp0"' \
  'if exist "%~dp0scripts\launcher-hidden.vbs" start "" /b wscript.exe //B //Nologo "%~dp0scripts\launcher-hidden.vbs"' \
  'exit /b 0' > "$STAGE/launcher.cmd"
# 2.2) scripts\ 本体
cp -R scripts "$STAGE/scripts"

# 2.3) 只在 staging 内补齐 ws，避免打包污染仓库工作树。
if [ ! -d "$STAGE/scripts/node_modules/ws" ]; then
  mkdir -p "$STAGE/scripts/node_modules"
  if [ -n "${WORKDADDY_WS_SOURCE:-}" ] && [ -d "$WORKDADDY_WS_SOURCE" ]; then
    echo "==> 从 WORKDADDY_WS_SOURCE 复制 ws 到 staging"
    cp -R "$WORKDADDY_WS_SOURCE" "$STAGE/scripts/node_modules/ws"
  else
    echo "==> 生成 staging/node_modules/ws（DevTools 代理依赖）"
    TMPNODE="$(mktemp -d)"
    (cd "$TMPNODE" && npm init -y >/dev/null 2>&1 && npm install ws --no-audit --no-fund >/dev/null 2>&1)
    mv "$TMPNODE/node_modules/ws" "$STAGE/scripts/node_modules/ws"
  fi
fi

# 2.4) 内置资产也直接复制到 staging。
if [ -d "$BUILTIN_SRC" ]; then
  echo "==> 内置资产 builtin（$(find "$BUILTIN_SRC/wallpapers" -name '*.webp' | wc -l | tr -d ' ') 张壁纸 + 主题）"
  mkdir -p "$STAGE/scripts/builtin"
  cp -R "$BUILTIN_SRC/." "$STAGE/scripts/builtin/"
else
  echo "==> 警告: 未找到内置资产 $BUILTIN_SRC（无 WorkDaddy.app？），打包将不含官方壁纸/主题"
fi

# 2.5) Logo 图标：放入 scripts\（install-win.ps1 从 SrcDir 同名找并复制到安装目录根）
if [ -f "$DIR/release/WorkDaddy.ico" ]; then
  cp "$DIR/release/WorkDaddy.ico" "$STAGE/scripts/WorkDaddy.ico"
  echo "==> 内置 logo 图标 -> scripts/WorkDaddy.ico"
else
  echo "==> 警告: 未找到 release/WorkDaddy.ico，桌面图标将回退为 cmd 默认"
fi
# 2.6) 排除开发/临时文件 + 顶层入口在 scripts\ 内的重复副本
#      （Install-WorkDaddy.cmd / Start-WorkDaddy.cmd 只应存在于 zip 根，避免用户误进
#       scripts\ 双击导致相对路径解析成 scripts\scripts\install-win.ps1 报错）
rm -rf "$STAGE/scripts/win/probe" "$STAGE/scripts/win/probe/"* 2>/dev/null || true
rm -f "$STAGE/scripts/Install-WorkDaddy.cmd" "$STAGE/scripts/Start-WorkDaddy.cmd" 2>/dev/null || true
find "$STAGE" -name '*.log' -delete 2>/dev/null || true
find "$STAGE" -name '.DS_Store' -delete 2>/dev/null || true
# 2.7) 打包：zip 优先；无 zip 时用 Python 标准库生成标准 / 分隔符 zip。
#      绝不用 PowerShell Compress-Archive —— 它产出反斜杠分隔符，非标准 zip 会被解压工具把
#      scripts\daemon.js 当单个文件名，导致解压结构错乱、入口秒退。
PYTHON_BIN="$(command -v python3 2>/dev/null || command -v python 2>/dev/null || true)"
if command -v zip >/dev/null 2>&1; then
  (cd "$STAGE" && zip -r -q "$DIR/$OUT" .)
elif [ -n "$PYTHON_BIN" ]; then
  "$PYTHON_BIN" -c 'import os,sys,zipfile; root,out=sys.argv[1],sys.argv[2]; z=zipfile.ZipFile(out,"w",zipfile.ZIP_DEFLATED); [z.write(os.path.join(dp,f), os.path.relpath(os.path.join(dp,f),root).replace(os.sep,"/")) for dp,_,fs in os.walk(root) for f in fs]; z.close()' "$STAGE" "$DIR/$OUT"
else
  echo "==> 错误: 未找到 zip / python3 / python，无法生成标准 ZIP"
  exit 1
fi

echo "==> 完成: $(ls -lh "$OUT" | awk '{print $5}')"
echo ""
echo "在 Windows 上：解压 zip 后，在顶层直接双击 Install-WorkDaddy.cmd 一键安装（自动建桌面图标+自启）；"
echo "日常启动双击 Start-WorkDaddy.cmd 或桌面 WorkDaddy 图标。"
echo "每 6 小时自动检查更新（GitHub Releases 需同时上传 .dmg 与 -win64.zip 两个资产，Windows 自动静默升级）。"
