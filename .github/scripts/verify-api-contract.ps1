param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$ExpectedVersion = ''
)

$ErrorActionPreference = 'Stop'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('workdaddy-api-' + [guid]::NewGuid().ToString('N'))
$dataDir = Join-Path $testRoot 'data'
$workBuddyHome = Join-Path $testRoot '.workbuddy-ai'
$daemon = $null

try {
  New-Item -ItemType Directory -Force -Path $dataDir, $workBuddyHome | Out-Null

  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  $listener.Start()
  $port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
  $listener.Stop()

  $env:WBSWITCH_DATA_DIR = $dataDir
  $env:WBSWITCH_AUTH_FILE = Join-Path $testRoot 'missing-auth.info'
  $env:WBSWITCH_WORKBUDDY_HOME = $workBuddyHome
  $env:WBSWITCH_PORT = [string]$port
  $env:WBSWITCH_CDP_PORT = '49199'

  $daemonScript = (Resolve-Path (Join-Path $RepoRoot 'scripts\daemon.js')).Path
  if (-not $ExpectedVersion) {
    $versionMatch = [regex]::Match((Get-Content -LiteralPath $daemonScript -Raw), "DAEMON_VERSION\s*=\s*'([^']+)'" )
    if (-not $versionMatch.Success) { throw 'could not resolve daemon version' }
    $ExpectedVersion = $versionMatch.Groups[1].Value
  }
  $stdout = Join-Path $testRoot 'daemon.out.log'
  $stderr = Join-Path $testRoot 'daemon.err.log'
  $node = (Get-Command node -ErrorAction Stop).Source
  $daemon = Start-Process -FilePath $node -ArgumentList @('--experimental-sqlite', ('"' + $daemonScript + '"')) `
    -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr

  $health = $null
  for ($attempt = 0; $attempt -lt 40 -and -not $health; $attempt++) {
    Start-Sleep -Milliseconds 250
    try { $health = Invoke-RestMethod "http://127.0.0.1:$port/healthz" -TimeoutSec 1 } catch {}
  }
  if (-not $health -or -not $health.ok -or $health.service -ne 'workdaddy' -or $health.version -ne $ExpectedVersion) {
    throw 'healthz contract failed'
  }

  $unauth = Invoke-WebRequest "http://127.0.0.1:$port/api/status" -SkipHttpErrorCheck
  if ([int]$unauth.StatusCode -ne 403) { throw "unauthenticated request returned $($unauth.StatusCode), expected 403" }

  $wrong = Invoke-WebRequest "http://127.0.0.1:$port/api/status" -Headers @{ 'X-WorkDaddy-Token' = 'wrong' } -SkipHttpErrorCheck
  if ([int]$wrong.StatusCode -ne 403) { throw "wrong token returned $($wrong.StatusCode), expected 403" }

  $token = (Get-Content -LiteralPath (Join-Path $dataDir 'api-token') -Raw).Trim()
  if ($token -notmatch '^[a-f0-9]{64}$') { throw 'invalid API token file' }
  $headers = @{ 'X-WorkDaddy-Token' = $token }
  $status = Invoke-RestMethod "http://127.0.0.1:$port/api/status" -Headers $headers
  if (-not $status.ok -or $status.version -ne $ExpectedVersion) { throw 'authenticated status contract failed' }

  $badJson = Invoke-WebRequest "http://127.0.0.1:$port/api/ask-mode-set" -Method Post -Headers $headers `
    -ContentType 'application/json' -Body '{' -SkipHttpErrorCheck
  if ([int]$badJson.StatusCode -ne 400) { throw "invalid JSON returned $($badJson.StatusCode), expected 400" }

  $oversized = 'x' * (16MB + 1)
  $tooLarge = Invoke-WebRequest "http://127.0.0.1:$port/api/ask-mode-set" -Method Post -Headers $headers `
    -ContentType 'application/json' -Body $oversized -SkipHttpErrorCheck
  if ([int]$tooLarge.StatusCode -ne 413) { throw "oversized body returned $($tooLarge.StatusCode), expected 413" }

  Write-Output "API contract passed: health=200 unauth=403 wrong-token=403 auth=200 invalid-json=400 oversized=413"
} finally {
  if ($daemon -and -not $daemon.HasExited) {
    Stop-Process -Id $daemon.Id -Force
    $daemon.WaitForExit(5000) | Out-Null
  }
  $tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  $resolvedRoot = [IO.Path]::GetFullPath($testRoot)
  if ($resolvedRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -and
      (Split-Path $resolvedRoot -Leaf).StartsWith('workdaddy-api-')) {
    Remove-Item -LiteralPath $resolvedRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
