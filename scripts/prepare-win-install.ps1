param(
  [Parameter(Mandatory = $true)][string]$BoundaryPath,
  [Parameter(Mandatory = $true)][string]$AppDir,
  [ValidateSet('workbuddy-cn', 'workbuddy-ai', 'codebuddy-cn', 'codebuddy-intl')][string]$Profile = 'workbuddy-cn',
  [Parameter(Mandatory = $true)][string]$ExpectedVersion
)

try {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  $privilege = if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { 'elevated' } else { 'standard' }
} catch {
  [Console]::Error.WriteLine('Cannot determine the Windows privilege mode for the installer.')
  exit 5
}

if (-not (Test-Path -LiteralPath $AppDir -PathType Container)) { exit 0 }

$ErrorActionPreference = 'Stop'
$diagnosticFile = Join-Path ([IO.Path]::GetTempPath()) 'WorkDaddy-prepare-install.log'
try {
  [IO.File]::AppendAllText(
    $diagnosticFile,
    ('[' + [DateTime]::UtcNow.ToString('o') + '] start profile=' + $Profile + ' privilege=' + $privilege + ' appDir=' + $AppDir + [Environment]::NewLine),
    (New-Object Text.UTF8Encoding($false)))
  . $BoundaryPath
  $dataRoot = Join-Path $env:APPDATA 'WorkDaddy'
  $dataDir = if ($Profile -eq 'workbuddy-cn') { $dataRoot } else { Join-Path $dataRoot ('profiles\' + $Profile) }
  $uiPort = (@{'workbuddy-cn'=47832; 'workbuddy-ai'=47833; 'codebuddy-cn'=47834; 'codebuddy-intl'=47835})[$Profile]
  Stop-VerifiedWorkDaddyLifecycle `
    -DataDir $dataDir `
    -Port $uiPort `
    -ExpectedWatchdogScript (Join-Path $AppDir 'scripts\watchdog.js') `
    -ExpectedDaemonScript (Join-Path $AppDir 'scripts\daemon.js')
  exit 0
} catch {
  $stopError = $_.Exception.Message
  if ($privilege -eq 'standard') {
    try {
      [void](Get-AuthenticatedWorkDaddyStatus `
        -DataDir $dataDir `
        -Port $uiPort `
        -ExpectedProfile $Profile `
        -ExpectedVersion $ExpectedVersion `
        -AllowVersionMismatch)
      [IO.File]::AppendAllText(
        $diagnosticFile,
        ('[' + [DateTime]::UtcNow.ToString('o') + '] preserved authenticated elevated lifecycle profile=' + $Profile +
          ' expectedVersion=' + $ExpectedVersion + [Environment]::NewLine),
        (New-Object Text.UTF8Encoding($false)))
      # Inno treats 10 as a verified compatibility path and skips only the
      # locked bundled runtime. No cross-integrity termination is attempted.
      exit 10
    } catch {
      $capabilityError = $_.Exception.Message
    }
  }
  try {
    [IO.File]::AppendAllText(
      $diagnosticFile,
      ('[' + [DateTime]::UtcNow.ToString('o') + '] failed profile=' + $Profile + ' error=' + $stopError +
        $(if ($capabilityError) { ' capability=' + $capabilityError } else { '' }) + [Environment]::NewLine),
      (New-Object Text.UTF8Encoding($false)))
  } catch {}
  [Console]::Error.WriteLine('Cannot safely stop the existing WorkDaddy lifecycle: ' + $stopError)
  exit 2
}
