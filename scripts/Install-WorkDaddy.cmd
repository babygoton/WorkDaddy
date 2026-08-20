@echo off
rem ============================================================
rem  WorkDaddy 一键安装（zip 解压后的顶层入口，双击运行）
rem  作用：复制到 %LOCALAPPDATA%\Programs\WorkDaddy → 注册开机自启
rem        → 创建桌面快捷方式 → 启动守护进程并以调试模式拉起 WorkBuddy
rem  提示：本插件为 WorkBuddy 的增强工具，需先安装 WorkBuddy 桌面端。
rem        运行所需的 Node 运行时由 WorkBuddyAI/WorkBuddy 自带托管，
rem        无需自行安装 Node.js。
rem
rem  设计：一律用"%~dp0"绝对路径定位，绝不做 cd 后相对调用——
rem        这样无论从哪个目录双击、即便目录里残留 scripts\scripts 嵌套，
rem        也只认"与本文件同级的 scripts\install-win.ps1"，杜绝路径歧义。
rem ============================================================
setlocal
chcp 65001 >nul 2>&1

rem ---------- 0) 找到真正的包根（向上穿透 scripts 嵌套残留） ----------
set "PKGROOT=%~dp0"
:locate_root
if exist "%PKGROOT%scripts\install-win.ps1" goto root_ok
rem 若本级没有而上一级有，说明点在 scripts\... 残留里，向上退一级
if exist "%PKGROOT%..\scripts\install-win.ps1" (
  for %%R in ("%PKGROOT%..") do set "PKGROOT=%%~fR\"
  goto locate_root
)
goto root_missing

:root_ok
echo Package root: %PKGROOT%

rem ---------- 1) 存在性校验（绝对路径，不依赖 cd） ----------
if not exist "%PKGROOT%scripts\install-win.cmd"  goto root_missing
if not exist "%PKGROOT%scripts\install-win.ps1"  goto root_missing
if not exist "%PKGROOT%scripts\daemon.js"        goto root_missing

rem ---------- 2) 执行安装（以包根绝对路径调用，避免 install-win.cmd 里 %~dp0 偏掉） ----------
call "%PKGROOT%scripts\install-win.cmd"
goto :eof

:root_missing
echo.
echo ERROR: required installation files were not found.
echo Run this file from the top level of the extracted WorkDaddy zip.
echo The top level must contain Install-WorkDaddy.cmd and the scripts folder.
echo.
echo Expected: Install-WorkDaddy.cmd beside scripts\.
pause
exit /b 1
