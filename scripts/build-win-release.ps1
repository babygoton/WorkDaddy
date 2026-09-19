[CmdletBinding()]
param(
  [string]$Version = '',
  [string]$OutputDirectory = '',
  [string]$GitBashPath = '',
  [string]$IsccPath = '',
  [string]$PythonPath = '',
  [string]$GoPath = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$scriptsRoot = $PSScriptRoot
$repoRoot = Split-Path -Parent $scriptsRoot
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repoRoot 'release\windows' }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)

function Find-Executable {
  param(
    [string]$ExplicitPath,
    [string[]]$Candidates,
    [string]$CommandName,
    [string]$MissingMessage
  )

  if ($ExplicitPath) {
    $resolved = [IO.Path]::GetFullPath($ExplicitPath)
    if (Test-Path -LiteralPath $resolved -PathType Leaf) { return $resolved }
    throw "找不到指定的 ${CommandName}: $resolved"
  }

  $command = Get-Command $CommandName -ErrorAction SilentlyContinue
  if ($command -and $command.Source -and (Test-Path -LiteralPath $command.Source -PathType Leaf)) {
    return $command.Source
  }
  foreach ($candidate in $Candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $candidate }
  }
  throw $MissingMessage
}

function ConvertTo-GitBashPath {
  param([Parameter(Mandatory)][string]$Path)

  $full = [IO.Path]::GetFullPath($Path)
  if ($full -match '^(?<drive>[A-Za-z]):\\(?<rest>.*)$') {
    return ('/{0}/{1}' -f $matches.drive.ToLowerInvariant(), ($matches.rest -replace '\\', '/'))
  }
  return ($full -replace '\\', '/')
}

function Get-SourceVersion {
  $source = Get-Content -LiteralPath (Join-Path $scriptsRoot 'daemon.js') -Raw -Encoding UTF8
  $match = [regex]::Match($source, "const DAEMON_VERSION = '([^']+)'")
  if (-not $match.Success) { throw 'daemon.js 中找不到 DAEMON_VERSION。' }
  return $match.Groups[1].Value
}

function Invoke-WindowsZipBuild {
  param(
    [Parameter(Mandatory)][string]$Bash,
    [Parameter(Mandatory)][string]$Profile,
    [Parameter(Mandatory)][string]$ReleaseVersion,
    [string]$CachedPython,
    [string]$GoExecutable
  )

  $bashRepo = ConvertTo-GitBashPath $repoRoot
  $pythonAssignment = ''
  if ($CachedPython) {
    $pythonBash = ConvertTo-GitBashPath $CachedPython
    $pythonAssignment = " WORKDADDY_PYTHON=`"$pythonBash`""
  }
  $goAssignment = ''
  if ($GoExecutable) {
    $goBash = ConvertTo-GitBashPath $GoExecutable
    $goAssignment = " WORKDADDY_GO=`"$goBash`""
  }
  $command = "cd `"$bashRepo`" && WORKDADDY_BUILD_PROFILE=`"$Profile`" WORKDADDY_BUILD_VERSION=`"$ReleaseVersion`"$pythonAssignment$goAssignment bash scripts/build-win-zip.sh"
  Write-Host "`n==> 生成 $Profile staging ZIP"
  & $Bash -lc $command
  if ($LASTEXITCODE -ne 0) {
    throw "$Profile staging ZIP 生成失败（退出码 $LASTEXITCODE）。"
  }
}

