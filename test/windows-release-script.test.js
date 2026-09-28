'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const scriptPath = path.join(__dirname, '..', 'scripts', 'build-win-release.ps1');
const launcherPath = path.join(__dirname, '..', 'scripts', 'build-win-release.cmd');
const hiddenLauncherPath = path.join(__dirname, '..', 'scripts', 'launcher-hidden.vbs');
const standardRelaunchPath = path.join(__dirname, '..', 'scripts', 'windows-relaunch-standard.ps1');
const scriptBytes = fs.readFileSync(scriptPath);
const source = scriptBytes.toString('utf8');
const launcher = fs.readFileSync(launcherPath, 'utf8');
const hiddenLauncherBytes = fs.readFileSync(hiddenLauncherPath);
const standardRelaunchBytes = fs.readFileSync(standardRelaunchPath);

test('Windows release script interactively builds both profiles for one version', () => {
  assert.deepEqual([...scriptBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'Windows PowerShell 5.1 needs a UTF-8 BOM for Chinese prompts');
  assert.match(source, /Read-Host\s+"[^"]*版本号/);
  assert.match(source, /\$Version -notmatch '\^\\d\+\\\.\\d\+\\\.\\d\+\$'/);
  assert.match(source, /foreach \(\$profile in @\('workbuddy-cn', 'workbuddy-ai', 'codebuddy-cn', 'codebuddy-intl'\)\)/);
  assert.match(source, /build-win-zip\.sh/);
  assert.match(source, /build-win-installer\.ps1/);
  assert.match(source, /-IsccPath \$Compiler \| Out-Host/);
  assert.match(source, /WORKDADDY_BUILD_PROFILE/);
  assert.match(source, /-Version \$ReleaseVersion/);
  assert.match(launcher, /build-win-release\.ps1/);
  assert.match(launcher, /ExecutionPolicy Bypass/);
});

test('Windows hidden launcher stays parseable under WSH code pages', () => {
  assert.equal(hiddenLauncherBytes.some((byte) => byte >= 0x80), false);
});

test('Windows standard relaunch script is UTF-8 with BOM for Windows PowerShell 5.1', () => {
  assert.deepEqual([...standardRelaunchBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
});

test('Windows standard relaunch falls back to the Explorer Shell object by executable path', () => {
  const relaunch = standardRelaunchBytes.toString('utf8');
  assert.match(relaunch, /shellWindows\.Windows\(\)/);
  assert.match(relaunch, /GetFileName\(\[string\]\$_.FullName\).*explorer\.exe/);
  assert.doesNotMatch(relaunch, /Get-Process\s+-Name\s+explorer/);
});

test('Windows watchdog uses an OS-managed profile lock and keeps restart backoff', () => {
  const watchdog = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'watchdog.js'), 'utf8');
  assert.match(watchdog, /net\.createServer\(\)/);
  assert.match(watchdog, /'workbuddy-cn':47932,'workbuddy-ai':47933,'codebuddy-cn':47934,'codebuddy-intl':47935/);
  assert.match(watchdog, /exclusive:\s*true/);
  assert.match(watchdog, /restartDelay = Math\.min\(restartDelay \* 2, 60000\)/);
  assert.doesNotMatch(watchdog, /pending\.json|updateProcessIsActive|powershell|Get-CimInstance|taskkill/i);
});

test('Windows installer excludes the repair prompt from all release stages', () => {
  const zipBuild = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build-win-zip.sh'), 'utf8');
  const installerBuild = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build-win-installer.ps1'), 'utf8');
  const iss = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'win', 'workdaddy.iss'), 'utf8');
  assert.doesNotMatch(zipBuild, /cp\s+.*安装失败自主解决提示词/);
  assert.doesNotMatch(installerBuild, /Test-Path[\s\S]{0,160}安装失败自主解决提示词/);
  assert.doesNotMatch(iss, /Source:.*安装失败自主解决提示词/);
});
