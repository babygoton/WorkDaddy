# Repair the two persistent Windows entry points so both use the console-free
# VBS launcher. The caller owns the WorkDaddy installation directory.
param(
  [string]$AppDir = (Split-Path $PSScriptRoot -Parent)
)

$ErrorActionPreference = 'Stop'
$appFull = [IO.Path]::GetFullPath($AppDir).TrimEnd('\')
$rootFull = [IO.Path]::GetPathRoot($appFull).TrimEnd('\')
if ([StringComparer]::OrdinalIgnoreCase.Equals($appFull, $rootFull)) {
  throw '拒绝把驱动器根目录作为 WorkDaddy 安装目录'
}

$targetScripts = Join-Path $appFull 'scripts'
$hiddenLauncher = Join-Path $targetScripts 'launcher-hidden.vbs'
$wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
if (-not (Test-Path -LiteralPath $hiddenLauncher -PathType Leaf)) { throw 'launcher-hidden.vbs 不存在' }
if (-not (Test-Path -LiteralPath $wscript -PathType Leaf)) { throw 'wscript.exe 不存在' }

$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runValue = '"' + $wscript + '" //B //Nologo "' + $hiddenLauncher + '"'
New-Item -Path $runKey -Force | Out-Null
Set-ItemProperty -Path $runKey -Name 'WorkDaddy' -Value $runValue

$desktopDir = [Environment]::GetFolderPath('Desktop')
if (-not $desktopDir) { $desktopDir = Join-Path $env:USERPROFILE 'Desktop' }
New-Item -ItemType Directory -Force -Path $desktopDir | Out-Null
$lnkPath = Join-Path $desktopDir 'WorkDaddy.lnk'
$logoIco = Join-Path $appFull 'WorkDaddy.ico'
if (-not (Test-Path -LiteralPath $logoIco -PathType Leaf)) {
  $logoIco = Join-Path $targetScripts 'WorkDaddy.ico'
}

$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnkPath)
$sc.TargetPath = $wscript
$sc.Arguments = '//B //Nologo "' + $hiddenLauncher + '"'
$sc.WorkingDirectory = $targetScripts
$sc.Description = 'WorkDaddy – WorkBuddy 增强工具（静默启动）'
if (Test-Path -LiteralPath $logoIco -PathType Leaf) { $sc.IconLocation = $logoIco + ',0' }
$sc.Save()

Write-Host ('  自启入口     : ' + $runValue)
Write-Host ('  桌面快捷方式 : ' + $lnkPath)
