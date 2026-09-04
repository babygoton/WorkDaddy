@echo off
rem ============================================================
rem  WorkDaddy 一键卸载（zip 解压后的顶层入口，双击运行）
rem  作用：停止并校验 WorkDaddy 后台生命周期 → 移除登录自启 → 删除桌面快捷方式
rem        → 删除安装目录（默认保留 %APPDATA%\WorkDaddy 账号备份数据）
rem  提示：卸载脚本只允许与「已安装目录」同级运行（防误删），
rem        本入口会自动定位已安装目录并调用其 scripts\uninstall-win.cmd。
rem  设计：一律用"%~dp0"绝对路径定位，绝不做 cd 后相对调用——
rem        与 Install-WorkDaddy.cmd 完全对称，双击即可卸载。
rem ============================================================
setlocal
chcp 65001 >nul 2>&1

rem ---------- 1) 卸载确认（破坏性操作，防止误点） ----------
choice /C YN /M "Confirm uninstall? Account backup data will be kept"
if errorlevel 2 exit /b 0

rem ---------- 2) 判定 profile（读取打包时写入的 profile-id.txt；缺省为国内版） ----------
set "PROFILE=workbuddy-cn"
if exist "%~dp0scripts\profile-id.txt" set /p PROFILE=<"%~dp0scripts\profile-id.txt"
if /I "%PROFILE%"=="workbuddy-ai" (
  set "PRODUCT_NAME=WorkDaddy AI"
) else (
  set "PRODUCT_NAME=WorkDaddy"
)

rem ---------- 3) 定位已安装目录（同 profile 优先，其次另一 profile，最后本包目录） ----------
rem      探测 uninstall-win.ps1 以兼容旧版安装（1.1.5/1.1.6 只有 ps1 没有 cmd）
set "APP_DIR="
if exist "%LOCALAPPDATA%\Programs\%PRODUCT_NAME%\scripts\uninstall-win.ps1" set "APP_DIR=%LOCALAPPDATA%\Programs\%PRODUCT_NAME%"
if not defined APP_DIR if exist "%LOCALAPPDATA%\Programs\WorkDaddy\scripts\uninstall-win.ps1" set "APP_DIR=%LOCALAPPDATA%\Programs\WorkDaddy"
if not defined APP_DIR if exist "%LOCALAPPDATA%\Programs\WorkDaddy AI\scripts\uninstall-win.ps1" set "APP_DIR=%LOCALAPPDATA%\Programs\WorkDaddy AI"
if not defined APP_DIR if exist "%~dp0scripts\uninstall-win.ps1" set "APP_DIR=%~dp0"

if not defined APP_DIR goto not_installed

echo Uninstall target: %APP_DIR%
echo.

rem ---------- 4) 执行卸载（绝对路径调用安装目录内的卸载核心） ----------
if exist "%APP_DIR%scripts\uninstall-win.cmd" (
  call "%APP_DIR%scripts\uninstall-win.cmd"
) else (
  rem 旧版安装目录没有 cmd 入口，直接调用 ps1
  where powershell >nul 2>nul
  if errorlevel 1 (
    echo ERROR: PowerShell was not found.
    pause
    exit /b 1
  )
  powershell -NoProfile -ExecutionPolicy Bypass -File "%APP_DIR%scripts\uninstall-win.ps1"
)
goto :eof

:not_installed
echo.
echo WorkDaddy does not appear to be installed under
echo   %LOCALAPPDATA%\Programs\WorkDaddy
echo   %LOCALAPPDATA%\Programs\WorkDaddy AI
echo Nothing to uninstall.
pause
exit /b 1