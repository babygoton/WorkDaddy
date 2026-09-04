'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const launcherSource = fs.readFileSync(path.join(root, 'scripts', 'win-launcher.js'), 'utf8');
const daemonSource = fs.readFileSync(path.join(root, 'scripts', 'daemon.js'), 'utf8');
const watchdogSource = fs.readFileSync(path.join(root, 'scripts', 'watchdog.js'), 'utf8');
const hiddenLauncherSource = fs.readFileSync(path.join(root, 'scripts', 'launcher-hidden.vbs'), 'utf8');
const installerSource = fs.readFileSync(path.join(root, 'scripts', 'win', 'workdaddy.iss'), 'utf8');
const chineseLanguageSource = fs.readFileSync(path.join(root, 'scripts', 'win', 'ChineseSimplified.isl'), 'utf8');
const boundarySource = fs.readFileSync(path.join(root, 'scripts', 'windows-process-boundary.js'), 'utf8');
const powershellSource = fs.readFileSync(path.join(root, 'scripts', 'windows-process-boundary.ps1'), 'utf8');
const standardRelaunchSource = fs.readFileSync(path.join(root, 'scripts', 'windows-relaunch-standard.ps1'), 'utf8');
const boundary = require('../scripts/windows-process-boundary.js');

const resolveWindows = (value) => path.win32.normalize(value);
const withNativeArguments = (row, args) => ({
  ...row,
  ArgumentsSource: 'CommandLineToArgvW',
  Arguments: args,
});

test('termination process records require a confirmed current owner', () => {
  const base = {
    ProcessId: 701,
    Name: 'node.exe',
    ExecutablePath: 'C:\\Node\\node.exe',
    CommandLine: '"C:\\Node\\node.exe" "C:\\WorkDaddy\\scripts\\daemon.js"',
  };
  const parse = (row) => boundary.parseCimProcessResult(
    { status: 0, stdout: JSON.stringify(row) },
    { requireCommandLine: true, requireCurrentOwner: true }
  );

  assert.equal(parse({ ...base, Owner: 'DESKTOP\\alice', OwnerIsCurrent: true })[0].Owner, 'DESKTOP\\alice');
  assert.throws(() => parse(base), /owner/i);
  assert.throws(
    () => parse({ ...base, Owner: 'DESKTOP\\bob', OwnerIsCurrent: false }),
    /owner|current/i
  );
});

test('same-process revalidation rejects PID reuse and owner changes', () => {
  const original = withNativeArguments({
    ProcessId: 702,
    Name: 'node.exe',
    ExecutablePath: 'C:\\Node\\node.exe',
    CommandLine: '"C:\\Node\\node.exe" "C:\\WorkDaddy\\scripts\\watchdog.js"',
    Owner: 'DESKTOP\\alice',
    OwnerIsCurrent: true,
  }, ['C:\\Node\\node.exe', 'C:\\WorkDaddy\\scripts\\watchdog.js']);
  assert.equal(boundary.assertSameProcessIdentity(original, { ...original }).ProcessId, 702);
  assert.throws(
    () => boundary.assertSameProcessIdentity(original, { ...original, Owner: 'DESKTOP\\bob' }),
    /identity|owner/i
  );
  assert.throws(
    () => boundary.assertSameProcessIdentity(original, { ...original, CommandLine: original.CommandLine + ' stop' }),
    /identity|command/i
  );
});

