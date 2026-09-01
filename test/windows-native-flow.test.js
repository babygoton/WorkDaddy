'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const test = require('node:test');
const { launchWindowsInstaller } = require('../scripts/windows-installer-launch.js');
const { nativeLaunchFailed, strictPowerShellLines } = require('../scripts/win-launcher.js');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('Windows native launcher is the packaged user-level entry point', () => {
  const installer = read('scripts/win/workdaddy.iss');
  const build = read('scripts/build-win-zip.sh');
  const source = read('scripts/windows-native/main.go');

  assert.match(installer, /Filename: "\{app\}\\WorkDaddyLauncher\.exe"/);
  assert.doesNotMatch(installer, /launcher-hidden\.vbs|wscript\.exe/i);
  assert.match(build, /WorkDaddyLauncher\.exe/);
  assert.match(source, /TokenElevation/);
  assert.match(source, /CreateMutexW/);
  assert.match(source, /WBSWITCH_NATIVE_LAUNCHER/);
  assert.match(source, /mbRetryCancel/);
});

test('Windows shortcuts use a versioned icon path to invalidate the shell icon cache', () => {
  const installer = read('scripts/win/workdaddy.iss');
  assert.match(installer, /DestName: "\{#PackageName\}-\{#AppVersion\}\.ico"/);
  assert.match(installer, /IconFilename: "\{app\}\\scripts\\\{#PackageName\}-\{#AppVersion\}\.ico"/);
  assert.match(installer, /\[InstallDelete\][\s\S]*WorkDaddy-\*\.ico/);
  assert.doesNotMatch(installer, /IconFilename: "\{app\}\\scripts\\WorkDaddy\.ico"/);
});

test('normal Windows startup does not use Explorer de-elevation or CIM', () => {
  const launcher = read('scripts/win-launcher.js');
  const watchdog = read('scripts/watchdog.js');

  assert.match(launcher, /async function nativeStartupMain/);
  assert.match(launcher, /WBSWITCH_NATIVE_LAUNCHER/);
  const nativeStart = launcher.slice(
    launcher.indexOf('async function nativeStartupMain'),
    launcher.indexOf('// ---------- legacy script entry ----------')
  );
  assert.doesNotMatch(nativeStart, /Get-CimInstance|windows-relaunch-standard|quitWorkBuddy/);
  assert.doesNotMatch(watchdog, /Get-CimInstance|windows-process-boundary|pending\.json/);
});

