# WorkDaddy Windows 安装脚本（install.sh 的 Windows 对应物）
# 用法：双击 install-win.cmd，或 powershell -ExecutionPolicy Bypass -File install-win.ps1
# 作用：复制到安装目录 → 初始化数据目录 → 清理旧登录自启 → 启动 launcher（WorkBuddy 已运行时提示退出）
# 全程用户态，无需管理员权限。
param(
  [string]$SrcDir = $PSScriptRoot,
  [string]$AppDir = '',
  [string]$Profile = '__WBS_DEFAULT_PROFILE__'
)

try {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  $isElevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  $env:WBSWITCH_PRIVILEGE_MODE = if ($isElevated) { 'elevated' } else { 'standard' }
} catch {
  [Console]::Error.WriteLine('无法确认当前 PowerShell 的 Windows 权限模式；安装已停止。')
  exit 5
}

$ErrorActionPreference = 'Stop'
try { . (Join-Path $PSScriptRoot 'windows-process-boundary.ps1') } catch {
  [Console]::Error.WriteLine('无法加载 Windows 进程身份边界；安装已停止。')
  exit 5
}
$ErrorActionPreference = 'Continue'
if ([string]::IsNullOrWhiteSpace($Profile) -or $Profile -eq '__WBS_DEFAULT_PROFILE__') { $Profile = 'workbuddy-cn' }
if ($Profile -ne 'workbuddy-ai') { $Profile = 'workbuddy-cn' }
$env:WBSWITCH_PROFILE = $Profile
$productName = if ($Profile -eq 'workbuddy-ai') { 'WorkDaddy AI' } else { 'WorkDaddy' }
if ([string]::IsNullOrWhiteSpace($AppDir)) { $AppDir = Join-Path $env:LOCALAPPDATA (Join-Path 'Programs' $productName) }
$targetScripts = Join-Path $AppDir 'scripts'
$dataRoot = Join-Path $env:APPDATA 'WorkDaddy'
$dataDir = if ($Profile -eq 'workbuddy-ai') { Join-Path $dataRoot 'profiles\workbuddy-ai' } else { $dataRoot }
$uiPort = if ($Profile -eq 'workbuddy-ai') { 47833 } else { 47832 }
$env:WBSWITCH_PORT = [string]$uiPort
$sentryReporter = Join-Path $SrcDir 'sentry-report.js'
$nodeBin = $null
$preserveExistingLifecycle = $false

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

# PowerShell 5.1 can throw a Win32 host exception when the host cmdlet emits CJK text
# through a UTF-8 cmd console. Write directly to .NET's console stream instead.
function Write-InstallLine {
  param([object]$Message)
  [Console]::WriteLine([string]$Message)
}

Write-InstallLine '=============================================================='
Write-InstallLine (" " + $productName + " Windows 安装")
Write-InstallLine '=============================================================='
Write-InstallLine ("  源目录   : " + $SrcDir)
Write-InstallLine ("  安装目录 : " + $AppDir)

