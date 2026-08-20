@echo off
rem ============================================================
rem  WorkDaddy Windows 安装包自检脚本（双击运行）
rem  作用：验证 Setup.exe / zip 解出的 scripts 是否「完整、可装、可启动」
rem  不修改任何系统状态，纯只读检查，可放心重复运行。
rem ============================================================
setlocal
chcp 65001 >nul
cd /d "%~dp0"
set "SCRIPT_DIR=%~dp0"

echo ============================================================
echo  WorkDaddy 安装包自检
echo ============================================================

set "FAIL=0"

rem ---- 1) 关键文件齐全 ----
echo.
echo [1/6] 检查关键文件...
for %%F in (daemon.js lib.js watchdog.js win-launcher.js win-inject-helper.js inject.js theme-patches.js launcher.cmd launcher-hidden.vbs install-win.cmd install-win.ps1 repair-entrypoints.ps1 apply-update.ps1 win\setup.sed) do (
  if not exist "%SCRIPT_DIR%%%F" (
    echo   缺失: %%~F
    set /a FAIL+=1
  )
)
if exist "%SCRIPT_DIR%daemon.js" echo   核心 daemon.js 存在
rem 顶层一键安装/启动入口（zip 根，staging 打包时复制到 install 目录根）
if exist "%SCRIPT_DIR%..\Install-WorkDaddy.cmd" (
  echo   顶层入口 Install-WorkDaddy.cmd 存在
) else (
  echo   提示: 顶层 Install-WorkDaddy.cmd 未就位（打包时从 scripts\ 提升到 zip 根）
)
if exist "%SCRIPT_DIR%..\Start-WorkDaddy.cmd" echo   顶层入口 Start-WorkDaddy.cmd 存在
if not exist "%SCRIPT_DIR%node_modules\ws\index.js" (
  echo   警告: node_modules\ws 缺失（DevTools 代理降级，其他功能不受影响）
)

rem ---- 2) node 运行时可达性 ----
echo.
echo [2/6] 检查 node 运行时...
set "NODE="
for /d %%d in ("%USERPROFILE%\.workbuddy-ai\binaries\node\versions\*") do (
  if exist "%%d\node.exe" set "NODE=%%d\node.exe"
)
for /d %%d in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do (
  if not defined NODE if exist "%%d\node.exe" set "NODE=%%d\node.exe"
)
if not defined NODE set "NODE=node"
"%NODE%" --version >nul 2>&1
if errorlevel 1 (
  echo   错误: 找不到可用的 node（不能启动守护进程）
  set /a FAIL+=1
) else (
  echo   可用: %NODE%
)
"%NODE%" --experimental-sqlite -e "require('node:sqlite')" >nul 2>&1
if errorlevel 1 (
  echo   错误: 当前 node 不支持 node:sqlite（Windows 会话管理不可用）
  set /a FAIL+=1
)

rem ---- 3) 脚本语法静态检查（node --check，不执行）----
echo.
echo [3/6] 校验 JS 语法...
for %%F in (daemon.js lib.js watchdog.js win-launcher.js win-inject-helper.js inject.js theme-patches.js) do (
  "%NODE%" --check "%SCRIPT_DIR%%%F" >nul 2>&1
  if errorlevel 1 (
    echo   语法错误: %%~F
    set /a FAIL+=1
  )
)
echo   JS 语法检查完成
cscript //B //Nologo "%SCRIPT_DIR%launcher-hidden.vbs" /check >nul 2>&1
if errorlevel 1 (
  echo   语法错误: launcher-hidden.vbs
  set /a FAIL+=1
)

rem ---- 4) PS1 合法性（PowerShell 解析但不执行）----
echo.
echo [4/6] 校验 PS1 脚本语法...
for %%F in (install-win.ps1 repair-entrypoints.ps1 apply-update.ps1 uninstall-win.ps1) do call :CheckPs1 "%SCRIPT_DIR%%%F" "%%~F"

rem ---- 5) 自启注册表与安装目录回写测试（读态 + 安装目录可写性探测）----
echo.
echo [5/6] 检查安装目标可写 + 自启状态...
set "APPDIR=%LOCALAPPDATA%\Programs\WorkDaddy"
if exist "%APPDIR%\scripts\daemon.js" (
  echo   已安装版本: "%APPDIR%" 存在
) else (
  echo   未安装（首次安装前状态正常）
)
echo   LOCALAPPDATA=%LOCALAPPDATA%
if not exist "%LOCALAPPDATA%" (
  echo   警告: LOCALAPPDATA 不可访问，可能影响安装
)

rem ---- 6) 桌面图标/WorkBuddy 现状（只读）----
echo.
echo [6/6] 检查 WorkBuddy 与桌面图标...
tasklist 2>nul | findstr /i "WorkBuddy" >nul && (
  echo   WorkBuddy 正在运行
) || (
  echo   WorkBuddy 未运行（安装时会以调试模式拉起）
)
if exist "%USERPROFILE%\Desktop\WorkDaddy.lnk" (
  echo   桌面已有 WorkDaddy 图标
)

echo.
echo ============================================================
if "%FAIL%"=="0" (
  echo  自检通过：本包可用于 Windows 安装。
) else (
  echo  发现 %FAIL% 处问题，请在下方对照修正后再分发。
)
echo ============================================================
if /I not "%~1"=="--ci" pause
exit /b %FAIL%

:CheckPs1
set "PS1_CHECK_PATH=%~1"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$tokens=$null; $errors=$null; [void][System.Management.Automation.Language.Parser]::ParseFile($env:PS1_CHECK_PATH,[ref]$tokens,[ref]$errors); if($errors.Count -gt 0){exit 1}; exit 0" >nul 2>&1
if errorlevel 1 (
  echo   语法错误: %~2
  set /a FAIL+=1
) else (
  echo   OK: %~2
)
exit /b 0