test('installer waits for the exact profile client with a visible recheck dialog', () => {
  const installer = read('scripts/win/workdaddy.iss');

  assert.match(installer, /function EnsureWorkBuddyClosed/);
  assert.match(installer, /--check-workbuddy/);
  assert.match(installer, /Caption := '\u91cd\u65b0\u68c0\u6d4b'/);
  assert.match(installer, /Caption := '\u7ed3\u675f\u8fdb\u7a0b'/);
  assert.match(installer, /Caption := '\u53d6\u6d88'/);
  assert.match(installer, /--terminate-workbuddy/);
  assert.match(installer, /--stop-lifecycle/);
  assert.match(installer, /IsAdminInstallMode/);
  assert.match(installer, /当前安装程序是以管理员权限运行的/);
  assert.match(installer, /ExecAsOriginalUser\(/);
  assert.match(installer, /runasoriginaluser/);
  assert.match(installer, /PrivilegesRequired=lowest/);
  assert.match(installer, /CloseApplications=no/);
});

test('installer does not expand the app directory while initializing the client page', () => {
  const installer = read('scripts/win/workdaddy.iss');
  const helperStart = installer.indexOf('function RunNativeHelper');
  const helperEnd = installer.indexOf('\nfunction ', helperStart + 1);
  const initializeStart = installer.indexOf('procedure InitializeWizard');
  const initializeEnd = installer.indexOf('\nfunction ', initializeStart + 1);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  assert.ok(initializeStart >= 0 && initializeEnd > initializeStart);
  assert.doesNotMatch(installer.slice(helperStart, helperEnd), /ExpandConstant\('\{app\}'\)/);
  assert.doesNotMatch(installer.slice(initializeStart, initializeEnd), /ExpandConstant\('\{app\}'\)/);
  assert.match(installer, /--stop-lifecycle --app-dir "' \+ ExpandConstant\('\{app\}'\) \+ '"/);
});

test('installer prefers the newest registered official client without replacing enterprise targets', () => {
  const installer = read('scripts/win/workdaddy.iss');
  const native = read('scripts/windows-native/main.go');
  assert.match(installer, /CurrentVersion\\Uninstall/);
  assert.match(installer, /DisplayIcon/);
  assert.match(installer, /InstallLocation/);
  assert.match(installer, /for Index := Length\(Value\) downto 1 do/);
  assert.match(installer, /ExtractFileExt\(Copy\(Value, 1, Marker - 1\)\)/);
  assert.match(installer, /CompareClientFileVersions\(Candidate, BestCandidate\) > 0/);
  assert.match(installer, /PreferDetectedOfficialClient/);
  assert.match(installer, /CompareText\(SavedClientType, 'enterprise'\) = 0/);
  assert.match(native, /ClientType\s+string\s+`json:"clientType"`/);
  assert.match(native, /target\.Binary\+"\\r\\n"\+version\+"\\r\\n"\+clientType/);
});

test('Windows update opens the verified Setup visibly and keeps daemon alive', () => {
  const daemon = read('scripts/daemon.js');
  const inject = read('scripts/inject.js');
  const windowsBranchStart = daemon.indexOf('if (IS_WIN) {', daemon.indexOf('function applyUpdate()'));
  const macBranchStart = daemon.indexOf("const scriptPath = path.join(__dirname, 'apply-update.sh')", windowsBranchStart);
  const windowsBranch = daemon.slice(windowsBranchStart, macBranchStart);

  assert.match(windowsBranch, /launchWindowsInstaller\(srcPackage\)/);
  assert.match(windowsBranch, /installer-opened/);
  assert.doesNotMatch(windowsBranch, /apply-update\.ps1|apply-update\.vbs|pending\.json|process\.exit/);
  assert.doesNotMatch(windowsBranch, /VERYSILENT|SILENT/i);
  assert.match(inject, /\u6253\u5f00\u5b89\u88c5\u7a0b\u5e8f/);
  assert.match(inject, /function showWindowsInstallerReady[\s\S]*\u6253\u5f00\u5b89\u88c5\u7a0b\u5e8f/);
  assert.match(inject, /WBS_PLATFORM === 'win32'[\s\S]*showWindowsInstallerReady/);
});

test('Windows installer launch uses a visible detached process without shell arguments', async () => {
  let call = null;
  let unreferenced = false;
  const fakeSpawn = (file, args, options) => {
    call = { file, args, options };
    const child = new EventEmitter();
    child.pid = 424242;
    child.unref = () => { unreferenced = true; };
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  const child = launchWindowsInstaller('C:\\Updates\\WorkDaddy-Setup-9.9.9.exe', fakeSpawn);
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
  assert.deepEqual(call, {
    file: 'C:\\Updates\\WorkDaddy-Setup-9.9.9.exe',
    args: [],
    options: { detached: true, stdio: 'ignore', windowsHide: false },
  });
  assert.equal(unreferenced, true);
  assert.throws(() => launchWindowsInstaller('C:\\Updates\\legacy.zip', fakeSpawn), /Setup\.exe/);
});

test('macOS update still uses the existing apply-update shell script', () => {
  const daemon = read('scripts/daemon.js');
  const applyStart = daemon.indexOf('function applyUpdate()');
  const branch = daemon.slice(applyStart, daemon.indexOf('// ================', applyStart));
  assert.match(branch, /apply-update\.sh/);
  assert.match(branch, /extractAppFromDmg/);
  assert.match(branch, /spawn\('bash'/);
});

test('native helper keeps WorkBuddy CN and AI process detection isolated', () => {
  const source = read('scripts/windows-native/main.go');
  const launcher = read('scripts/win-launcher.js');
  assert.match(source, /workbuddy-cn[\s\S]*WorkBuddy\.exe/);
  assert.match(source, /workbuddy-ai[\s\S]*WorkBuddyAI\.exe/);
  assert.match(source, /QueryFullProcessImageNameW/);
  assert.match(source, /func terminateWorkBuddy\(profile string\)/);
  assert.match(source, /uniqueRunningWorkBuddyPath/);
  assert.match(source, /terminateExactProcess\(int\(match\.PID\), expectedPath, "WorkBuddy"\)/);
  assert.match(source, /lifecycle stop requires standard user privilege/);
  assert.match(launcher, /path\.join\(programFiles, 'WorkBuddy', 'WorkBuddy\.exe'\)/);
  assert.match(launcher, /path\.join\(programFilesX86, 'WorkBuddy', 'WorkBuddy\.exe'\)/);
});

test('native lifecycle cleanup accepts a PID that exits during exact inspection', () => {
  const source = read('scripts/windows-native/main.go');
  const missingPath = source.indexOf('if actual == ""');
  const exitedCheck = source.indexOf('procWaitForSingleObject.Call(uintptr(handle), 2000)', missingPath);
  const mismatch = source.indexOf('return false, exitIdentityMismatch', missingPath);
  assert.ok(missingPath >= 0 && exitedCheck > missingPath && mismatch > exitedCheck);
  assert.match(source.slice(exitedCheck, mismatch), /waitResult == waitObject0[\s\S]*return false, 0, nil/);
});

test('native lifecycle can recover a missing watchdog PID only from a unique daemon parent', () => {
  const source = read('scripts/windows-native/main.go');
  assert.match(source, /ParentPID\s+uint32/);
  assert.match(source, /ParentPID:\s*entry\.ParentProcessID/);
  assert.match(source, /func recoverWatchdogPID\(/);
  assert.match(source, /daemonPID\s*int/);
  assert.match(source, /len\(candidates\) != 1/);
  assert.match(source, /candidate\.Path/);
  const stopStart = source.indexOf('func stopLifecycle(profile, appDir string) int');
  const stopEnd = source.indexOf('\nfunc appendLog(', stopStart);
  assert.ok(stopStart >= 0 && stopEnd > stopStart);
  const stop = source.slice(stopStart, stopEnd);
  assert.match(stop, /recoverWatchdogPID\(/);
  assert.match(stop, /readLockPID\(/);
  assert.match(stop, /watchdog\.pid[\s\S]*无法证明当前 daemon 的唯一 watchdog[\s\S]*return exitIdentityMismatch/);
});

test('installer lifecycle cleanup releases only the exact installed native launcher', () => {
  const source = read('scripts/windows-native/main.go');
  const stopStart = source.indexOf('func stopInstalledLauncher(appDir string) int');
  const stopEnd = source.indexOf('\nfunc uniqueRunningWorkBuddyPath(', stopStart);
  assert.ok(stopStart >= 0 && stopEnd > stopStart);
  const stop = source.slice(stopStart, stopEnd);
  assert.match(stop, /filepath\.Join\(appDir, "WorkDaddyLauncher\.exe"\)/);
  assert.match(stop, /enumerateProcesses\(\)/);
  assert.match(stop, /record\.PID == uint32\(os\.Getpid\(\)\)[\s\S]*continue/);
  assert.match(stop, /samePath\(record\.Path, expectedLauncher\)/);
  assert.match(stop, /len\(matches\) > 1[\s\S]*exitIdentityMismatch/);
  assert.match(stop, /terminateExactProcess\(int\(matches\[0\]\.PID\), expectedLauncher, "launcher"\)/);
});

test('native startup retains portable and registered WorkBuddy discovery without CIM', () => {
  const launcher = read('scripts/win-launcher.js');
  const nativeFinderStart = launcher.indexOf('function findWorkBuddyNative()');
  const nativeFinderEnd = launcher.indexOf('\nfunction nativeDaemonStatusMatches', nativeFinderStart);
  assert.ok(nativeFinderStart >= 0 && nativeFinderEnd > nativeFinderStart);
  const nativeFinder = launcher.slice(nativeFinderStart, nativeFinderEnd);
  assert.match(nativeFinder, /--list-workbuddy/);
  assert.match(nativeFinder, /WBSWITCH_WORKBUDDY_DIR/);
  assert.match(nativeFinder, /App Paths/);
  assert.match(nativeFinder, /CurrentVersion\\\\Uninstall/);
  assert.match(nativeFinder, /Get-ChildItem[\s\S]*-Depth 5/);
  assert.doesNotMatch(nativeFinder, /Get-CimInstance/);
});

test('PowerShell discovery preserves non-ASCII installation paths', { skip: process.platform !== 'win32' }, () => {
  const expected = 'D:\\沃克巴迪\\WorkBuddyAI\\WorkBuddyAI.exe';
  assert.deepEqual(strictPowerShellLines(`Write-Output '${expected}'`), [expected]);
});

test('native upgrade stops a managed-Node lifecycle only through the verified JS boundary', () => {
  const launcher = read('scripts/win-launcher.js');
  assert.match(launcher, /async function stopVerifiedLegacyManagedLifecycle\(bundledNode\)/);
  const cleanupStart = launcher.indexOf('async function stopVerifiedLegacyManagedLifecycle(bundledNode)');
  const cleanupEnd = launcher.indexOf('\nfunction nativeDaemonStatusMatches', cleanupStart);
  const cleanup = launcher.slice(cleanupStart, cleanupEnd);
  assert.match(cleanup, /findNode\(\)/);
  assert.match(cleanup, /sameWindowsPath\(legacyNode, bundledNode\)/);
  assert.match(cleanup, /await stopDaemonByPort\(legacyNode\)/);
  assert.doesNotMatch(cleanup, /taskkill|terminateExactNode/);
  const ensureStart = launcher.indexOf('async function ensureDaemonNative(nodeBin)');
  const ensureEnd = launcher.indexOf('\nasync function waitForWorkBuddyCdpNative', ensureStart);
  const ensure = launcher.slice(ensureStart, ensureEnd);
  assert.ok(
    ensure.indexOf('stopVerifiedLegacyManagedLifecycle(nodeBin)') < ensure.indexOf('stopNativeLifecycle()'),
    'verified legacy cleanup must run before the bundled-node-only native helper'
  );
});

test('native startup failures report one structured diagnostic event', () => {
  const launcher = read('scripts/win-launcher.js');
  const nativeMainStart = launcher.indexOf('async function nativeStartupMain()');
  const nativeMainEnd = launcher.indexOf('\n// ---------- legacy script entry', nativeMainStart);
  const nativeMain = launcher.slice(nativeMainStart, nativeMainEnd);
  assert.match(nativeMain, /nativeWorkBuddyDiscoverySummary\(\)/);
  assert.match(nativeMain, /nativeCdpDiagnostics/);
  assert.doesNotMatch(nativeMain, /captureMessage\('未找到 WorkBuddy\.exe'/);
  assert.match(launcher, /error\.sentryStage/);
  assert.match(launcher, /error\.sentryExtra/);
  assert.match(launcher, /nativeDaemonDiagnostics/);
});

test('native startup precisely restarts a verified WorkBuddy without CDP', () => {
  const launcher = read('scripts/win-launcher.js');
  const stopStart = launcher.indexOf('function stopNativeWorkBuddy()');
  const stopEnd = launcher.indexOf('\nfunction ', stopStart + 1);
  assert.ok(stopStart >= 0 && stopEnd > stopStart);
  const stop = launcher.slice(stopStart, stopEnd);
  assert.match(stop, /--terminate-workbuddy/);
  assert.match(stop, /--profile[\s\S]*PROFILE\.id/);
  assert.match(stop, /result\.status !== 0[\s\S]*throw new Error/);

  const nativeMainStart = launcher.indexOf('async function nativeStartupMain()');
  const nativeMainEnd = launcher.indexOf('\n// ---------- legacy script entry', nativeMainStart);
  const nativeMain = launcher.slice(nativeMainStart, nativeMainEnd);
  assert.match(nativeMain, /nativeWorkBuddyRunning\(\)[\s\S]*stopNativeWorkBuddy\(\)[\s\S]*waitForWorkBuddyCdpNative/);
  assert.doesNotMatch(nativeMain, /return 10/);
});

test('native CDP startup detects failed child launches instead of waiting for the full timeout', () => {
  assert.equal(nativeLaunchFailed(null), false);
  assert.equal(nativeLaunchFailed({ errorCode: null, exitCode: null }), false);
  assert.equal(nativeLaunchFailed({ errorCode: null, exitCode: 0 }), false);
  assert.equal(nativeLaunchFailed({ errorCode: 'ENOENT', exitCode: null }), true);
  assert.equal(nativeLaunchFailed({ errorCode: null, exitCode: 9 }), true);

  const launcher = read('scripts/win-launcher.js');
  const waitStart = launcher.indexOf('async function waitForWorkBuddyCdpNative(binary)');
  const waitEnd = launcher.indexOf('\nasync function nativeStartupMain()', waitStart);
  const wait = launcher.slice(waitStart, waitEnd);
  assert.match(wait, /nativeLaunchFailed\(nativeLaunchState\)/);
  assert.match(wait, /windows-native-launcher-workbuddy-exit/);
  assert.match(wait, /stopNativeWorkBuddy\(\)[\s\S]*start\(\)/);
});
