param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
)

$ErrorActionPreference = 'Stop'
$guardRoot = Join-Path ([IO.Path]::GetTempPath()) ('workdaddy-update-guard-' + [guid]::NewGuid().ToString('N'))
$appDir = Join-Path $guardRoot 'installed'
$packageDir = Join-Path $guardRoot 'bad-package'
$fakeAppData = Join-Path $guardRoot 'appdata'
$previousAppData = $env:APPDATA

try {
  New-Item -ItemType Directory -Force -Path $appDir, $packageDir, $fakeAppData | Out-Null
  Set-Content -LiteralPath (Join-Path $appDir 'preserve.marker') -Value 'keep'
  Set-Content -LiteralPath (Join-Path $packageDir 'not-workdaddy.txt') -Value 'invalid'
  $badZip = Join-Path $guardRoot 'invalid.zip'
  Compress-Archive -Path (Join-Path $packageDir '*') -DestinationPath $badZip

  $env:APPDATA = $fakeAppData
  $applyScript = (Resolve-Path (Join-Path $RepoRoot 'scripts\apply-update.ps1')).Path
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $applyScript -SrcZip $badZip -AppDir $appDir -Port 49999
  if ($LASTEXITCODE -ne 1) { throw "invalid update returned $LASTEXITCODE, expected 1" }
  if (-not (Test-Path -LiteralPath (Join-Path $appDir 'preserve.marker') -PathType Leaf)) {
    throw 'existing installation changed before package validation completed'
  }

  Write-Output 'Update guard passed: invalid package rejected and existing installation preserved'
} finally {
  $env:APPDATA = $previousAppData
  $tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  $resolvedRoot = [IO.Path]::GetFullPath($guardRoot)
  if ($resolvedRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -and
      (Split-Path $resolvedRoot -Leaf).StartsWith('workdaddy-update-guard-')) {
    Remove-Item -LiteralPath $resolvedRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# The expected child PowerShell exit code is 1. Reset the workflow step result
# after all assertions pass so pwsh does not propagate that native exit code.
exit 0
