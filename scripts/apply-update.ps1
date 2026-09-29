# WorkDaddy Windows 自动更新替换脚本。
# 独立于 daemon 运行：停止 watchdog、替换安装目录、启动新版并验证 API；失败时保留日志并回滚。
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][Alias('SrcZip')][string]$SrcPackage,
  [string]$AppDir = '',
  [string]$Port = '47832',
  [string]$LogPath = '',
  [string]$AttemptId = 'unknown',
  [string]$Profile = '__WBS_DEFAULT_PROFILE__'
)

try {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  $isElevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  $env:WBSWITCH_PRIVILEGE_MODE = if ($isElevated) { 'elevated' } else { 'standard' }
} catch {
  [Console]::Error.WriteLine('无法确认当前 PowerShell 的 Windows 权限模式；更新已停止。')
  exit 5
}

$ErrorActionPreference = 'Stop'
try { . (Join-Path $PSScriptRoot 'windows-process-boundary.ps1') } catch {
  [Console]::Error.WriteLine('无法加载 Windows 进程身份边界；更新已停止。')
  exit 5
}
if ([string]::IsNullOrWhiteSpace($Profile) -or $Profile -eq '__WBS_DEFAULT_PROFILE__') { $Profile = 'workbuddy-cn' }
if ($Profile -notin @('workbuddy-cn', 'workbuddy-ai', 'codebuddy-cn', 'codebuddy-intl')) { throw 'Unknown client profile' }
$productName = (@{'workbuddy-cn'='WorkDaddy'; 'workbuddy-ai'='WorkDaddy AI'; 'codebuddy-cn'='CodeDaddy CN'; 'codebuddy-intl'='CodeDaddy'})[$Profile]
if ([string]::IsNullOrWhiteSpace($AppDir)) { $AppDir = Join-Path $env:LOCALAPPDATA (Join-Path 'Programs' $productName) }
if (-not (Test-SameWindowsPath -Left $PSScriptRoot -Right (Join-Path $AppDir 'scripts'))) {
  throw '更新脚本位置与目标安装目录不一致，拒绝替换'
}
$dataRoot = Join-Path $env:APPDATA 'WorkDaddy'
$DataDir = if ($Profile -eq 'workbuddy-cn') { $dataRoot } else { Join-Path $dataRoot ('profiles\' + $Profile) }
$LogDir = Join-Path $DataDir 'update'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
if ([string]::IsNullOrWhiteSpace($LogPath)) { $LogPath = Join-Path $LogDir 'apply.log' }
$transcriptStarted = $false
try {
  Start-Transcript -Path $LogPath -Append -Force | Out-Null
  $transcriptStarted = $true
} catch {
  # Transcript is diagnostic only; continue with Write-Host if the file cannot be opened.
}

function Write-ApplyLog {
  param([Parameter(Mandatory = $true)][string]$Message)
  Write-Host ("[apply] {0} {1}" -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK'), $Message)
}

function Stop-ApplyTranscript {
  if ($script:transcriptStarted) {
    try { Stop-Transcript | Out-Null } catch {}
    $script:transcriptStarted = $false
  }
}

function Stop-WatchdogAndPort {
  Stop-VerifiedWorkDaddyLifecycle `
    -DataDir $DataDir `
    -Port ([int]$Port) `
    -ExpectedWatchdogScript (Join-Path $AppDir 'scripts\watchdog.js') `
    -ExpectedDaemonScript (Join-Path $AppDir 'scripts\daemon.js')
}

function Stop-WorkBuddyForUpdate {
  $processName = (@{'workbuddy-cn'='WorkBuddy.exe'; 'workbuddy-ai'='WorkBuddyAI.exe'; 'codebuddy-cn'='CodeBuddy CN.exe'; 'codebuddy-intl'='CodeBuddy.exe'})[$Profile]
  $stopped = Stop-VerifiedWorkBuddyProcesses -ProcessName $processName
  if ($stopped -gt 0) { Write-ApplyLog "已停止 $processName 进程数=$stopped，释放安装目录文件锁" }
}

function Rollback-App {
  param([string]$OldDir, [string]$TargetDir)
  Write-ApplyLog "开始回滚旧版本"
  Stop-WatchdogAndPort
  Stop-WorkBuddyForUpdate
  try { if (Test-Path -LiteralPath $TargetDir) { Remove-Item -LiteralPath $TargetDir -Recurse -Force -ErrorAction SilentlyContinue } } catch {}
  if (Test-Path -LiteralPath $OldDir) {
    try { Move-Item -LiteralPath $OldDir -Destination $TargetDir -Force -ErrorAction Stop } catch {
      Write-ApplyLog "回滚失败: $($_.Exception.Message)"
    }
  }
  $oldLauncher = Join-Path $TargetDir 'scripts\launcher.cmd'
  $oldLauncherVbs = Join-Path $TargetDir 'scripts\launcher-hidden.vbs'
  try {
    if (Test-Path -LiteralPath $oldLauncherVbs) {
      Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList ('//nologo "' + $oldLauncherVbs + '"') -WorkingDirectory (Split-Path $oldLauncher) -ErrorAction Stop | Out-Null
    } elseif (Test-Path -LiteralPath $oldLauncher) {
      Start-Process -FilePath $oldLauncher -WorkingDirectory (Split-Path $oldLauncher) -ErrorAction Stop | Out-Null
    }
  } catch {
    Write-ApplyLog "回滚后启动旧 launcher 失败: $($_.Exception.Message)"
  }
}

$oldDir = "$AppDir.old"
$tmpDir = Join-Path $env:TEMP ("workdaddy-update-" + [guid]::NewGuid().ToString('N'))
$backupMade = $false
$lifecycleValidated = $false
$isSetupPackage = $false
try {
  Write-ApplyLog "start attempt=$AttemptId src=$SrcPackage dst=$AppDir port=$Port pid=$PID"
  if (-not (Test-Path -LiteralPath $SrcPackage -PathType Leaf)) { throw "更新包不存在: $SrcPackage" }
  $isSetupPackage = ([IO.Path]::GetExtension($SrcPackage) -ieq '.exe')
  Stop-WatchdogAndPort
  Stop-WorkBuddyForUpdate
  $lifecycleValidated = $true

  foreach ($launcherPath in @((Join-Path $AppDir 'scripts\launcher.cmd'), (Join-Path $oldDir 'scripts\launcher.cmd'))) {
    if (-not (Release-VerifiedLauncherLock -LauncherPath $launcherPath)) { throw "无法释放 launcher.cmd 文件锁: $launcherPath" }
  }

  $packageName = [IO.Path]::GetFileNameWithoutExtension($SrcPackage)
  $packageVersionMatch = [regex]::Match($packageName, '([0-9]+\.[0-9]+\.[0-9]+)')
  $packageVersion = if ($packageVersionMatch.Success) { $packageVersionMatch.Groups[1].Value } else { '' }
  if ($isSetupPackage) {
    if ([string]::IsNullOrWhiteSpace($packageVersion)) { throw "安装器文件名缺少版本号: $packageName" }
    Write-ApplyLog "artifact inspect setup=$packageName packageVersion=$packageVersion"
    $installer = Start-Process -FilePath $SrcPackage -ArgumentList '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART' -WorkingDirectory (Split-Path $SrcPackage) -Wait -PassThru -WindowStyle Hidden -ErrorAction Stop
    Write-ApplyLog "Setup.exe 已退出 code=$($installer.ExitCode)"
    if ($installer.ExitCode -ne 0) { throw "Setup.exe 安装失败 (code=$($installer.ExitCode))" }
    $sourceDaemonVersion = $packageVersion
    $sourceBuildId = ''
  } else {
  if (Test-Path -LiteralPath $oldDir) { Remove-Item -LiteralPath $oldDir -Recurse -Force -ErrorAction Stop }
  if (Test-Path -LiteralPath $AppDir) {
    Move-Item -LiteralPath $AppDir -Destination $oldDir -Force -ErrorAction Stop
    $backupMade = $true
  }

  New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
  Expand-Archive -LiteralPath $SrcPackage -DestinationPath $tmpDir -Force
  $srcRoot = $tmpDir
  if (-not (Test-Path (Join-Path $tmpDir 'scripts\daemon.js'))) {
    $hit = Get-ChildItem -LiteralPath $tmpDir -Recurse -Filter 'daemon.js' -File | Select-Object -First 1
    if ($hit) { $srcRoot = Split-Path $hit.FullName -Parent | Split-Path -Parent }
  }
  foreach ($required in @('scripts\daemon.js', 'scripts\launcher.cmd', 'scripts\win-launcher.js')) {
    if (-not (Test-Path (Join-Path $srcRoot $required) -PathType Leaf)) { throw "更新包缺少 $required" }
  }
  $sourceDaemonText = Get-Content -LiteralPath (Join-Path $srcRoot 'scripts\daemon.js') -Raw
  $sourceDaemonMatch = [regex]::Match($sourceDaemonText, "const DAEMON_VERSION = '([^']+)'")
  $sourceDaemonVersion = if ($sourceDaemonMatch.Success) { $sourceDaemonMatch.Groups[1].Value } else { '' }
  $sourceBuildMatch = [regex]::Match($sourceDaemonText, "const DAEMON_BUILD_ID = '([^']+)'")
  $sourceBuildId = if ($sourceBuildMatch.Success) { $sourceBuildMatch.Groups[1].Value } else { '' }
  $packageName = [IO.Path]::GetFileNameWithoutExtension($SrcPackage)
  $packageVersionMatch = [regex]::Match($packageName, '([0-9]+\.[0-9]+\.[0-9]+)')
  $packageVersion = if ($packageVersionMatch.Success) { $packageVersionMatch.Groups[1].Value } else { '' }
  Write-ApplyLog "artifact inspect package=$packageName packageVersion=$packageVersion daemonVersion=$sourceDaemonVersion"
  if ([string]::IsNullOrWhiteSpace($sourceDaemonVersion)) { throw '更新包 daemon.js 缺少 DAEMON_VERSION' }
  if ([string]::IsNullOrWhiteSpace($sourceBuildId)) { throw '更新包 daemon.js 缺少 DAEMON_BUILD_ID' }
  if (-not [string]::IsNullOrWhiteSpace($packageVersion) -and $sourceDaemonVersion -ne $packageVersion) {
    throw "更新包内部 daemon 版本 $sourceDaemonVersion 与文件目标版本 $packageVersion 不一致"
  }

  New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
  & robocopy $srcRoot $AppDir /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
  $rc = $LASTEXITCODE
  Write-ApplyLog "robocopy code=$rc"
  if ($rc -ge 8) { throw "robocopy 复制失败 (code=$rc)" }
  }

  $launcher = Join-Path $AppDir 'scripts\launcher.cmd'
  $launcherVbs = Join-Path $AppDir 'scripts\launcher-hidden.vbs'
  if (Test-Path -LiteralPath $launcherVbs) {
    $started = Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList ('//nologo "' + $launcherVbs + '"') -WorkingDirectory (Split-Path $launcher) -PassThru -ErrorAction Stop
  } else {
    $started = Start-Process -FilePath $launcher -WorkingDirectory (Split-Path $launcher) -PassThru -ErrorAction Stop
  }
  Write-ApplyLog "已启动新版 launcher pid=$($started.Id)，等待 daemon"
  $ready = $false
  for ($i = 0; $i -lt 60; $i++) {
    try {
      $status = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/api/status" -f $Port) -Method Get -TimeoutSec 2
      [void](Assert-DaemonStatusIdentity `
        -Status $status `
        -Port ([int]$Port) `
        -ExpectedProfile $Profile `
        -ExpectedVersion $sourceDaemonVersion `
        -ExpectedDaemonScript (Join-Path $AppDir 'scripts\daemon.js') `
        -ExpectedBuildId $sourceBuildId)
      if ($status.version) { $ready = $true; Write-ApplyLog "新版 daemon 已就绪 version=$($status.version)"; break }
    } catch {}
    Start-Sleep -Seconds 1
  }
  if (-not $ready) { throw '新版 daemon 在 60 秒内未就绪' }
  $runningVersion = [string]$status.version
  Write-ApplyLog "running daemon version=$runningVersion expected=$sourceDaemonVersion"
  if ($runningVersion -ne $sourceDaemonVersion) {
    throw "新版 daemon 实际版本 $runningVersion 与包内 daemon 版本 $sourceDaemonVersion 不一致"
  }

  if (Test-Path -LiteralPath $oldDir) {
    Remove-Item -LiteralPath $oldDir -Recurse -Force -ErrorAction SilentlyContinue
  }
  Write-ApplyLog "done attempt=$AttemptId"
  Stop-ApplyTranscript
  exit 0
} catch {
  Write-ApplyLog "FAILED attempt=$AttemptId error=$($_.Exception.Message)"
  if ($backupMade) { Rollback-App -OldDir $oldDir -TargetDir $AppDir }
  Stop-ApplyTranscript
  exit 1
} finally {
  if ($lifecycleValidated) {
    try { if (Test-Path -LiteralPath $tmpDir) { Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue } } catch {}
    try { Remove-Item -LiteralPath (Join-Path $LogDir 'pending.json') -Force -ErrorAction SilentlyContinue } catch {}
  }
}
