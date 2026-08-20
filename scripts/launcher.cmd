@echo off
rem WorkDaddy Windows 启动器（双击入口）
rem 需要：launcher.cmd 与 win-launcher.js / watchdog.js / daemon.js 在同一目录
setlocal EnableExtensions
chcp 65001 >nul 2>&1
cd /d "%~dp0" >nul 2>&1

rem 先输出一行 ASCII 状态：管理员启动时 Windows Terminal 可能在 Node 探测期间保持空白，
rem 这行也能区分“正在启动”和“入口没有执行”。
echo WorkDaddy launcher starting...

rem 定位 node：WorkBuddyAI 托管运行时优先，其次旧 WorkBuddy 与 PATH。
set "NODE="
for /d %%d in ("%USERPROFILE%\.workbuddy-ai\binaries\node\versions\*") do (
  if exist "%%d\node.exe" set "NODE=%%d\node.exe"
)
for /d %%d in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do (
  if not defined NODE if exist "%%d\node.exe" set "NODE=%%d\node.exe"
)
if not defined NODE set "NODE=node"

"%NODE%" --experimental-sqlite -e "require('node:sqlite')" >nul 2>&1
if errorlevel 1 (
  echo ERROR: the selected Node runtime does not support node:sqlite.
  echo WorkDaddy requires the managed Node runtime from WorkBuddyAI/WorkBuddy or Node 22+.
  exit /b 1
)

if not exist "%~dp0win-launcher.js" (
  echo ERROR: win-launcher.js was not found in the launcher directory.
  pause
  exit /b 1
)

echo Checking the bundled Node runtime...
"%NODE%" --experimental-sqlite "%~dp0win-launcher.js" %*
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if "%EXIT_CODE%"=="0" (
  echo Done: WorkDaddy is ready.
) else (
  echo ERROR: launcher exited with code %EXIT_CODE%.
  echo Log: %APPDATA%\WorkDaddy\launcher.log
)
if /i "%WBSWITCH_NO_PAUSE%"=="1" exit /b %EXIT_CODE%
pause
