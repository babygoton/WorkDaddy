param(
  [Parameter(Mandatory = $true)][string]$ZipPath
)

$ErrorActionPreference = 'Stop'
$zip = (Resolve-Path $ZipPath).Path
$extractRoot = Join-Path ([IO.Path]::GetTempPath()) ('workdaddy-package-' + [guid]::NewGuid().ToString('N'))

try {
  Expand-Archive -LiteralPath $zip -DestinationPath $extractRoot -Force
  foreach ($required in @(
    'Install-WorkDaddy.cmd',
    'Start-WorkDaddy.cmd',
    'launcher.cmd',
    'scripts\launcher-hidden.vbs',
    'scripts\repair-entrypoints.ps1',
    'scripts\daemon.js',
    'scripts\node_modules\ws\package.json'
  )) {
    if (-not (Test-Path -LiteralPath (Join-Path $extractRoot $required) -PathType Leaf)) {
      throw "zip missing $required"
    }
  }
  if (Test-Path -LiteralPath (Join-Path $extractRoot 'scripts\Install-WorkDaddy.cmd')) {
    throw 'zip contains duplicate scripts\Install-WorkDaddy.cmd entry'
  }

  $verify = Join-Path $extractRoot 'scripts\verify-win.cmd'
  & cmd.exe /d /c ('call "' + $verify + '" --ci')
  if ($LASTEXITCODE -ne 0) { throw "release verify failed: $LASTEXITCODE" }

  Write-Output "Windows package passed: $zip"
} finally {
  $tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  $resolvedRoot = [IO.Path]::GetFullPath($extractRoot)
  if ($resolvedRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -and
      (Split-Path $resolvedRoot -Leaf).StartsWith('workdaddy-package-')) {
    Remove-Item -LiteralPath $resolvedRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
