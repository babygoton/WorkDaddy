# WorkDaddy Windows 卸载脚本（uninstall.sh 的 Windows 对应物）
# 用法：powershell -ExecutionPolicy Bypass -File uninstall-win.ps1
# 默认保留备份数据（%APPDATA%\WorkDaddy）；加 -RemoveData 一并删除。
param(
  [switch]$RemoveData,
  [switch]$SkipAppRemoval,
  [string]$AppDir = '',
  [string]$Profile = '__WBS_DEFAULT_PROFILE__'
)

try {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  $isElevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  $env:WBSWITCH_PRIVILEGE_MODE = if ($isElevated) { 'elevated' } else { 'standard' }
} catch {
  [Console]::Error.WriteLine('无法确认当前 PowerShell 的 Windows 权限模式；卸载已停止。')
  exit 5
}

$ErrorActionPreference = 'Stop'
try { . (Join-Path $PSScriptRoot 'windows-process-boundary.ps1') } catch {
  [Console]::Error.WriteLine('无法加载 Windows 进程身份边界；卸载已停止。')
  exit 5
}
$ErrorActionPreference = 'Continue'
if ([string]::IsNullOrWhiteSpace($Profile) -or $Profile -eq '__WBS_DEFAULT_PROFILE__') { $Profile = 'workbuddy-cn' }
if ($Profile -ne 'workbuddy-ai') { $Profile = 'workbuddy-cn' }
$productName = if ($Profile -eq 'workbuddy-ai') { 'WorkDaddy AI' } else { 'WorkDaddy' }
if ([string]::IsNullOrWhiteSpace($AppDir)) { $AppDir = Join-Path $env:LOCALAPPDATA (Join-Path 'Programs' $productName) }
if (-not (Test-SameWindowsPath -Left $PSScriptRoot -Right (Join-Path $AppDir 'scripts'))) {
  throw '卸载脚本位置与目标安装目录不一致，拒绝删除'
}
$dataRoot = Join-Path $env:APPDATA 'WorkDaddy'
$dataDir = if ($Profile -eq 'workbuddy-ai') { Join-Path $dataRoot 'profiles\workbuddy-ai' } else { $dataRoot }
$port = if ($Profile -eq 'workbuddy-ai') { 47833 } else { 47832 }

Write-Host ('卸载 ' + $productName + '...')

# 1) 只有在 watchdog/daemon 身份确认或明确不存在后才允许任何卸载写操作。
Stop-VerifiedWorkDaddyLifecycle `
  -DataDir $dataDir `
  -Port $port `
  -ExpectedWatchdogScript (Join-Path $AppDir 'scripts\watchdog.js') `
  -ExpectedDaemonScript (Join-Path $AppDir 'scripts\daemon.js')

# 2) 移除登录自启（兼容 WorkDaddy / WorkDaddy AI 两个 profile）
try {
  foreach ($runName in @('WorkDaddy', 'WorkDaddy AI')) {
    Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name $runName -ErrorAction SilentlyContinue
  }
  Write-Host '  已移除登录自启项'
} catch {}

# 2.5) 删除桌面快捷方式（与 install-win.ps1 创建对称；兼容两个 profile 的历史残留）
$desktopDir = [Environment]::GetFolderPath('Desktop')
if (-not $desktopDir) { $desktopDir = Join-Path $env:USERPROFILE 'Desktop' }
foreach ($lnkName in @('WorkDaddy.lnk', 'WorkDaddy AI.lnk')) {
  $lnk = Join-Path $desktopDir $lnkName
  if (Test-Path -LiteralPath $lnk -PathType Leaf) {
    try {
      Remove-Item -LiteralPath $lnk -Force -ErrorAction Stop
      Write-Host ('  已删除桌面快捷方式: ' + $lnk)
    } catch {
      Write-Host ('  桌面快捷方式删除失败（可手动删除）: ' + $lnk + ' - ' + $_.Exception.Message)
    }
  }
}

# 3) 删除安装目录（Inno Setup 调用时由卸载器负责删除）
if (-not $SkipAppRemoval -and (Test-Path $AppDir)) {
  Remove-Item -LiteralPath $AppDir -Recurse -Force -ErrorAction Stop
  if (Test-Path -LiteralPath $AppDir) { throw "安装目录删除失败: $AppDir" }
  Write-Host ('  已删除安装目录: ' + $AppDir)
} elseif ($SkipAppRemoval) {
  Write-Host '  已停止 WorkDaddy 生命周期，安装器将继续删除程序文件'
}

# 4) 数据目录（可选）
if ($RemoveData) {
  if (Test-Path $dataDir) {
    Remove-Item -LiteralPath $dataDir -Recurse -Force -ErrorAction Stop
    if (Test-Path -LiteralPath $dataDir) { throw "数据目录删除失败: $dataDir" }
    Write-Host ('  已删除数据目录（含账号备份）: ' + $dataDir)
  }
} else {
  Write-Host ('  已保留备份数据（含账号备份）: ' + $dataDir)
}

Write-Host '卸载完成。'
if (-not $RemoveData) {
  Write-Host '如需同时删除账号备份，请重新运行：uninstall-win.ps1 -RemoveData'
}
