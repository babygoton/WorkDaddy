[CmdletBinding()]
param(
  [string]$OutputDirectory = '',
  [string]$IsccPath = '',
  [ValidateSet('workbuddy-cn', 'workbuddy-ai')][string]$Profile = 'workbuddy-cn',
  [string]$Version = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$scriptsRoot = $PSScriptRoot
$repoRoot = Split-Path -Parent $scriptsRoot
$versionSource = Get-Content -LiteralPath (Join-Path $scriptsRoot 'daemon.js') -Raw -Encoding UTF8
$versionMatch = [regex]::Match($versionSource, "const DAEMON_VERSION = '([^']+)'")
if (-not $versionMatch.Success) { throw 'daemon.js does not contain DAEMON_VERSION.' }
$version = if ([string]::IsNullOrWhiteSpace($Version)) { $versionMatch.Groups[1].Value } else { $Version.Trim() }
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw "Invalid daemon version: $version" }

$productName = if ($Profile -eq 'workbuddy-ai') { 'WorkDaddy AI' } else { 'WorkDaddy' }
$packageName = if ($Profile -eq 'workbuddy-ai') { 'WorkDaddy-AI' } else { 'WorkDaddy' }
$startDescription = if ($Profile -eq 'workbuddy-ai') { '立即打开 WorkDaddy AI' } else { '立即打开 WorkDaddy' }
$appGuid = if ($Profile -eq 'workbuddy-ai') {
  '{{D1A8A90C-1F55-4E56-8BB2-7F12A39B9D12}'
} else {
  '{{4B857D52-8C5A-4A9A-A17D-0EE8A34A12C7}'
}

if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repoRoot 'release\windows' }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

$zipPath = Join-Path $OutputDirectory ("$packageName-$version-win64.zip")
if (-not (Test-Path -LiteralPath $zipPath -PathType Leaf)) {
  throw "Windows ZIP is missing: $zipPath. Run scripts/build-win-zip.sh first."
}

if (-not $IsccPath) {
  $candidates = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
    (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe')
  )
  $command = Get-Command ISCC.exe -ErrorAction SilentlyContinue
  if ($command) { $candidates += $command.Source }
  $IsccPath = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
}
if (-not $IsccPath -or -not (Test-Path -LiteralPath $IsccPath -PathType Leaf)) {
  throw 'Inno Setup 6 ISCC.exe was not found.'
}

$stageRoot = Join-Path ([IO.Path]::GetTempPath()) ('workdaddy-installer-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $stageRoot | Out-Null
try {
  Expand-Archive -LiteralPath $zipPath -DestinationPath $stageRoot -Force
  $scriptsPayload = Join-Path $stageRoot 'scripts'
  if (-not (Test-Path -LiteralPath (Join-Path $scriptsPayload 'runtime\node\node.exe') -PathType Leaf)) {
    throw 'The ZIP payload does not contain the bundled Node runtime.'
  }
  $builtinPayload = Join-Path $scriptsPayload 'builtin'
  $wallpaperPayload = Join-Path $builtinPayload 'wallpapers'
  $themePayload = Join-Path $builtinPayload 'nebula\theme.json'
  if (-not (Test-Path -LiteralPath $wallpaperPayload -PathType Container) -or
      -not (Test-Path -LiteralPath $themePayload -PathType Leaf)) {
    throw 'ZIP 内部缺少内置官方壁纸或 nebula/theme.json。'
  }
  $wallpaperCount = @(Get-ChildItem -LiteralPath $wallpaperPayload -Filter '*.webp' -File -ErrorAction SilentlyContinue).Count
  if ($wallpaperCount -le 0) {
    throw 'ZIP 内置官方壁纸为空，拒绝生成安装包。'
  }
  $stagedDaemon = Get-Content -LiteralPath (Join-Path $scriptsPayload 'daemon.js') -Raw -Encoding UTF8
  $stagedVersionMatch = [regex]::Match($stagedDaemon, "const DAEMON_VERSION = '([^']+)'")
  if (-not $stagedVersionMatch.Success -or $stagedVersionMatch.Groups[1].Value -ne $version) {
    throw "ZIP 内部 daemon 版本与安装器版本不一致: $($stagedVersionMatch.Groups[1].Value) != $version"
  }
  $iss = Join-Path $scriptsRoot 'win\workdaddy.iss'
  $args = @(
    "/DAppVersion=$version",
    "/DProfileId=$Profile",
    "/DProductName=$productName",
    "/DPackageName=$packageName",
    "/DStartDescription=$startDescription",
    "/DAppGuid=$appGuid",
    "/DStageRoot=$stageRoot",
    "/DOutputDir=$OutputDirectory",
    $iss
  )
  & $IsccPath @args
  if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed with exit code $LASTEXITCODE." }
  $setup = Join-Path $OutputDirectory ("$packageName-Setup-$version.exe")
  if (-not (Test-Path -LiteralPath $setup -PathType Leaf) -or (Get-Item -LiteralPath $setup).Length -le 0) {
    throw "Setup artifact is missing or empty: $setup"
  }
  Write-Host "Created $setup"
} finally {
  if (Test-Path -LiteralPath $stageRoot) {
    Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
  # ZIP is only an internal staging input. Windows releases publish Setup.exe only.
  if (Test-Path -LiteralPath $zipPath -PathType Leaf) {
    Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
  }
}