# Stop only the lifecycle whose exact scripts, PID file, owner, and process
# identities match this profile. This also repairs older AI installs whose
# daemon inherited the legacy 47832 default instead of binding to 47833.
try {
  Stop-VerifiedWorkDaddyLifecycle `
    -DataDir $dataDir `
    -Port $uiPort `
    -ExpectedWatchdogScript (Join-Path $AppDir 'scripts\watchdog.js') `
    -ExpectedDaemonScript (Join-Path $AppDir 'scripts\daemon.js')
  Write-InstallLine '  已停止并清理当前 profile 的旧守护进程。'
} catch {
  $stopError = $_.Exception.Message
  if (-not $isElevated) {
    try {
      $sourceDaemon = Get-Content -LiteralPath (Join-Path $SrcDir 'daemon.js') -Raw -Encoding UTF8 -ErrorAction Stop
      $versionMatch = [regex]::Match($sourceDaemon, "const DAEMON_VERSION = '([^']+)'")
      if (-not $versionMatch.Success) { throw '安装源 daemon.js 缺少版本号' }
      [void](Get-AuthenticatedWorkDaddyStatus `
        -DataDir $dataDir `
        -Port $uiPort `
        -ExpectedProfile $Profile `
        -ExpectedVersion $versionMatch.Groups[1].Value `
        -AllowVersionMismatch)
      $preserveExistingLifecycle = $true
      Write-InstallLine '  检测到已验证的管理员权限旧服务：保留当前运行实例，并继续安装。'
    } catch {
      Write-InstallLine ('错误：安装被后台进程阻止。无法确认并停止当前 WorkDaddy；请先退出 WorkBuddy。详情: ' + $stopError)
      Send-Sentry 'windows-install-stop-lifecycle' $stopError 2
      exit 2
    }
  } else {
    Write-InstallLine ('错误：无法停止当前 WorkDaddy 后台进程。请先退出 WorkBuddy 后重试。详情: ' + $stopError)
    Send-Sentry 'windows-install-stop-lifecycle' $stopError 2
    exit 2
  }
}

# 1) 复制（排除开发/临时文件；node_modules/ws 随包带入）
if (-not (Test-Path (Join-Path $SrcDir 'daemon.js'))) {
  Write-InstallLine '错误：源目录中找不到 daemon.js，请从仓库 scripts/ 目录运行本脚本。'
  Send-Sentry 'windows-install-missing-files' '安装源目录中找不到 daemon.js' 1
  exit 1
}
New-Item -ItemType Directory -Force -Path $targetScripts | Out-Null
$sourceFull = [IO.Path]::GetFullPath($SrcDir).TrimEnd('\')
$targetFull = [IO.Path]::GetFullPath($targetScripts).TrimEnd('\')
if ([StringComparer]::OrdinalIgnoreCase.Equals($sourceFull, $targetFull)) {
  # 从已安装目录重复运行安装脚本时，源和目标相同；robocopy 会尝试覆盖正在执行的脚本，
  # 在 Windows 上容易出现“文件正被另一个进程使用”。此时只需继续执行后续注册/快捷方式步骤。
  Write-InstallLine '  源目录与安装目录相同，跳过自拷贝。'
} else {
  $launcherToReplace = Join-Path $targetScripts 'launcher.cmd'
  if (-not (Release-VerifiedLauncherLock -LauncherPath $launcherToReplace)) {
    Write-InstallLine "复制前无法释放 launcher.cmd 文件锁: $launcherToReplace"
    Send-Sentry 'windows-install-launcher-lock' "无法释放 launcher.cmd 文件锁: $launcherToReplace" 2
    exit 2
  }
  $copyArgs = @($SrcDir, $targetScripts, '/E', '/XF', '*.log', '.DS_Store', '/XD', (Join-Path $SrcDir 'win\probe'), '/R:2', '/W:1')
  if ($preserveExistingLifecycle) { $copyArgs += @('/XD', (Join-Path $SrcDir 'runtime\node')) }
  & robocopy @copyArgs
  $rc = $LASTEXITCODE
  if ($rc -ge 8) {
    Write-InstallLine "复制失败（robocopy=$rc）"
    Send-Sentry 'windows-install-copy' "robocopy 复制失败 (code=$rc)" $rc
    exit 2
  }
}

# 2) profile 数据目录（与 profiles.js / watchdog.js 一致）
New-Item -ItemType Directory -Force -Path (Join-Path $dataDir 'accounts') | Out-Null

# 2.5) Logo 图标：随安装复制到安装目录根（桌面快捷方式用），源在 scripts 同级的 WorkDaddy.ico
$logoIcoSrc = Join-Path $SrcDir 'WorkDaddy.ico'
$logoIco = Join-Path $AppDir 'WorkDaddy.ico'
if (Test-Path $logoIcoSrc) {
  try { Copy-Item $logoIcoSrc $logoIco -Force; Write-InstallLine ('  图标复制 : ' + $logoIco) } catch {}
}

# 3) 禁用登录自启：WorkDaddy / WorkDaddy AI 共存时由用户手动启动对应端。
#    同时清理旧版本可能留下的两个 Run 项；不要触碰其他应用的启动项。
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
try {
  foreach ($runName in @('WorkDaddy', 'WorkDaddy AI')) {
    Remove-ItemProperty -Path $runKey -Name $runName -ErrorAction SilentlyContinue
  }
  Write-InstallLine '  自启：已禁用（已清理 WorkDaddy / WorkDaddy AI 登录启动项）'
} catch {
  Write-InstallLine ('  自启清理失败（可忽略，之后手动双击 launcher.cmd 即可）: ' + $_.Exception.Message)
  Send-Sentry 'windows-install-autostart-cleanup' ('清理登录自启失败: ' + $_.Exception.Message) 0
}

# 4) 启动（daemon + 以 CDP 模式重启 WorkBuddy + 注入）
$launcher = Join-Path $targetScripts 'launcher.cmd'
Write-InstallLine ("  正在启动 " + $productName + "（如果 WorkBuddy 正在运行，会提示先完全退出）...")
$launcherVbs = Join-Path $targetScripts 'launcher-hidden.vbs'
if (Test-Path $launcher) {
  if (Test-Path $launcherVbs) {
    Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList ('//nologo "' + $launcherVbs + '"') -WorkingDirectory (Split-Path $launcher)
  } else {
    Start-Process -FilePath $launcher -WorkingDirectory (Split-Path $launcher)
  }
} else {
  Write-InstallLine '  警告：launcher.cmd 不存在，跳过自动启动（请到安装目录手动双击）'
}

# 5) 创建桌面快捷方式（名称跟随安装包 profile）
#    优先使用 wscript.exe 隐藏入口，避免启动时出现多余的终端窗口；
#    缺少隐藏入口时回退到 cmd.exe，兼容旧包/手工安装目录。
$desktopDir = [Environment]::GetFolderPath('Desktop')
if (-not $desktopDir) { $desktopDir = Join-Path $env:USERPROFILE 'Desktop' }
$lnkPath = Join-Path $desktopDir ($productName + '.lnk')
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
  $sc.Description      = ($productName + ' – WorkBuddy 增强工具')  # 描述跟随安装包 profile（WorkDaddy / WorkDaddy AI）
  if (Test-Path $logoIco) { $sc.IconLocation = $logoIco + ',0' }   # 用官方 logo，而非 cmd 默认图标
  $sc.Save()
  Write-InstallLine ('  桌面快捷方式 : ' + $lnkPath)
  if (Test-Path $logoIco) { Write-InstallLine ('  图标         : ' + $logoIco) }
} catch {
  Write-InstallLine ('  桌面快捷方式创建失败（可忽略，之后可手动创建）: ' + $_.Exception.Message)
  Send-Sentry 'windows-install-shortcut' ('创建桌面快捷方式失败: ' + $_.Exception.Message) 0
}

Write-InstallLine '=============================================================='
Write-InstallLine ' 安装完成！'
Write-InstallLine ('  profile  : ' + $Profile)
Write-InstallLine ("  安装目录 : " + $AppDir)
Write-InstallLine ("  数据目录 : " + $dataDir)
Write-InstallLine ('  备份账号 : ' + (Join-Path $dataDir 'accounts'))
Write-InstallLine '  卸载     : 运行安装目录 scripts\uninstall-win.cmd（或包根 Uninstall-WorkDaddy.cmd）'
Write-InstallLine '=============================================================='