test('native argv evidence is mandatory, structured, and bound to expected paths', () => {
  const node = 'C:\\Node\\node.exe';
  const script = 'C:\\WorkDaddy\\daemon.js';
  const base = { ProcessId: 712, Name: 'node.exe', ExecutablePath: node, CommandLine: `"${node}" "${script}"` };
  assert.throws(() => boundary.filterVerifiedNodeProcesses(node, script, [base], resolveWindows), /Arguments|native/i);
  assert.throws(
    () => boundary.filterVerifiedNodeProcesses(node, script, [{ ...base, ArgumentsSource: 'untrusted', Arguments: [node, script] }], resolveWindows),
    /Arguments|native|source/i
  );
  assert.throws(
    () => boundary.filterVerifiedNodeProcesses(node, script, [{ ...base, ArgumentsSource: 'CommandLineToArgvW', Arguments: [node, 7] }], resolveWindows),
    /Arguments|string/i
  );
  assert.deepEqual(
    boundary.filterVerifiedNodeProcesses(node, script, [withNativeArguments(base, [node, 'C:\\Other\\daemon.js'])], resolveWindows),
    []
  );
  assert.equal(boundary.splitWindowsCommandLine, undefined);
  assert.doesNotMatch(boundarySource, /function\s+splitWindowsCommandLine/);
});

