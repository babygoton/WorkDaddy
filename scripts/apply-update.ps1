# WorkDaddy Windows 自动更新替换脚本（apply-update.sh 的 Windows 对应物）
# 由 daemon.js applyUpdate() 调用，参数：
#   $1 更新包 zip 路径（update 目录里下载好的 WorkDaddy-<ver>.zip）
#   $2 安装目录（默认 %LOCALAPPDATA%\Programs\WorkDaddy）
#   $3 本地 API 端口（等待旧 daemon 退出用，默认 47832）
# 流程：等端口释放 → 杀 watchdog/daemon → 备份旧目录(.old 可回滚) → 解压替换 → 拉起
# 注意：Windows 运行中的 exe/js 有文件锁，必须先杀进程再替换。
param(
  [Parameter(Mandatory = $true)][string]$SrcZip,
  [string]$AppDir = (Join-Path $env:LOCALAPPDATA 'Programs\WorkDaddy'),
  [string]$Port = '47832'
)

$ErrorActionPreference = 'Continue'
$appFull = [IO.Path]::GetFullPath($AppDir).TrimEnd('\')
$rootFull = [IO.Path]::GetPathRoot($appFull).TrimEnd('\')
if ([StringComparer]::OrdinalIgnoreCase.Equals($appFull, $rootFull)) { exit 3 }
$AppDir = $appFull
$DataDir = Join-Path $env:APPDATA 'WorkDaddy'
$LogDir = Join-Path $DataDir 'update'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Log = Join-Path $LogDir 'apply.log'
Start-Transcript -Path $Log -Append -Force

Write-Host "[apply] $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') start src=$SrcZip dst=$AppDir"

# 1) 先在独立临时目录解压并验证包结构，避免无效/错误 zip 触碰现有安装。
$tmpDir = Join-Path $env:TEMP ("workdaddy-update-" + [guid]::NewGuid().ToString('N'))
try {
  if (-not (Test-Path -LiteralPath $SrcZip -PathType Leaf)) { throw '更新包不存在' }
  New-Item -ItemType Directory -Force -Path $tmpDir -ErrorAction Stop | Out-Null
  Expand-Archive -LiteralPath $SrcZip -DestinationPath $tmpDir -Force -ErrorAction Stop
  foreach ($required in @(
    'Install-WorkDaddy.cmd',
    'Start-WorkDaddy.cmd',
    'scripts\daemon.js',
    'scripts\launcher.cmd',
    'scripts\launcher-hidden.vbs',
    'scripts\repair-entrypoints.ps1'
  )) {
    if (-not (Test-Path -LiteralPath (Join-Path $tmpDir $required) -PathType Leaf)) {
      throw "更新包缺少 $required"
    }
  }
  $srcRoot = $tmpDir
} catch {
  Write-Host "[apply] 更新包验证失败: $($_.Exception.Message)"
  Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
  Stop-Transcript
  exit 1
}

# 2) 杀 watchdog（会连带终止 daemon；PID 文件在数据目录）
$pidFile = Join-Path $DataDir 'watchdog.pid'
if (Test-Path $pidFile) {
  try {
    $watchdogPid = [int]((Get-Content -LiteralPath $pidFile -Raw).Trim())
    $watchdog = Get-CimInstance Win32_Process -Filter "ProcessId=$watchdogPid" -ErrorAction SilentlyContinue
    $expectedWatchdog = (Join-Path $AppDir 'scripts\watchdog.js').ToLowerInvariant()
    if ($watchdog -and $watchdog.CommandLine -and $watchdog.CommandLine.ToLowerInvariant().Contains($expectedWatchdog)) {
      taskkill /F /T /PID $watchdogPid 2>$null | Out-Null
    }
  } catch {}
}

# 2.5) 清理属于当前安装目录的旧交互式 launcher。
try {
  $oldLauncher = (Join-Path $AppDir 'scripts\launcher.cmd').ToLowerInvariant()
  Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($oldLauncher) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
} catch {}

# 3) 兜底：按 API 端口杀残留进程
$waitSec = 0
while ($waitSec -lt 30) {
  $listening = netstat -ano | Select-String (":$Port\s") | Select-String 'LISTENING'
  if (-not $listening) { break }
  # 尝试优雅等待
  Start-Sleep -Seconds 1
  $waitSec++
}
foreach ($line in (netstat -ano | Select-String (":$Port\s") | Select-String 'LISTENING')) {
  $parts = ($line.ToString().Trim() -split '\s+')
  $pid2 = $parts[$parts.Count - 1]
  if ($pid2 -match '^\d+$') {
    $listener = Get-CimInstance Win32_Process -Filter "ProcessId=$pid2" -ErrorAction SilentlyContinue
    $expectedDaemon = (Join-Path $AppDir 'scripts\daemon.js').ToLowerInvariant()
    if ($listener -and $listener.CommandLine -and $listener.CommandLine.ToLowerInvariant().Contains($expectedDaemon)) {
      taskkill /F /T /PID $pid2 2>$null | Out-Null
    }
  }
}
Start-Sleep -Seconds 1

# 4) 备份旧目录（回滚：move AppDir.old AppDir）
$oldDir = $AppDir + '.old'
try {
  if (Test-Path -LiteralPath $oldDir) { Remove-Item -LiteralPath $oldDir -Recurse -Force -ErrorAction Stop }
  if (Test-Path -LiteralPath $AppDir) { Move-Item -LiteralPath $AppDir -Destination $oldDir -Force -ErrorAction Stop }
  New-Item -ItemType Directory -Force -Path $AppDir -ErrorAction Stop | Out-Null
} catch {
  Write-Host "[apply] 备份旧版本失败: $($_.Exception.Message)"
  if (-not (Test-Path -LiteralPath $AppDir) -and (Test-Path -LiteralPath $oldDir)) {
    Move-Item -LiteralPath $oldDir -Destination $AppDir -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
  Stop-Transcript
  exit 2
}

# 5) 复制内容（robocopy /MIR 保留结构；失败则回滚）
$rc = 1
robocopy $srcRoot $AppDir /MIR /NFL /NDL /NJH /NJS /NP
$rc = $LASTEXITCODE  # robocopy 0-7 都算成功
if ($rc -ge 8) {
  Write-Host "[apply] 复制失败(robocopy=$rc)，回滚旧版本"
  Remove-Item -Recurse -Force $AppDir -ErrorAction SilentlyContinue
  if (Test-Path $oldDir) { Move-Item -Force $oldDir $AppDir }
  Stop-Transcript
  Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
  exit 3
}

# 6) 修复静默入口并拉起新版；确认 /healthz 后才删除回滚目录。
$targetScripts = Join-Path $AppDir 'scripts'
$launcher = Join-Path $targetScripts 'launcher.cmd'
$launcherVbs = Join-Path $targetScripts 'launcher-hidden.vbs'
$repairEntrypoints = Join-Path $targetScripts 'repair-entrypoints.ps1'
$wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
if (Test-Path -LiteralPath $repairEntrypoints -PathType Leaf) {
  try { & $repairEntrypoints -AppDir $AppDir } catch { Write-Host ('[apply] 修复静默入口失败: ' + $_.Exception.Message) }
}
if (Test-Path -LiteralPath $launcherVbs -PathType Leaf) {
  Start-Process -FilePath $wscript -ArgumentList ('//B //Nologo "' + $launcherVbs + '"') -WorkingDirectory $targetScripts -WindowStyle Hidden
} elseif (Test-Path -LiteralPath $launcher -PathType Leaf) {
  Start-Process -FilePath $launcher -WorkingDirectory $targetScripts -WindowStyle Hidden
}

$ready = $false
for ($attempt = 0; $attempt -lt 30 -and -not $ready; $attempt++) {
  Start-Sleep -Seconds 1
  for ($candidate = [int]$Port; $candidate -lt ([int]$Port + 8); $candidate++) {
    try {
      $health = Invoke-RestMethod -Uri ("http://127.0.0.1:$candidate/healthz") -TimeoutSec 1
      if ($health.ok -and $health.service -eq 'workdaddy') { $ready = $true; break }
    } catch {}
  }
}

if ($ready) {
  Remove-Item -LiteralPath $oldDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
} else {
  Write-Host '[apply] 新版未通过健康检查，正在回滚旧版本'
  Remove-Item -LiteralPath $AppDir -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $oldDir) { Move-Item -LiteralPath $oldDir -Destination $AppDir -Force }
  Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
  $rollbackVbs = Join-Path $AppDir 'scripts\launcher-hidden.vbs'
  $rollbackCmd = Join-Path $AppDir 'scripts\launcher.cmd'
  if (Test-Path -LiteralPath $rollbackVbs -PathType Leaf) {
    Start-Process -FilePath $wscript -ArgumentList ('//B //Nologo "' + $rollbackVbs + '"') -WindowStyle Hidden
  } elseif (Test-Path -LiteralPath $rollbackCmd -PathType Leaf) {
    Start-Process -FilePath $rollbackCmd -WorkingDirectory (Split-Path $rollbackCmd) -WindowStyle Hidden
  }
  Stop-Transcript
  exit 4
}
Write-Host "[apply] $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') done"
Stop-Transcript
exit 0