function Invoke-WindowsInstallerBuild {
  param(
    [Parameter(Mandatory)][string]$Profile,
    [Parameter(Mandatory)][string]$ReleaseVersion,
    [Parameter(Mandatory)][string]$Compiler
  )

  Write-Host "==> 编译 $Profile Setup.exe"
  & (Join-Path $scriptsRoot 'build-win-installer.ps1') `
    -Profile $Profile `
    -Version $ReleaseVersion `
    -OutputDirectory $OutputDirectory `
    -IsccPath $Compiler | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "$Profile Setup.exe 生成失败（退出码 $LASTEXITCODE）。"
  }
  $packageName = if ($Profile -eq 'workbuddy-ai') { 'WorkDaddy-AI' } else { 'WorkDaddy' }
  $setup = Join-Path $OutputDirectory "$packageName-Setup-$ReleaseVersion.exe"
  $portable = Join-Path $OutputDirectory "$packageName-Portable-$ReleaseVersion.zip"
  if (-not (Test-Path -LiteralPath $setup -PathType Leaf)) {
    throw "未找到生成的安装包: $setup"
  }
  if (-not (Test-Path -LiteralPath $portable -PathType Leaf)) {
    throw "未找到生成的便携包: $portable"
  }
  return $setup, $portable
}

try {
  $sourceVersion = Get-SourceVersion
  if ([string]::IsNullOrWhiteSpace($Version)) {
    $answer = Read-Host "请输入发布版本号（直接回车使用 $sourceVersion）"
    $Version = if ([string]::IsNullOrWhiteSpace($answer)) { $sourceVersion } else { $answer.Trim() }
  } else {
    $Version = $Version.Trim()
  }
  if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    throw "版本号必须是 x.y.z 格式，实际为: $Version"
  }

  $gitBashCandidates = @(
    (Join-Path ${env:ProgramFiles} 'Git\bin\bash.exe'),
    (Join-Path ${env:ProgramFiles} 'Git\usr\bin\bash.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Git\bin\bash.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Git\usr\bin\bash.exe')
  )
  $bash = Find-Executable $GitBashPath $gitBashCandidates 'bash.exe' '找不到 Git Bash（bash.exe），请安装 Git for Windows 或使用 -GitBashPath 指定路径。'

  $isccCandidates = @(
    (Join-Path ${env:LOCALAPPDATA} 'Programs\Inno Setup 6\ISCC.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
    (Join-Path ${env:ProgramFiles} 'Inno Setup 6\ISCC.exe')
  )
  $iscc = Find-Executable $IsccPath $isccCandidates 'ISCC.exe' '找不到 Inno Setup 6 的 ISCC.exe，请安装 Inno Setup 或使用 -IsccPath 指定路径。'

  if (-not $PythonPath) {
    $cachedPython = Join-Path $repoRoot 'release\.cache\python3.exe'
    if (Test-Path -LiteralPath $cachedPython -PathType Leaf) { $PythonPath = $cachedPython }
  } elseif (-not (Test-Path -LiteralPath $PythonPath -PathType Leaf)) {
    throw "找不到指定的 Python: $PythonPath"
  }

  if (-not $GoPath) {
    $goCommand = Get-Command go.exe -ErrorAction SilentlyContinue
    if ($goCommand) { $GoPath = $goCommand.Source }
    if (-not $GoPath) {
      $cachedGo = Join-Path $env:USERPROFILE '.workdaddy-toolchains\go1.27.0\bin\go.exe'
      if (Test-Path -LiteralPath $cachedGo -PathType Leaf) { $GoPath = $cachedGo }
    }
  }
  if (-not $GoPath -or -not (Test-Path -LiteralPath $GoPath -PathType Leaf)) {
    throw '找不到 Go 1.24+；请安装 Go 或使用 -GoPath 指定 go.exe。'
  }

  New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
  $packages = @()
  foreach ($profile in @('workbuddy-cn', 'workbuddy-ai')) {
    Invoke-WindowsZipBuild -Bash $bash -Profile $profile -ReleaseVersion $Version -CachedPython $PythonPath -GoExecutable $GoPath
    $packages += Invoke-WindowsInstallerBuild -Profile $profile -ReleaseVersion $Version -Compiler $iscc
  }

  Write-Host "`n============================================================"
  Write-Host "Windows 双版本 Setup.exe / Portable.zip 生成完成（版本 $Version）"
  foreach ($package in $packages) {
    $item = Get-Item -LiteralPath $package
    Write-Host ("{0}  ({1:N0} bytes)" -f $item.FullName, $item.Length)
  }
  Write-Host "============================================================"
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
