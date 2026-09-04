@echo off
rem ============================================================
rem  WorkDaddy Windows 卸载核心（由 Uninstall-WorkDaddy.cmd 或安装目录调用）
rem  作用：停止并校验 WorkDaddy 后台生命周期 → 移除登录自启 → 删除桌面快捷方式
rem        → 删除安装目录（默认保留 %APPDATA%\WorkDaddy 账号备份数据）
rem  提示：卸载脚本必须与已安装目录同级运行（ps1 内部会校验），
rem        因此请通过 zip 根目录的 Uninstall-WorkDaddy.cmd 或已安装目录的
rem        scripts\uninstall-win.cmd 执行。
rem  设计：仅用 %~dp0 绝对路径定位 uninstall-win.ps1，杜绝相对路径歧义。
rem ============================================================
setlocal
chcp 65001 >nul 2>&1

where powershell >nul 2>nul
if errorlevel 1 (
  echo ERROR: PowerShell was not found.
  pause
  exit /b 1
)

if not exist "%~dp0uninstall-win.ps1" (
  echo ERROR: uninstall-win.ps1 was not found beside this file.
  pause
  exit /b 3
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall-win.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if "%EXIT_CODE%"=="0" (
  powershell -NoProfile -Command "$b='5Y246L295a6M5oiQ77yM6LSm5Y+35aSH5Lu95pWw5o2u5bey5L+d55WZ77yI5ZyoICVBUFBEQVRBJVxXb3JrRGFkZHnvvInjgII='; [Console]::OutputEncoding=[Text.Encoding]::UTF8; [Console]::WriteLine([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b)))"
  powershell -NoProfile -Command "$b='5aaC6ZyA5ZCM5pe25Yig6Zmk6LSm5Y+35aSH5Lu977yM6K+36L+Q6KGMIHNjcmlwdHNcdW5pbnN0YWxsLXdpbi5wczEgLVJlbW92ZURhdGE='; [Console]::OutputEncoding=[Text.Encoding]::UTF8; [Console]::WriteLine([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b)))"
) else (
  echo ERROR: uninstall failed with code %EXIT_CODE%. See the output above.
  echo If WorkDaddy is running with higher privileges, close it first and retry.
)
pause