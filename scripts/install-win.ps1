# WorkDaddy Windows 安装脚本（install.sh 的 Windows 对应物）
# 用法：双击 install-win.cmd，或 powershell -ExecutionPolicy Bypass -File install-win.ps1
# 作用：复制到安装目录 → 初始化数据目录 → 注册登录自启(HKCU Run) → 启动 launcher（自动拉起 daemon + 以 CDP 模式重启 WorkBuddy）
# 全程用户态，无需管理员权限。
param(
  [string]$SrcDir = $PSScriptRoot,
  [string]$AppDir = (Join-Path $env:LOCALAPPDATA 'Programs\WorkDaddy')
)

$ErrorActionPreference = 'Continue'
$targetScripts = Join-Path $AppDir 'scripts'
$sentryReporter = Join-Path $SrcDir 'sentry-report.js'
$nodeBin = $null

# WorkBuddy 通常自带 Node；安装失败上报不依赖 npm 或 Electron。
try {
  $managedNodeRoot = Join-Path $env:USERPROFILE '.workbuddy\binaries\node\versions'
  $nodeBin = Get-ChildItem -Path $managedNodeRoot -Filter 'node.exe' -File -Recurse -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
} catch {}
if (-not $nodeBin) {
  try { $nodeBin = (Get-Command node -ErrorAction SilentlyContinue).Source } catch {}
}

function Send-Sentry {
  param([string]$Stage, [string]$Message, [int]$ExitCode = 0)
  if (-not $nodeBin -or -not (Test-Path $sentryReporter)) { return }
  try {
    $extra = @{ exitCode = $ExitCode } | ConvertTo-Json -Compress
    & $nodeBin $sentryReporter --stage $Stage --message $Message --extra-json $extra *> $null
  } catch {}
}

function Test-ExclusiveFile {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return $true }
  $stream = $null
  try {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
    return $true
  } catch {
    return $false
  } finally {
    if ($stream) { $stream.Dispose() }
  }
}

