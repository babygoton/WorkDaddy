'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const scriptsDir = path.join(root, 'scripts');
const launcherSource = fs.readFileSync(path.join(scriptsDir, 'win-launcher.js'), 'utf8');
const daemonSource = fs.readFileSync(path.join(scriptsDir, 'daemon.js'), 'utf8');
const watchdogSource = fs.readFileSync(path.join(scriptsDir, 'watchdog.js'), 'utf8');
const nativeSource = fs.readFileSync(path.join(scriptsDir, 'windows-native', 'main.go'), 'utf8');
const installerSource = fs.readFileSync(path.join(scriptsDir, 'install-win.ps1'), 'utf8');
const readmeSource = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const hiddenLauncherSource = fs.readFileSync(path.join(scriptsDir, 'launcher-hidden.vbs'), 'utf8');
const cmdLauncherSource = fs.readFileSync(path.join(scriptsDir, 'launcher.cmd'), 'utf8');
const boundary = require('../scripts/windows-process-boundary.js');

const resolveWindows = (value) => path.win32.normalize(value);
const nativeProcess = (process, args) => ({
  ...process,
  ArgumentsSource: 'CommandLineToArgvW',
  Arguments: args,
});

test('privilege probe distinguishes standard and elevated modes', () => {
  const fake = (result) => () => result;
  assert.equal(boundary.detectWindowsPrivilege(fake({ status: 0, stdout: 'False\r\n' })), 'standard');
  assert.equal(boundary.detectWindowsPrivilege(fake({ status: 0, stdout: 'True\r\n' })), 'elevated');
  assert.equal(boundary.assertStandardWindowsPrivilege(fake({ status: 0, stdout: 'False\r\n' })), 'standard');
  assert.throws(() => boundary.assertStandardWindowsPrivilege(fake({ status: 0, stdout: 'True\r\n' })), /管理员|elevated/i);
  assert.throws(() => boundary.assertStandardWindowsPrivilege(fake({ status: 0, stdout: '' })), /确认|determine/i);
  assert.throws(() => boundary.assertStandardWindowsPrivilege(fake({ status: 1, stderr: 'denied' })), /确认|determine|denied/i);
  assert.throws(() => boundary.assertStandardWindowsPrivilege(fake({ status: null, error: new Error('timeout') })), /timeout/);
});

test('CIM parsing rejects command failures and incomplete process identities', () => {
  const valid = { ProcessId: 101, ParentProcessId: 10, Name: 'WorkBuddyAI.exe', ExecutablePath: 'C:\\Apps\\WorkBuddyAI.exe' };
  assert.deepEqual(boundary.parseCimProcessResult({ status: 0, stdout: '' }), []);
  assert.deepEqual(boundary.parseCimProcessResult({ status: 0, stdout: JSON.stringify(valid) }), [valid]);
  assert.throws(() => boundary.parseCimProcessResult({ error: new Error('spawn failed'), status: null, stdout: '' }), /spawn failed/);
  assert.throws(() => boundary.parseCimProcessResult({ status: 1, stderr: 'access denied', stdout: '' }), /status|exit|access denied/i);
  assert.throws(() => boundary.parseCimProcessResult({ status: 0, stdout: '{broken' }), /JSON|parse/i);
  assert.throws(() => boundary.parseCimProcessResult({ status: 0, stdout: '{"ProcessId":101}' }), /Name|path|record/i);
  assert.throws(() => boundary.parseCimProcessResult({ status: 0, stdout: '{"ProcessId":0,"Name":"node.exe","ExecutablePath":"C:\\\\node.exe"}' }), /PID/i);
  assert.throws(() => boundary.parseCimProcessResult({ status: 0, stdout: JSON.stringify({ ...valid, ProcessId: '101' }) }), /PID/i);
  assert.throws(
    () => boundary.parseCimProcessResult({ status: 0, stdout: JSON.stringify({ ...valid, CommandLine: null }) }, { requireCommandLine: true }),
    /command/i
  );
});

