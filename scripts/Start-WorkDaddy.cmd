@echo off
rem ============================================================
rem  WorkDaddy 便携版入口（zip 解压后双击运行）。
rem  与 Setup.exe 安装版使用相同的原生启动器和权限边界。
rem ============================================================
setlocal
chcp 65001 >nul 2>&1
echo WorkDaddy launcher starting...
if not exist "%~dp0WorkDaddyLauncher.exe" (
  echo ERROR: %~dp0WorkDaddyLauncher.exe was not found.
  pause
  exit /b 1
)
"%~dp0WorkDaddyLauncher.exe"
exit /b %ERRORLEVEL%