test('lifecycle entry matching rejects unexpected trailing arguments', () => {
  const node = 'C:\\Node\\node.exe';
  const script = 'C:\\WorkDaddy\\scripts\\watchdog.js';
  const row = (ProcessId, CommandLine, Arguments) => withNativeArguments(
    { ProcessId, Name: 'node.exe', ExecutablePath: node, CommandLine }, Arguments
  );
  const rows = [
    row(703, `"${node}" "${script}"`, [node, script]),
    row(704, `"${node}" "${script}" stop`, [node, script, 'stop']),
    row(705, `"${node}" "" "${script}"`, [node, '', script]),
    row(706, `"${node}" --experimental-sqlite "" "${script}"`, [node, '--experimental-sqlite', '', script]),
    row(707, `"${node}" ${String.raw`a\\\"b`} "${script}"`, [node, String.raw`a\"b`, script]),
    row(708, `"${node}"\r\n"${script}"`, [node, `\r\n${script}`]),
    row(709, `"${node}" """${script}"""`, [node, `"${script}"`]),
    row(710, `"${node}" "${script}""`, [node, `${script}"`]),
    row(711, `"${node}" "${script}\\\\"`, [node, `${script}\\`]),
    row(713, `"${node} " "${script}"`, [`${node} `, script]),
    row(714, `"${node}" "${script} "`, [node, `${script} `]),
    row(715, `"${node}" "${script}\r\n"`, [node, `${script}\r\n`]),
  ];
  assert.deepEqual(
    boundary.filterVerifiedNodeProcesses(node, script, rows, resolveWindows).map((row) => row.ProcessId),
    [703]
  );
});

test('launcher enumerates exact lifecycle entries and never kills process trees', () => {
  assert.doesNotMatch(launcherSource, /taskkill[^\r\n]*['"]\/T['"]/i);
  assert.doesNotMatch(launcherSource, /includeTree/);
  assert.match(launcherSource, /queryNodeProcesses\(nodeBin/);
  assert.match(launcherSource, /uniqueNodeProcess\(nodeBin, WATCHDOG_SCRIPT\)/);
  assert.match(launcherSource, /uniqueNodeProcess\(nodeBin, DAEMON_SCRIPT\)/);
  assert.match(launcherSource, /queryNodeProcesses\(nodeBin, null, path\.basename\(expectedScript\)\)/);
  assert.match(launcherSource, /watchdog\.pid 已从陈旧 PID=/);
  assert.match(launcherSource, /普通权限 launcher 复用已验证的 elevated 服务/);
  assert.match(launcherSource, /assertAuthenticatedDaemonCapability/);
  assert.match(launcherSource, /assertSameProcessIdentity/);
  assert.match(launcherSource, /requireCurrentOwner:\s*true/);
  assert.match(launcherSource, /taskkill 非零但目标 PID 已消失，按竞态成功处理/);
  assert.match(launcherSource, /verifyGone && await verifyGone\(\)/);
  assert.match(launcherSource, /queryNodeProcesses\(nodeBin, \[pid\]\)\.length === 0/);
  for (const source of [launcherSource, daemonSource]) {
    assert.match(source, /buildNativeProcessQuery/);
    assert.match(source, /windows-process-boundary\.ps1/);
    assert.match(source, /-ExecutionPolicy['"],\s*['"]Bypass/);
  }
  assert.match(watchdogSource, /net\.createServer\(\)/);
  assert.match(watchdogSource, /exclusive:\s*true/);
  assert.doesNotMatch(watchdogSource, /Get-CimInstance|PowerShell|taskkill/i);
});

test('installer boundary releases the exact profile launcher and waits for its runtime lock', () => {
  assert.match(powershellSource, /Get-VerifiedNodeProcessesForScript -ExpectedScript \$expectedLauncherScript/);
  assert.match(powershellSource, /foreach \(\$launcher in \$launchers\) \{ Stop-VerifiedProcess -Process \$launcher \}/);
  assert.match(powershellSource, /function Wait-VerifiedFileUnlocked/);
  assert.match(powershellSource, /Wait-VerifiedFileUnlocked -Path \(Join-Path \$scriptsDir 'runtime\\node\\node\.exe'\)/);
  assert.match(powershellSource, /function Get-VerifiedNodeProcessesForScript/);
});

test('elevated launcher relaunches through the desktop shell before starting lifecycle processes', () => {
  assert.match(launcherSource, /windows-relaunch-standard\.ps1/);
  assert.match(launcherSource, /--desktop-shell-relaunch/);
  assert.ok(
    launcherSource.indexOf('relaunchWithDesktopShell') < launcherSource.indexOf('await ensureDaemon(nodeBin)'),
    'privilege normalization must happen before the daemon lifecycle starts'
  );
  assert.match(standardRelaunchSource, /\.Windows\(\)/);
  assert.match(standardRelaunchSource, /FindWindowSW/);
  assert.match(standardRelaunchSource, /\.Document\.Application/);
  assert.match(standardRelaunchSource, /ShellExecute/);
  assert.doesNotMatch(standardRelaunchSource, /runas/i);
  assert.match(launcherSource, /仍返回 elevated token[\s\S]*showWindowsMessageBox[\s\S]*拒绝启动管理员权限/);
});

test('hidden Windows launch failures remain visible to the desktop user', () => {
  const hiddenSource = hiddenLauncherSource;
  const catchSource = launcherSource.slice(launcherSource.indexOf('})().catch((e) =>'));
  assert.match(catchSource, /showWindowsMessageBox/);
  assert.match(hiddenSource, /If status <> 0 And status <> 4 Then/);
  assert.match(hiddenSource, /MsgBox/);
});

test('Windows launcher derives and propagates its real installation root', () => {
  assert.match(launcherSource, /const WORKDADDY_APP_DIR = path\.resolve\(SCRIPTS_DIR, '\.\.'\)/);
  assert.match(launcherSource, /process\.env\.WBSWITCH_APP_DIR = WORKDADDY_APP_DIR/);
  assert.match(daemonSource, /process\.env\.WBSWITCH_APP_DIR \|\| path\.resolve\(__dirname, '\.\.'\)/);
});

test('CIM process disappearance is treated as an empty snapshot, not a launcher failure', () => {
  assert.match(boundarySource, /allowTransientNotFound/);
  assert.match(boundarySource, /0x80041002/);
  assert.match(launcherSource, /allowTransientNotFound:\s*true/);
  assert.doesNotMatch(watchdogSource, /CIM|Get-CimInstance/);
});

test('authenticated daemon capability binds token-only status to profile, data directory, and listener PID', () => {
  const status = {
    ok: true,
    pid: 716,
    version: '1.1.1',
    buildId: 'old-build',
    privilege: 'elevated',
    dataDir: 'C:\\Users\\alice\\AppData\\Roaming\\WorkDaddy',
    profile: { id: 'workbuddy-cn' },
  };
  const input = {
    status,
    expectedProfileId: 'workbuddy-cn',
    expectedVersion: '1.1.1',
    expectedDataDir: status.dataDir,
    listenerPids: [716],
  };
  assert.equal(boundary.assertAuthenticatedDaemonCapability(input).pid, 716);
  assert.throws(() => boundary.assertAuthenticatedDaemonCapability({ ...input, listenerPids: [717] }), /listener|PID/i);
  assert.throws(() => boundary.assertAuthenticatedDaemonCapability({ ...input, status: { ...status, dataDir: 'C:\\Other' } }), /data|目录/i);
  assert.throws(() => boundary.assertAuthenticatedDaemonCapability({ ...input, status: { ...status, profile: { id: 'workbuddy-ai' } } }), /profile/i);
  assert.throws(() => boundary.assertAuthenticatedDaemonCapability({ ...input, status: { ...status, version: '1.1.0' } }), /version/i);
  assert.equal(boundary.assertAuthenticatedDaemonCapability({
    ...input,
    status: { ...status, version: '1.1.0' },
    allowVersionMismatch: true,
  }).version, '1.1.0');
});

test('launcher retries while daemon listener is ready before status', () => {
  assert.match(launcherSource, /if \(!status \|\| listeners\.length !== 1\) continue/);
  assert.doesNotMatch(launcherSource, /if \(!status && listeners\.length === 0\) continue/);
});

test('daemon termination authorization is bound to current profile status and listener', () => {
  const node = 'C:\\Node\\node.exe';
  const script = 'C:\\WorkDaddy\\scripts\\daemon.js';
  const process = withNativeArguments({
    ProcessId: 716,
    Name: 'node.exe',
    ExecutablePath: node,
    CommandLine: `"${node}" "${script}"`,
  }, [node, script]);
  const input = {
    status: { pid: 716, profile: { id: 'workbuddy-cn' }, privilege: 'standard' },
    expectedProfileId: 'workbuddy-cn',
    expectedPrivilege: 'standard',
    listenerPids: [716],
    expectedNode: node,
    expectedScript: script,
    nodeProcesses: [process],
    realpath: resolveWindows,
  };

  assert.equal(boundary.assertDaemonTerminationIdentity(input).ProcessId, 716);
  assert.throws(
    () => boundary.assertDaemonTerminationIdentity({
      ...input, status: { ...input.status, profile: { id: 'workbuddy-ai' } },
    }),
    /profile/i
  );
  let foreignProfilePathChecks = 0;
  assert.throws(
    () => boundary.assertDaemonTerminationIdentity({
      ...input,
      status: { ...input.status, profile: { id: 'workbuddy-ai' } },
      realpath: (value) => { foreignProfilePathChecks++; return resolveWindows(value); },
    }),
    /profile/i
  );
  assert.equal(foreignProfilePathChecks, 0);
  assert.throws(
    () => boundary.assertDaemonTerminationIdentity({
      ...input, status: { ...input.status, privilege: 'elevated' },
    }),
    /privilege/i
  );
  assert.throws(
    () => boundary.assertDaemonTerminationIdentity({ ...input, listenerPids: [717] }),
    /listener|PID/i
  );
});

test('launcher repairs a missing PID file only for one exact watchdog and never kills unbound daemon entries', () => {
  const stateSource = launcherSource.slice(
    launcherSource.indexOf('function watchdogState'),
    launcherSource.indexOf('function validateDaemonProcess')
  );
  const stopSource = launcherSource.slice(
    launcherSource.indexOf('async function stopDaemonByPort'),
    launcherSource.indexOf('async function ensureDaemon')
  );
  const ensureSource = launcherSource.slice(
    launcherSource.indexOf('async function ensureDaemon'),
    launcherSource.indexOf('// ---------- 2/3.')
  );
  assert.match(stateSource, /!pid[\s\S]*fs\.writeFileSync\(WATCHDOG_PID_FILE, String\(exact\.ProcessId\)/);
  assert.match(stateSource, /通过精确身份恢复缺失的 watchdog\.pid/);
  assert.match(stopSource, /watchdog\.kind === 'untracked'[\s\S]*throw new Error/);
  assert.match(ensureSource, /watchdog\.kind === 'untracked'[\s\S]*throw new Error/);
  assert.match(ensureSource, /if \(watchdog\.kind === 'verified'\)/);
  assert.match(stopSource, /authorizeDaemonTermination/);
  assert.doesNotMatch(stopSource, /remainingDaemon[\s\S]*killVerifiedNodeProcess\(remainingDaemon/);
  const untrackedGuard = stopSource.indexOf("watchdog.kind === 'untracked'");
  const firstKill = stopSource.indexOf('killVerifiedNodeProcess(');
  const firstPidDelete = stopSource.indexOf('removeWatchdogPidIf(');
  assert.ok(untrackedGuard >= 0 && untrackedGuard < firstKill && untrackedGuard < firstPidDelete);
});

test('PowerShell reconciles only a proven stale watchdog PID file', () => {
  assert.match(powershellSource, /\$staleWatchdogPidFile\s*=\s*\$true/);
  assert.match(powershellSource, /Get-UniqueNodeProcessForScript -ExpectedScript \$ExpectedWatchdogScript/);
  assert.match(powershellSource, /watchdog\.pid 在清理前发生变化/);
  assert.match(powershellSource, /Remove-Item -LiteralPath \$pidFile -Force -ErrorAction Stop/);
});

test('legacy launcher recovers stale PID files while the new watchdog uses an OS lock', () => {
  assert.match(launcherSource, /watchdog\.kind === 'stale'[\s\S]*removeWatchdogPidIf\(watchdog\.pid\)/);
  assert.match(launcherSource, /已清理确认不存在的旧 watchdog\.pid/);
  assert.match(watchdogSource, /LOCK_PORT/);
  assert.match(watchdogSource, /EADDRINUSE/);
  assert.match(watchdogSource, /writePidFile\(\)/);
});

test('Windows launcher reconciles a reused PID file to an exact watchdog', () => {
  const stateSource = launcherSource.slice(
    launcherSource.indexOf('function watchdogState'),
    launcherSource.indexOf('function validateDaemonProcess')
  );
  assert.match(stateSource, /queryNodeProcesses\(nodeBin, \[pid\], path\.basename\(WATCHDOG_SCRIPT\)\)/);
  assert.match(stateSource, /if \(exact\) \{[\s\S]*fs\.writeFileSync\(WATCHDOG_PID_FILE, String\(exact\.ProcessId\)/);
  assert.match(stateSource, /watchdog\.pid 在修复前发生变化/);
});

test('Windows launcher waits for a watchdog PID file startup race before rejecting it', () => {
  assert.match(launcherSource, /async function watchdogState\(nodeBin\)/);
  assert.match(launcherSource, /for \(let attempt = 0; attempt < 10 && !pid; attempt \+= 1\)/);
  assert.match(launcherSource, /await sleep\(250\)/);
  assert.match(launcherSource, /if \(!pid && exact\)[\s\S]*通过精确身份恢复缺失的 watchdog\.pid/);
});

test('Windows launcher ignores WorkBuddy AI headless prewarm helpers during cold start', () => {
  assert.match(launcherSource, /function isPrewarmProcess\(process\)/);
  assert.match(launcherSource, /--prewarm/);
  assert.match(launcherSource, /getWorkBuddyProcesses\(\)\.filter\(\(process\) => !isPrewarmProcess\(process\)\)/);
});

test('Windows process queries are scoped to the selected Node runtime', () => {
  assert.match(launcherSource, /ExecutablePath -ieq/);
  const nativeSource = fs.readFileSync(path.join(root, 'scripts', 'windows-native', 'main.go'), 'utf8');
  assert.match(nativeSource, /expectedNode/);
  assert.match(nativeSource, /QueryFullProcessImageNameW/);
  assert.match(nativeSource, /samePath\(actual, expectedPath\)/);
});

test('optional WorkBuddy path discovery does not make launcher startup fatal', () => {
  assert.match(launcherSource, /function bestEffortPowerShellLines\(cmd, label\)/);
  assert.match(launcherSource, /bestEffortPowerShellLines\([\s\S]*'App Paths'/);
  assert.match(launcherSource, /bestEffortPowerShellLines\([\s\S]*'卸载注册表'/);
  assert.match(launcherSource, /bestEffortPowerShellLines\([\s\S]*'磁盘根目录'/);
  assert.match(launcherSource, /bestEffortPowerShellLines\([\s\S]*'安装目录扫描'/);
});

test('verified launcher lock cleanup handles repeated hidden launches', () => {
  assert.match(powershellSource, /if \(\$matches\.Count -eq 0\)/);
  assert.match(powershellSource, /foreach \(\$match in \$matches\)/);
  assert.match(hiddenLauncherSource, /WBSWITCH_NO_PAUSE=1/);
  assert.match(hiddenLauncherSource, /shell\.Run\(command, 0, True\)/);
});

test('desktop launcher only reports failures not already shown by Node', () => {
  assert.match(hiddenLauncherSource, /If status <> 0 And status <> 4 Then/);
  assert.match(hiddenLauncherSource, /WScript\.Quit status/);
  assert.match(launcherSource, /function processDiagnostics\(binary = null\) \{[\s\S]*try \{[\s\S]*catch \(error\)[\s\S]*return \[\];[\s\S]*\}/);
  assert.match(launcherSource, /进程诊断暂不可用/);
});

test('Windows installer uses the bundled Simplified Chinese wizard and profile branding', () => {
  assert.match(installerSource, /\[Languages\][\s\S]*ChineseSimplified\.isl/);
  assert.match(installerSource, /AppPublisher=\{#ProductName\} 团队/);
  assert.match(installerSource, /Description: "\{#StartDescription\}"/);
  assert.match(fs.readFileSync(path.join(root, 'scripts', 'build-win-installer.ps1'), 'utf8'), /立即打开 WorkDaddy AI/);
  assert.match(chineseLanguageSource, /LanguageName=简体中文/);
});

test('Windows cold-start restarts the verified current-profile WorkBuddy and sends a native notification', () => {
  assert.match(launcherSource, /function requireWorkBuddyClosedBeforeLaunch\(\)/);
  assert.match(launcherSource, /请先完全退出 WorkBuddy/);
  assert.match(launcherSource, /function showWindowsNotification\(title, message\)/);
  assert.match(launcherSource, /NotifyIcon/);
  assert.match(launcherSource, /spawnSync\(powershell/);
  assert.ok(
    launcherSource.indexOf('const wb = findWorkBuddy()') < launcherSource.indexOf('await quitWorkBuddy(wb)'),
    'cold start must resolve and verify the target before restarting it'
  );
  assert.doesNotMatch(launcherSource, /if \(requireWorkBuddyClosedBeforeLaunch\(\)\) process\.exit\(0\)/);
  assert.match(launcherSource, /showWindowsNotification\('WorkBuddy', '正在打开 WorkBuddy，请稍等…'\)/);
});

test('Windows daemon repairs only missing cwd directories with stored session payloads', () => {
  assert.match(daemonSource, /const DAEMON_VERSION = '\d+\.\d+\.\d+'/);
  assert.match(daemonSource, /function sessionPayloadExists\(wbHome, sessionId\)/);
  assert.match(daemonSource, /function createDirectoryNoFollow\(directory\)/);
  assert.match(daemonSource, /repairMissingSessionWorkspaces\(\)\.catch/);
  assert.match(daemonSource, /sessionCwdRepairTimer = setInterval/);
  assert.match(daemonSource, /消息文件未改动/);
});