test('profile process selection rejects multiple roots and ignores other CodeBuddy installs', () => {
  const expected = 'C:\\Program Files\\WorkBuddyAI\\WorkBuddyAI.exe';
  const rows = [
    { ProcessId: 101, Name: 'WorkBuddyAI.exe', ExecutablePath: expected },
    { ProcessId: 102, Name: 'CodeBuddy.exe', ExecutablePath: 'D:\\CodeBuddy\\CodeBuddy.exe' },
    { ProcessId: 103, Name: 'WorkBuddyAI.exe', ExecutablePath: 'D:\\Portable\\WorkBuddyAI.exe' },
  ];
  assert.deepEqual(boundary.filterVerifiedWindowsProcesses(expected, rows, resolveWindows).map((row) => row.ProcessId), [101]);
  assert.equal(
    boundary.selectRunningProfileBinary(new Set(['workbuddyai.exe']), rows.slice(0, 2), resolveWindows),
    path.win32.normalize(expected)
  );
  assert.throws(
    () => boundary.selectRunningProfileBinary(new Set(['workbuddyai.exe']), rows, resolveWindows),
    /多个|multiple|directory|目录/i
  );
});

test('enterprise process aliases are accepted only in the selected install directory', () => {
  const selected = 'C:\\Company\\WorkBuddy\\workbuddy-ent.exe';
  const names = new Set(['workbuddy-ent.exe', 'workbuddyent.exe']);
  const rows = [
    { ProcessId: 111, Name: 'WorkBuddyEnt.exe', ExecutablePath: 'C:\\Company\\WorkBuddy\\WorkBuddyEnt.exe' },
    { ProcessId: 112, Name: 'WorkBuddyEnt.exe', ExecutablePath: 'D:\\Other\\WorkBuddyEnt.exe' },
    { ProcessId: 113, Name: 'Unrelated.exe', ExecutablePath: 'C:\\Company\\WorkBuddy\\Unrelated.exe' },
  ];
  assert.deepEqual(
    boundary.filterVerifiedWindowsProcesses(selected, rows, resolveWindows, names).map((row) => row.ProcessId),
    [111]
  );
});

test('node process identity requires exact executable, PID, and script argument', () => {
  const expectedNode = 'C:\\Node\\node.exe';
  const expectedScript = 'C:\\WorkDaddy\\scripts\\daemon.js';
  const rows = [
    nativeProcess({ ProcessId: 201, Name: 'node.exe', ExecutablePath: expectedNode, CommandLine: `"${expectedNode}" --experimental-sqlite "${expectedScript}"` }, [expectedNode, '--experimental-sqlite', expectedScript]),
    nativeProcess({ ProcessId: 202, Name: 'node.exe', ExecutablePath: expectedNode, CommandLine: `"${expectedNode}" C:\\Other\\daemon.js` }, [expectedNode, 'C:\\Other\\daemon.js']),
    nativeProcess({ ProcessId: 203, Name: 'node.exe', ExecutablePath: 'D:\\Node\\node.exe', CommandLine: `"D:\\Node\\node.exe" "${expectedScript}"` }, ['D:\\Node\\node.exe', expectedScript]),
    nativeProcess({ ProcessId: 204, Name: 'node.exe', ExecutablePath: expectedNode, CommandLine: `"${expectedNode}" C:\\Other\\other.js "${expectedScript}"` }, [expectedNode, 'C:\\Other\\other.js', expectedScript]),
  ];
  assert.deepEqual(
    boundary.filterVerifiedNodeProcesses(expectedNode, expectedScript, rows, resolveWindows).map((row) => row.ProcessId),
    [201]
  );
  assert.throws(
    () => boundary.assertVerifiedNodeProcess(202, expectedNode, expectedScript, rows, resolveWindows),
    /verify|验证|identity/i
  );
  assert.throws(
    () => boundary.assertVerifiedNodeProcess(204, expectedNode, expectedScript, rows, resolveWindows),
    /verify|验证|identity/i
  );
});

test('disk discovery rejects duplicate current-profile installations', () => {
  assert.equal(
    boundary.sameWindowsPath(boundary.selectUniqueDiscoveredBinary(
      new Set(['workbuddy.exe']),
      ['C:\\Apps\\WorkBuddy.exe', 'c:\\apps\\WORKBUDDY.exe'],
      resolveWindows
    ), path.win32.normalize('C:\\Apps\\WorkBuddy.exe')),
    true
  );
  assert.throws(
    () => boundary.selectUniqueDiscoveredBinary(
      new Set(['workbuddy.exe']),
      ['C:\\Apps\\WorkBuddy.exe', 'D:\\Portable\\WorkBuddy.exe'],
      resolveWindows
    ),
    /WBSWITCH_WORKBUDDY_BIN|多个|multiple/i
  );
});