function Release-LockedLauncher {
  param([string]$LauncherPath)
  if (Test-ExclusiveFile $LauncherPath) { return $true }
  $needle = ([IO.Path]::GetFullPath($LauncherPath)).Replace('/', '\').ToLowerInvariant()
  try {
    Get-CimInstance Win32_Process -Filter "Name = 'cmd.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
      $commandLine = ([string]$_.CommandLine).Replace('/', '\').ToLowerInvariant()
      if ($commandLine.Contains($needle) -and $_.ProcessId -ne $PID) {
        taskkill /F /T /PID $_.ProcessId 2>$null | Out-Null
      }
    }
  } catch {}
  for ($i = 0; $i -lt 10; $i++) {
    if (Test-ExclusiveFile $LauncherPath) { return $true }
    Start-Sleep -Milliseconds 300
  }
  return (Test-ExclusiveFile $LauncherPath)
}

Write-Host '=============================================================='
Write-Host ' WorkDaddy Windows 安装'
Write-Host '=============================================================='
Write-Host ("  源目录   : " + $SrcDir)
Write-Host ("  安装目录 : " + $AppDir)

# 1) 复制（排除开发/临时文件；node_modules/ws 随包带入）
if (-not (Test-Path (Join-Path $SrcDir 'daemon.js'))) {
  Write-Host '错误：源目录中找不到 daemon.js，请从仓库 scripts/ 目录运行本脚本。'
  Send-Sentry 'windows-install-missing-files' '安装源目录中找不到 daemon.js' 1
  exit 1
}
New-Item -ItemType Directory -Force -Path $targetScripts | Out-Null
$sourceFull = [IO.Path]::GetFullPath($SrcDir).TrimEnd('\')
$targetFull = [IO.Path]::GetFullPath($targetScripts).TrimEnd('\')
if ([StringComparer]::OrdinalIgnoreCase.Equals($sourceFull, $targetFull)) {
  # 从已安装目录重复运行安装脚本时，源和目标相同；robocopy 会尝试覆盖正在执行的脚本，
  # 在 Windows 上容易出现“文件正被另一个进程使用”。此时只需继续执行后续注册/快捷方式步骤。
  Write-Host '  源目录与安装目录相同，跳过自拷贝。'
} else {
  $launcherToReplace = Join-Path $targetScripts 'launcher.cmd'
  if (-not (Release-LockedLauncher $launcherToReplace)) {
    Write-Host "复制前无法释放 launcher.cmd 文件锁: $launcherToReplace"
    Send-Sentry 'windows-install-launcher-lock' "无法释放 launcher.cmd 文件锁: $launcherToReplace" 2
    exit 2
  }
  robocopy $SrcDir $targetScripts /E /XF *.log .DS_Store /XD win\probe /R:2 /W:1
  $rc = $LASTEXITCODE
  if ($rc -ge 8) {
    Write-Host "复制失败（robocopy=$rc）"
    Send-Sentry 'windows-install-copy' "robocopy 复制失败 (code=$rc)" $rc
    exit 2
  }
}

# 2) 数据目录
$dataDir = Join-Path $env:APPDATA 'WorkDaddy'
New-Item -ItemType Directory -Force -Path (Join-Path $dataDir 'accounts') | Out-Null

# 2.5) Logo 图标：随安装复制到安装目录根（桌面快捷方式用），源在 scripts 同级的 WorkDaddy.ico
$logoIcoSrc = Join-Path $SrcDir 'WorkDaddy.ico'
$logoIco = Join-Path $AppDir 'WorkDaddy.ico'
if (Test-Path $logoIcoSrc) {
  try { Copy-Item $logoIcoSrc $logoIco -Force; Write-Host ('  图标复制 : ' + $logoIco) } catch {}
}

# 3) 登录自启（HKCU Run，登录时自动跑 launcher；崩溃自愈由 watchdog 负责）
#    必须经 launcher-hidden.vbs（wscript 静默入口）启动：直接注册 launcher.cmd 会在每次登录时
#    弹出 cmd 黑窗口，且 launcher.cmd 结尾的 pause 在无交互环境下会常驻不退出。
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$launcher = Join-Path $targetScripts 'launcher.cmd'
$launcherVbs = Join-Path $targetScripts 'launcher-hidden.vbs'
try {
  if (Test-Path $launcherVbs) {
    $autostartValue = '"' + (Join-Path $env:WINDIR 'System32\wscript.exe') + '" //nologo "' + $launcherVbs + '"'
  } else {
    $autostartValue = '"' + $launcher + '"'
  }
  Set-ItemProperty -Path $runKey -Name 'WorkDaddy' -Value $autostartValue
  Write-Host '  自启注册：HKCU\...\Run\WorkDaddy = ' $autostartValue
} catch {
  Write-Host ('  自启注册失败（可忽略，之后手动双击 launcher.cmd 即可）: ' + $_.Exception.Message)
  Send-Sentry 'windows-install-autostart' ('注册登录自启失败: ' + $_.Exception.Message) 0
}

# 4) 启动（daemon + 以 CDP 模式重启 WorkBuddy + 注入）
Write-Host '  正在启动 WorkDaddy（如果 WorkBuddy 正在运行，会重启它以开启调试模式）...'
if (Test-Path $launcher) {
  if (Test-Path $launcherVbs) {
    Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList ('//nologo "' + $launcherVbs + '"') -WorkingDirectory (Split-Path $launcher)
  } else {
    Start-Process -FilePath $launcher -WorkingDirectory (Split-Path $launcher)
  }
} else {
  Write-Host '  警告：launcher.cmd 不存在，跳过自动启动（请到安装目录手动双击）'
}

# 5) 创建桌面快捷方式「WorkDaddy」
#    优先使用 wscript.exe 隐藏入口，避免 Windows Terminal 为管理员 cmd 创建空白窗口；
#    缺少隐藏入口时回退到 cmd.exe，兼容旧包/手工安装目录。
$desktopDir = [Environment]::GetFolderPath('Desktop')
if (-not $desktopDir) { $desktopDir = Join-Path $env:USERPROFILE 'Desktop' }
$lnkPath = Join-Path $desktopDir 'WorkDaddy.lnk'
# Logo 图标（macOS 版同款黑白的 WorkBuddy 机器人，打包时置于安装目录根）
$logoIco = Join-Path $AppDir 'WorkDaddy.ico'
try {
  $ws = New-Object -ComObject WScript.Shell
  $sc = $ws.CreateShortcut($lnkPath)
  if (Test-Path $launcherVbs) {
    $sc.TargetPath       = Join-Path $env:WINDIR 'System32\wscript.exe'
    $sc.Arguments        = '//nologo "' + $launcherVbs + '"'
  } else {
    $sc.TargetPath       = "$env:ComSpec"
    $sc.Arguments        = '/d /c call "' + $launcher + '"'
  }
  $sc.WorkingDirectory = (Split-Path $launcher)
  $sc.Description      = 'WorkDaddy – WorkBuddy 增强工具（请以管理员身份运行）'
  if (Test-Path $logoIco) { $sc.IconLocation = $logoIco + ',0' }   # 用官方 logo，而非 cmd 默认图标
  $sc.Save()
  Write-Host ('  桌面快捷方式 : ' + $lnkPath)
  if (Test-Path $logoIco) { Write-Host ('  图标         : ' + $logoIco) }
} catch {
  Write-Host ('  桌面快捷方式创建失败（可忽略，之后可手动创建）: ' + $_.Exception.Message)
  Send-Sentry 'windows-install-shortcut' ('创建桌面快捷方式失败: ' + $_.Exception.Message) 0
}

Write-Host '=============================================================='
Write-Host ' 安装完成！'
Write-Host ("  安装目录 : " + $AppDir)
Write-Host ("  数据目录 : " + $dataDir)
Write-Host ('  备份账号 : ' + (Join-Path $dataDir 'accounts'))
Write-Host '  卸载     : 运行安装目录 scripts\uninstall-win.ps1'
Write-Host '=============================================================='