test('dormant duplicate installations use discovery priority while missing paths are ignored', () => {
  const resolveMissing = (value) => {
    if (String(value).includes('missing')) {
      const error = new Error('not found');
      error.code = 'ENOENT';
      throw error;
    }
    return path.win32.normalize(value);
  };
  assert.equal(
    boundary.selectPreferredDiscoveredBinary(
      new Set(['workbuddy.exe']),
      ['C:\\missing\\WorkBuddy.exe', 'D:\\Preferred\\WorkBuddy.exe', 'E:\\Old\\WorkBuddy.exe'],
      resolveMissing
    ),
    path.win32.normalize('D:\\Preferred\\WorkBuddy.exe')
  );
  assert.deepEqual(
    boundary.filterVerifiedNodeProcesses(
      'C:\\missing\\node.exe', 'C:\\missing\\daemon.js', [], resolveMissing
    ),
    []
  );
});

test('daemon status identity binds metadata, listener PID, node path, and script path', () => {
  const expectedNode = 'C:\\Node\\node.exe';
  const expectedScript = 'C:\\WorkDaddy\\scripts\\daemon.js';
  const process = nativeProcess({
    ProcessId: 301, Name: 'node.exe', ExecutablePath: expectedNode,
    CommandLine: `"${expectedNode}" --experimental-sqlite "${expectedScript}"`,
  }, [expectedNode, '--experimental-sqlite', expectedScript]);
  const status = { version: '1.0.14', buildId: 'build-a', profile: { id: 'workbuddy-cn' }, privilege: 'standard', pid: 301 };
  const input = {
    status,
    expectedVersion: '1.0.14', expectedBuildId: 'build-a', expectedProfileId: 'workbuddy-cn', expectedPrivilege: 'standard',
    listenerPids: [301], nodeProcesses: [process], expectedNode, expectedScript, realpath: resolveWindows,
  };
  assert.equal(boundary.assertDaemonServiceIdentity(input).ProcessId, 301);
  assert.equal(
    boundary.assertDaemonServiceIdentity({
      ...input,
      expectedPrivilege: 'elevated',
      status: { ...status, privilege: 'elevated' },
    }).ProcessId,
    301
  );
  assert.throws(() => boundary.assertDaemonServiceIdentity({ ...input, status: { ...status, buildId: 'old' } }), /build/i);
  assert.throws(() => boundary.assertDaemonServiceIdentity({ ...input, listenerPids: [999] }), /listener|监听|PID/i);
  assert.throws(() => boundary.assertDaemonServiceIdentity({ ...input, status: { ...status, privilege: 'elevated' } }), /privilege|权限/i);
  assert.throws(() => boundary.assertDaemonServiceIdentity({ ...input, status: { ...status, pid: '301' } }), /PID/i);
});

test('Windows native entry point enforces standard privilege and exposes daemon identity', () => {
  assert.equal(fs.existsSync(path.join(scriptsDir, 'win-inject-helper.js')), false);
  assert.match(nativeSource, /TokenElevation/);
  assert.match(nativeSource, /func isElevated\(\)/);
  assert.match(nativeSource, /if elevated \{/);
  assert.match(nativeSource, /WBSWITCH_NATIVE_LAUNCHER=1/);
  assert.match(daemonSource, /detectWindowsPrivilege/);
  assert.match(daemonSource, /privilege:\s*DAEMON_PRIVILEGE/);
  assert.match(daemonSource, /pid:\s*process\.pid/);
  assert.match(watchdogSource, /net\.createServer\(\)/);
  assert.match(watchdogSource, /exclusive:\s*true/);
  assert.doesNotMatch(watchdogSource, /powershell|Get-CimInstance|Invoke-CimMethod|taskkill/i);
  assert.match(nativeSource, /expectedNode := filepath\.Join\(appDir, "scripts", "runtime", "node", "node\.exe"\)/);
  assert.match(nativeSource, /if !samePath\(actual, expectedPath\)/);
  assert.doesNotMatch(nativeSource + daemonSource, /Start-Process[^\n]*-Verb\s+RunAs/i);
  assert.doesNotMatch(installerSource, /请以管理员身份运行/);
  assert.doesNotMatch(readmeSource, /右键以管理员身份运行 WorkDaddy/);
});

test('Windows installer stops the verified profile lifecycle before replacing or launching files', () => {
  const stopIndex = installerSource.indexOf('Stop-VerifiedWorkDaddyLifecycle');
  const copyIndex = installerSource.indexOf('& robocopy @copyArgs');
  const launchIndex = installerSource.indexOf('# 4) 启动');
  assert.ok(stopIndex >= 0, 'installer must stop an existing verified lifecycle');
  assert.ok(stopIndex < copyIndex, 'lifecycle must stop before files are replaced');
  assert.ok(stopIndex < launchIndex, 'lifecycle must stop before the new launcher starts');
  assert.match(installerSource, /\$uiPort\s*=\s*if \(\$Profile -eq 'workbuddy-ai'\) \{ 47833 \} else \{ 47832 \}/);
  assert.match(installerSource, /-ExpectedWatchdogScript \(Join-Path \$AppDir 'scripts\\watchdog\.js'\)/);
  assert.match(installerSource, /-ExpectedDaemonScript \(Join-Path \$AppDir 'scripts\\daemon\.js'\)/);
  assert.match(installerSource, /\$preserveExistingLifecycle/);
  assert.match(installerSource, /runtime\\node/);
});

test('PowerShell lifecycle scopes daemon discovery to a verified watchdog parent', () => {
  const boundary = fs.readFileSync(path.join(scriptsDir, 'windows-process-boundary.ps1'), 'utf8');
  const pidValidation = boundary.indexOf('$watchdog = Assert-NodeProcessIdentity');
  const childDiscovery = boundary.indexOf('Get-UniqueNodeProcessForScript -ExpectedScript $ExpectedDaemonScript -ExpectedParentProcessId');
  assert.ok(pidValidation >= 0, 'watchdog.pid candidate must be fully identity-checked');
  assert.ok(childDiscovery > pidValidation, 'daemon discovery must be scoped after watchdog identity validation');
  assert.match(boundary, /if \(\$null -ne \$watchdog\)[\s\S]*-ExpectedParentProcessId \(\[int\]\$watchdog\.ProcessId\)/);
  assert.match(boundary, /Name = 'node\.exe' AND SessionId = \$currentSessionId/);
  assert.match(boundary, /\$null -ne \$currentListenerPid -and \$currentListenerPid -ne \$listenerPid/);
  assert.match(boundary, /\$taskkillFailed = \$LASTEXITCODE -ne 0/);
  assert.match(boundary, /for \(\$attempt = 0; \$attempt -lt 20; \$attempt\+\+\)[\s\S]*Get-StrictProcessRecord -ProcessId \$targetPid[\s\S]*catch/);
});

test('watchdog uses an OS-managed profile lock and no process scanner', () => {
  assert.match(watchdogSource, /const LOCK_PORT = PROFILE\.id === 'workbuddy-ai' \? 47933 : 47932/);
  assert.match(watchdogSource, /const lockServer = net\.createServer\(\)/);
  assert.match(watchdogSource, /lockServer\.listen\(\{ host: '127\.0\.0\.1', port: LOCK_PORT, exclusive: true \}/);
  assert.match(watchdogSource, /error\.code === 'EADDRINUSE'/);
  assert.doesNotMatch(watchdogSource, /spawnSync|powershell|Get-CimInstance|taskkill/i);
});

test('native lifecycle stop validates the bundled node path before termination', () => {
  const expectedNode = nativeSource.indexOf('expectedNode := filepath.Join(appDir, "scripts", "runtime", "node", "node.exe")');
  const identityCheck = nativeSource.indexOf('if !samePath(actual, expectedPath)');
  const terminate = nativeSource.indexOf('procTerminateProcess.Call', identityCheck);
  const lifecycleCall = nativeSource.indexOf('terminateExactNode(candidate.pid, expectedNode)', expectedNode);
  assert.ok(expectedNode >= 0, 'native helper must derive the bundled node path from the target app');
  assert.ok(identityCheck >= 0, 'process path must be checked against the bundled node path');
  assert.ok(terminate > identityCheck, 'termination must happen only after the exact path check');
  assert.ok(lifecycleCall > expectedNode, 'lifecycle stop must pass the derived path into the terminating helper');
  assert.match(nativeSource, /func terminateWorkBuddy\(profile string\)/);
  assert.match(nativeSource, /if len\(paths\) != 1/);
  assert.match(nativeSource, /--terminate-workbuddy/);
  assert.match(nativeSource, /exitAccessDenied/);
  assert.match(nativeSource, /exitIdentityMismatch/);
  assert.match(nativeSource, /if elevated \{[\s\S]*return true, exitAccessDenied/);
});

test('native termination maps TerminateProcess access denial to the permission exit code', () => {
  const start = nativeSource.indexOf('result, _, callErr := procTerminateProcess.Call');
  const end = nativeSource.indexOf('\n\twaitResult, _, callErr := procWaitForSingleObject.Call', start);
  assert.ok(start >= 0 && end > start);
  const branch = nativeSource.slice(start, end);
  assert.match(branch, /if result == 0/);
  assert.match(branch, /errors\.Is\(callErr, syscall\.ERROR_ACCESS_DENIED\)/);
  assert.match(branch, /return false, exitAccessDenied/);
});

test('packaged scripts contain no WorkBuddy image-name kill or stale elevation helper', () => {
  const sources = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'builtin') continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (/\.(?:js|cmd|ps1|vbs|sh)$/i.test(entry.name)) sources.push([file, fs.readFileSync(file, 'utf8')]);
    }
  };
  visit(scriptsDir);
  for (const [file, source] of sources) {
    assert.doesNotMatch(source, /(?:taskkill(?:\.exe)?[^\r\n]*\/IM[^\r\n]*WorkBuddy|\/IM[^\r\n]*WorkBuddy)/i, file);
    assert.doesNotMatch(source, /win-inject-helper|--inject-helper/i, file);
  }
  assert.equal(fs.existsSync(path.join(scriptsDir, 'kill.js')), false);
});

test('logout and restart paths refuse unverified profile processes', () => {
  assert.match(launcherSource, /selectRunningProfileBinary/);
  assert.match(daemonSource, /selectRunningProfileBinary/);
  assert.match(launcherSource, /存在当前 profile 进程，但没有进程属于已验证安装目录/);
  assert.match(daemonSource, /存在当前 profile 进程，但没有进程属于已验证安装目录/);
  assert.match(daemonSource, /requireCurrentOwner:\s*true/);
  assert.match(daemonSource, /requireNativeArguments:\s*true/);
  assert.match(daemonSource, /assertSameProcessIdentity/);
  assert.match(daemonSource, /revalidateWindowsWorkBuddyProcess/);
  const quitFunction = daemonSource.slice(
    daemonSource.indexOf('async function quitWorkBuddy'),
    daemonSource.indexOf('/** 探测 WorkDaddy.app', daemonSource.indexOf('async function quitWorkBuddy'))
  );
  assert.match(quitFunction, /revalidateWindowsWorkBuddyProcess[\s\S]*taskkill[\s\S]*revalidateWindowsWorkBuddyProcess[\s\S]*taskkill/);
  const logoutStart = daemonSource.indexOf("p === '/api/logout'");
  const quitIndex = daemonSource.indexOf('await quitWorkBuddy()', logoutStart);
  const unlinkIndex = daemonSource.indexOf('fs.unlinkSync(AUTH_FILE)', logoutStart);
  assert.ok(logoutStart >= 0 && quitIndex > logoutStart && unlinkIndex > quitIndex);
});

test('Windows self-check includes the shared boundary and old admin comments are removed', () => {
  const verify = fs.readFileSync(path.join(scriptsDir, 'verify-win.cmd'), 'utf8');
  assert.match(verify, /win-launcher\.js windows-process-boundary\.js/);
  assert.doesNotMatch(verify, /安装失败自主解决提示词\.txt/);
  assert.doesNotMatch(verify, /win-inject-helper\.js/);
  assert.doesNotMatch(hiddenLauncherSource + cmdLauncherSource, /shortcut as administrator|管理员启动/i);
});
