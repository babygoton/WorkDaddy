const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(repoRoot, 'scripts', name), 'utf8').replace(/\r\n/g, '\n');
const lib = require(path.join(repoRoot, 'scripts', 'lib.js'));

test('Windows updater launches the installed scripts launcher', () => {
  const script = read('apply-update.ps1');
  assert.match(script, /Join-Path\s+\$AppDir\s+'scripts\\launcher\.cmd'/);
  assert.match(script, /Join-Path\s+\$AppDir\s+'scripts\\launcher-hidden\.vbs'/);
  assert.match(script, /Start-Process[\s\S]*-ErrorAction Stop/);
  assert.match(script, /Invoke-RestMethod[\s\S]*\/api\/status/);
});

test('Windows updater prefers profile Setup.exe and keeps ZIP compatibility', () => {
  const daemon = read('daemon.js');
  const update = read('apply-update.ps1');
  assert.match(daemon, /profileSetup/);
  assert.match(daemon, /profileZip/);
  assert.ok(daemon.indexOf('profileSetup.test') < daemon.indexOf('profileZip.test'), 'Setup.exe must win when both assets exist');
  assert.match(daemon, /assetName.*\.exe/);
  assert.match(daemon, /packageExt/);
  assert.match(update, /Alias\('SrcZip'\)/);
  assert.match(update, /GetExtension\(\$SrcPackage\).*\.exe/);
  assert.match(update, /VERYSILENT.*SUPPRESSMSGBOXES.*NORESTART/);
  assert.match(update, /Setup\.exe 已退出/);
});

test('theme apply retries CDP evaluation and persists the selection only after success', () => {
  const daemon = read('daemon.js');
  const routeStart = daemon.indexOf("p === '/api/theme-apply'");
  const routeEnd = daemon.indexOf("p === '/api/theme-save'", routeStart);
  const route = daemon.slice(routeStart, routeEnd);
  assert.match(daemon, /Runtime\.evaluate 未返回主题结果/);
  assert.match(daemon, /await cdpActivatePage\(\)/);
  assert.match(daemon, /await connectCdp\(\)/);
  assert.match(daemon, /r\.exceptionDetails/);
  assert.match(route, /applyThemeByCdp\(id\)/);
  assert.ok(route.indexOf("fs.writeFileSync(path.join(DATA_DIR, 'current-theme.json')") > route.indexOf('.then((info)'), 'failed theme must not be persisted');
});

test('Windows updater opens the verified Setup directly without a script bridge', () => {
  const daemon = read('daemon.js');
  const build = fs.readFileSync(path.join(repoRoot, 'scripts', 'build-win-zip.sh'), 'utf8');
  const branchStart = daemon.indexOf('if (IS_WIN) {', daemon.indexOf('function applyUpdate()'));
  const branchEnd = daemon.indexOf("const scriptPath = path.join(__dirname, 'apply-update.sh')", branchStart);
  const branch = daemon.slice(branchStart, branchEnd);
  assert.match(build, /WorkDaddyLauncher\.exe/);
  assert.match(branch, /launchWindowsInstaller\(srcPackage\)/);
  assert.match(branch, /installer-opened/);
  assert.doesNotMatch(branch, /apply-update\.vbs|wscript|pending\.json/);
});

test('update status exposes the running daemon version so reboot polling can finish', () => {
  const daemon = read('daemon.js');
  const statusStart = daemon.indexOf("p === '/api/update-status'");
  const statusEnd = daemon.indexOf("p === '/api/update-download'", statusStart);
  assert.ok(statusStart >= 0 && statusEnd > statusStart);
  const statusBlock = daemon.slice(statusStart, statusEnd);
  assert.match(statusBlock, /version:\s*DAEMON_VERSION/);
});

test('update download starts asynchronously and reports transfer telemetry', () => {
  const daemon = read('daemon.js');
  const routeStart = daemon.indexOf("p === '/api/update-download'");
  const routeEnd = daemon.indexOf("p === '/api/update-apply'", routeStart);
  const statusStart = daemon.indexOf("p === '/api/update-status'");
  const statusEnd = daemon.indexOf("p === '/api/update-download'", statusStart);
  const statusBlock = daemon.slice(statusStart, statusEnd);
  assert.ok(routeStart >= 0 && routeEnd > routeStart);
  const route = daemon.slice(routeStart, routeEnd);
  assert.match(route, /downloadUpdate\(\)\.then/);
  assert.match(route, /return json\(res, 202/);
  assert.match(daemon, /downloadRate/);
  assert.match(daemon, /etaSeconds/);
  assert.match(daemon, /downloadedBytes/);
  assert.match(daemon, /totalBytes/);
  assert.match(statusBlock, /downloadRate/);
  assert.match(statusBlock, /etaSeconds/);
});

test('update progress hides zero-rate and unknown-ETA placeholder text', () => {
  const inject = read('inject.js');
  assert.match(inject, /function formatDownloadTransfer\(status\)/);
  assert.match(inject, /if \(rate > 0\)/);
  assert.match(inject, /transfer = formatDownloadTransfer\(s\)/);
});

test('Windows updater stops the watchdog before waiting for the API port', () => {
  const script = read('apply-update.ps1');
  const stop = script.indexOf('function Stop-WatchdogAndPort');
  const wait = script.indexOf('Invoke-RestMethod');
  assert.notEqual(stop, -1);
  assert.notEqual(wait, -1);
  assert.ok(stop < wait, 'watchdog shutdown must precede the port wait');
  assert.match(script, /Stop-VerifiedWorkDaddyLifecycle/);
});

test('Windows install and update release a locked launcher before replacing it', () => {
  const install = read('install-win.ps1');
  const update = read('apply-update.ps1');
  const boundary = read('windows-process-boundary.ps1');
  assert.match(boundary, /FileShare\]\s*::None/);
  assert.match(install, /launcher\.cmd/);
  assert.match(boundary, /Get-CimInstance\s+Win32_Process/);
  assert.match(boundary, /Test-ExactCmdLauncherCommandLine/);
  assert.doesNotMatch(boundary, /taskkill[^\r\n]*\/T\b/i);
  assert.ok(install.indexOf('Release-VerifiedLauncherLock') < install.indexOf('& robocopy @copyArgs'), 'install must release launcher before robocopy');
  assert.match(update, /launcher\.cmd/);
  assert.ok(update.indexOf('Release-VerifiedLauncherLock') < update.indexOf('Move-Item -LiteralPath $AppDir'), 'update must release launcher before moving the old app');
});

test('Windows updater stops the verified WorkBuddy process before replacing its installation directory', () => {
  const update = read('apply-update.ps1');
  const boundary = read('windows-process-boundary.ps1');
  assert.match(boundary, /function Stop-VerifiedWorkBuddyProcesses/);
  assert.match(boundary, /WorkBuddyAI\)\\\.exe/);
  assert.match(boundary, /多个 WorkBuddy 安装正在运行/);
  assert.match(update, /function Stop-WorkBuddyForUpdate/);
  assert.ok(update.indexOf('Stop-WorkBuddyForUpdate') < update.indexOf('Move-Item -LiteralPath $AppDir'), 'update must stop WorkBuddy before moving the app directory');
  assert.match(update, /Stop-WorkBuddyForUpdate\b/);
});

test('macOS updater stops the daemon before waiting for the API port', () => {
  const script = read('apply-update.sh');
  const stop = script.indexOf('stop_daemons');
  const wait = script.indexOf('for i in $(seq 1 30)');
  assert.notEqual(stop, -1);
  assert.notEqual(wait, -1);
  assert.ok(stop < wait, 'daemon shutdown must precede the port wait');
  assert.match(script, /PROFILE="\$\{6:-workbuddy-cn\}"/);
  assert.match(script, /lsof -nP -ti tcp:/);
  assert.match(script, /kill -TERM/);
});

test('updaters fail loudly and leave a durable attempt trail', () => {
  const daemon = read('daemon.js');
  const mac = read('apply-update.sh');
  const win = read('apply-update.ps1');
  assert.match(daemon, /UPDATE_ATTEMPT_FILE/);
  assert.match(daemon, /script-started/);
  assert.match(daemon, /macWorkDaddyAppPath/);
  assert.match(mac, /set -Eeuo pipefail/);
  assert.match(mac, /rollback/);
  assert.match(mac, /等待 daemon 端口恢复/);
  assert.match(win, /\$ErrorActionPreference = 'Stop'/);
  assert.match(win, /Rollback-App/);
  assert.match(win, /新版 daemon 在 60 秒内未就绪/);
});

test('account switching refreshes WorkBuddy after replacing auth without restarting it', () => {
  const script = read('daemon.js');
  const lib = read('lib.js');
  const routeStart = script.indexOf("if (req.method === 'POST' && p === '/api/switch')");
  assert.notEqual(routeStart, -1);
  const route = script.slice(routeStart, routeStart + 2600);
  const copy = route.indexOf('switchTo(DATA_DIR, uid, log)');
  assert.notEqual(copy, -1);
  assert.match(route, /await reloadWorkBuddyPage\(\)/);
  assert.doesNotMatch(route, /await quitWorkBuddy\(\)/);
  assert.doesNotMatch(route, /await relaunchWorkBuddy\(\)/);
  assert.match(lib, /function retireLogoutMarker/);
  assert.match(lib, /retireLogoutMarker\(log\);/);
});

test('account switching retires WorkBuddy logout marker', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-auth-'));
  const authFile = path.join(dir, 'workbuddy-desktop.info');
  const marker = `${authFile}.logged-out`;
  fs.writeFileSync(authFile, '{}');
  fs.writeFileSync(marker, 'logged out');
  try {
    const result = childProcess.spawnSync(
      process.execPath,
      ['-e', "require(process.argv[1]).retireLogoutMarker()", path.join(repoRoot, 'scripts', 'lib.js')],
      { env: { ...process.env, WBSWITCH_AUTH_FILE: authFile }, encoding: 'utf8' }
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('seamless login refreshes the running WorkBuddy session', () => {
  const script = read('inject.js');
  const start = script.indexOf('function startSeamlessLogin');
  const end = script.indexOf('\n    // ===== 主题系统', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const seamless = script.slice(start, end);
  assert.match(seamless, /扫码确认后会自动切换到新账号\.\.\./);
  assert.match(seamless, /api\('\/api\/switch'/);
  assert.match(seamless, /reload: true/);
  assert.doesNotMatch(seamless, /没弹出来\?|点此打开授权页/);
});

test('CDP startup supports a persisted fallback port instead of hardcoding 9222', () => {
  const daemon = read('daemon.js');
  const macLauncher = read('relaunch-with-cdp.sh');
  const winLauncher = read('win-launcher.js');
  assert.match(daemon, /cdp-port\.json/);
  assert.match(daemon, /findAvailableCdpPort/);
  assert.match(daemon, /const upstreamPort = cdp\.port/);
  assert.match(daemon, /127\.0\.0\.1:' \+ upstreamPort \+ '\/devtools\/page\//);
  assert.doesNotMatch(daemon, /new WebSocketCtor\('ws:\/\/127\.0\.0\.1:9222\/devtools\/page\//);
  assert.match(macLauncher, /cdp-port\.json/);
  assert.match(macLauncher, /--remote-debugging-port=\"\$PORT\"/);
  assert.match(winLauncher, /cdp-port\.json/);
  assert.match(winLauncher, /--remote-debugging-port=' \+ CDP_PORT/);
});

test('Windows launcher tolerates slow WorkBuddy startup beyond the old 20 second limit', () => {
  const launcher = read('win-launcher.js');
  assert.match(launcher, /CDP_STARTUP_TIMEOUT_MS\s*=\s*60000/);
  assert.match(launcher, /Date\.now\(\)\s*<\s*deadline/);
  assert.match(launcher, /await sleep\(1000\)/);
});

test('Windows launcher keeps local port probing and profile CDP candidates defined', () => {
  const launcher = read('win-launcher.js');
  assert.match(launcher, /const HOST\s*=\s*['"]127\.0\.0\.1['"]/);
  assert.match(launcher, /function portOpen\(port\)/);
  assert.match(launcher, /function isLocalPortAvailable\(port\)/);
  assert.match(launcher, /server\.listen\(\{ host: HOST, port \}/);
  assert.match(launcher, /改用备用端口重试/);
  assert.match(launcher, /const profilePorts = PROFILE_CDP_PORTS\[PROFILE\.id\]/);
  assert.match(launcher, /profilePorts\.includes\(savedPort\)/);
  assert.match(launcher, /for \(const port of profilePorts\) add\(port\)/);
  assert.match(launcher, /function daemonRunning\(\)\s*\{\s*return portOpen\(UI_PORT\);/);
  assert.match(launcher, /'workbuddy-cn': \[9222/);
  assert.match(launcher, /'workbuddy-ai': \[9223/);
  assert.match(launcher, /isTargetForProfile\(target, PROFILE\)/);
});

test('Windows launcher propagates the WorkBuddy AI UI port to child processes', { skip: process.platform !== 'win32' }, () => {
  const launcherPath = path.join(repoRoot, 'scripts', 'win-launcher.js');
  const probe = [
    "process.env.WBSWITCH_PROFILE = 'workbuddy-ai';",
    'delete process.env.WBSWITCH_PORT;',
    `require(${JSON.stringify(launcherPath)});`,
    "process.stdout.write(process.env.WBSWITCH_PORT || '');",
  ].join(' ');
  const result = childProcess.spawnSync(process.execPath, ['-e', probe], {
    encoding: 'utf8',
    env: { ...process.env },
    timeout: 15000,
    windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, '47833');
});

test('Windows launcher rejects a persisted sibling-profile CDP port', { skip: process.platform !== 'win32' }, () => {
  const launcherPath = path.join(repoRoot, 'scripts', 'win-launcher.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-cdp-profile-'));
  try {
    fs.writeFileSync(path.join(dir, 'cdp-port.json'), JSON.stringify({ port: 9223 }));
    const probe = [
      "process.env.WBSWITCH_PROFILE = 'workbuddy-cn';",
      `process.env.WBSWITCH_DATA_DIR = ${JSON.stringify(dir)};`,
      'delete process.env.WBSWITCH_CDP_PORT;',
      `const launcher = require(${JSON.stringify(launcherPath)});`,
      'process.stdout.write(JSON.stringify(launcher.cdpPortCandidates()));',
    ].join(' ');
    const result = childProcess.spawnSync(process.execPath, ['-e', probe], {
      encoding: 'utf8',
      env: { ...process.env },
      timeout: 15000,
      windowsHide: true,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const ports = JSON.parse(result.stdout);
    assert.deepEqual(ports, [9222, 9226, 9227, 9228, 9229, 9230, 9231, 9232]);
    assert.equal(ports.includes(9223), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('explicit daemon UI ports never fall through into another profile port', () => {
  const daemon = read('daemon.js');
  assert.match(daemon, /const ALLOW_UI_PORT_FALLBACK = !process\.env\.WBSWITCH_PORT/);
  assert.match(daemon, /profileUiPortCandidates\(PROFILE\.id/);
  assert.match(daemon, /e\.code === 'EADDRINUSE' && attempt \+ 1 < ports\.length/);
});

test('Windows launcher does not report success when manual injection is not mounted', () => {
  const daemon = read('daemon.js');
  const launcher = read('win-launcher.js');
  assert.match(daemon, /注入后未检测到 WorkDaddy 组件/);
  assert.match(daemon, /mounted: !!\(info && info\.mounted\)/);
  assert.match(launcher, /payload\.mounted === true/);
  assert.match(launcher, /pending:\s*true/);
  assert.match(launcher, /WorkDaddy 组件注入失败/);
});

test('Windows launcher treats delayed renderer injection as background work', () => {
  const launcher = read('win-launcher.js');
  const daemon = read('daemon.js');
  const batch = read('launcher.cmd');
  assert.match(launcher, /INJECT_REQUEST_TIMEOUT_MS\s*=\s*5000/);
  assert.match(launcher, /INJECT_MAX_ATTEMPTS\s*=\s*6/);
  assert.match(launcher, /INJECT_RETRY_DELAY_MS\s*=\s*1000/);
  assert.match(launcher, /async function injectNowOrPending/);
  assert.match(launcher, /后台正在注入组件/);
  assert.match(launcher, /injectNowOrPending\(\)/);
  assert.match(daemon, /manualInjectPromise/);
  assert.match(daemon, /injectWidgetManual\(\)/);
  assert.match(batch, /if "%EXIT_CODE%"=="0" \([\s\S]*exit \/b 0/);
});

test('Windows launcher gives cold-start instances time before changing CDP ports', () => {
  const launcher = read('win-launcher.js');
  assert.match(launcher, /const CDP_PORT_RETRY_GRACE_MS\s*=\s*15000/);
  assert.match(launcher, /Date\.now\(\) - launchStartedAt >= CDP_PORT_RETRY_GRACE_MS/);
  assert.match(launcher, /const hasProcessWithoutArg = diagnostics\.length > 0 && !diagnostics\.some\(\(p\) => p\.hasCdpArg\)/);
  assert.doesNotMatch(launcher, /diagnostics\.every\(\(p\) => p\.hasCommandLine\)/);
});

test('session module read remains usable when first-run seed persistence fails', () => {
  const daemon = fs.readFileSync(path.join(repoRoot, 'scripts', 'daemon.js'), 'utf8');
  const start = daemon.indexOf('function readSessionState()');
  const end = daemon.indexOf('\nfunction writeSessionState', start);
  assert.ok(start >= 0 && end > start);
  const reader = daemon.slice(start, end);
  assert.match(reader, /try\s*\{[\s\S]*writeWorkbuddySettings\(s\)/);
  assert.match(reader, /catch \(error\)/);
  assert.match(reader, /session-seed-persist/);
  assert.match(reader, /return sessBuild\(st, phrases\)/);
});

test('macOS updater validates a cached/downloaded DMG before mounting it', () => {
  const daemon = read('daemon.js');
  assert.match(daemon, /hdiutil['"],\s*\['imageinfo'/);
  assert.match(daemon, /validateUpdateArtifact|validateDmg|inspectDmg|isValidDmg/);
  assert.match(daemon, /下载内容不是有效 DMG|DMG 预检失败/);
  assert.match(daemon, /dmgSize/);
  assert.match(daemon, /Content-Type|content-type/);
});

test('Windows launcher scopes process discovery to the active profile and records exit diagnostics', () => {
  const launcher = read('win-launcher.js');
  assert.match(launcher, /PROFILE\.id === 'workbuddy-ai' \? \['workbuddyai\.exe'\]/);
  assert.match(launcher, /PROFILE\.id === 'workbuddy-cn' \? \['workbuddy\.exe'\]/);
  assert.doesNotMatch(launcher, /\$names=@\("WorkBuddy\.exe","CodeBuddy\.exe","WorkBuddyAI\.exe"\)/);
  assert.match(launcher, /\[exit\]/);
  assert.match(launcher, /taskkill=/);
  assert.match(launcher, /tasklistProcessIds/);
  assert.match(launcher, /processDiagnostics/);
});

test('release scripts package only WorkDaddy and WorkDaddy AI', () => {
  const win = fs.readFileSync(path.join(repoRoot, 'scripts', 'build-win-zip.sh'), 'utf8');
  const mac = fs.readFileSync(path.join(repoRoot, 'scripts', 'build-mac-dmg.sh'), 'utf8');
  const installer = read('install-win.ps1');
  for (const script of [win, mac]) {
    assert.match(script, /for profile in workbuddy-cn workbuddy-ai/);
    assert.doesNotMatch(script, /codebuddy-cn|codebuddy-intl/);
  }
  assert.match(win, /WorkDaddy AI\.lnk|PACKAGE_NAME="WorkDaddy AI"/);
  assert.match(win, /OUT="release\/windows\/WorkDaddy/);
  assert.match(mac, /PACKAGE_APP_NAME="WorkDaddy AI"/);
  assert.match(mac, /Contents\/Resources\/scripts\/daemon\.js/);
  assert.match(win, /BUILD_VERSION="\$VERSION"/);
  assert.match(installer, /\$lnkPath\s*=\s*Join-Path\s+\$desktopDir\s+\(\$productName\s+\+\s+'\.lnk'\)/);
});

test('Windows installer writes through the console API for PowerShell 5.1 compatibility', () => {
  const installer = read('install-win.ps1');
  const entry = read('install-win.cmd');
  assert.match(installer, /\[Console\]::WriteLine/);
  assert.doesNotMatch(installer, /\bWrite-Host\b/);
  assert.match(entry, /\[Console\]::WriteLine/);
  assert.doesNotMatch(entry, /\bWrite-Host\b/);
});

test('release scripts synchronize daemon version and build id', () => {
  const daemon = read('daemon.js');
  const win = fs.readFileSync(path.join(repoRoot, 'scripts', 'build-win-zip.sh'), 'utf8');
  const mac = fs.readFileSync(path.join(repoRoot, 'scripts', 'build-mac-dmg.sh'), 'utf8');
  const version = daemon.match(/const DAEMON_VERSION = '([^']+)'/);
  const buildId = daemon.match(/const DAEMON_BUILD_ID = '([^']+)'/);
  assert.ok(version && buildId);
  assert.ok(buildId[1].startsWith(`release-${version[1]}-`), 'source Build ID must use the source daemon version');
  assert.match(win, /DAEMON_BUILD_ID/);
  assert.match(win, /release-.*DAEMON_BUILD_ID|DAEMON_BUILD_ID.*release-/s);
  assert.match(win, /staged daemon\.js DAEMON_BUILD_ID/);
  assert.match(mac, /const DAEMON_BUILD_ID = 'release-/);
  assert.match(mac, /产物 daemon\.js 的版本或 Build ID/);
  assert.match(mac, /PlistBuddy[^\n]+Set :CFBundleShortVersionString \$\{VERSION\}/);
  assert.match(mac, /PlistBuddy[^\n]+Set :CFBundleVersion \$\{VERSION\}/);
  assert.doesNotMatch(mac, /VERSION_CODE/);
});

test('daemon settings writes tolerate transient Windows file locks', () => {
  const daemon = read('daemon.js');
  const helper = fs.readFileSync(path.join(repoRoot, 'scripts', 'atomic-file-write.js'), 'utf8');
  assert.match(helper, /UNKNOWN/);
  assert.match(helper, /writeFileSync/);
  assert.match(helper, /renameSync/);
  assert.doesNotMatch(helper, /unlinkSync\(file\)|rmSync\(file\)/);

  const settingsStart = daemon.indexOf('function writeWorkbuddySettings(');
  const settingsEnd = daemon.indexOf('\n}\n\nfunction buildAskRuleBlock', settingsStart);
  const appStart = daemon.indexOf('function writeAppConfig(');
  const appEnd = daemon.indexOf('\n}\nfunction acBlock', appStart);
  assert.match(daemon.slice(settingsStart, settingsEnd), /mkdirSync\(path\.dirname\(file\),\s*\{\s*recursive:\s*true\s*\}\)/);
  assert.match(daemon.slice(settingsStart, settingsEnd), /replaceFileWithRetry\(file/);
  assert.match(daemon.slice(appStart, appEnd), /replaceFileWithRetry\(file/);
  assert.doesNotMatch(daemon.slice(settingsStart, settingsEnd), /file \+ '\\.wbs-tmp'/);
  assert.doesNotMatch(daemon.slice(appStart, appEnd), /file \+ '\\.wbs-tmp'/);
});

test('Windows launcher verifies the real WorkBuddy process tree and launch arguments', () => {
  const launcher = read('win-launcher.js');
  assert.match(launcher, /Get-CimInstance Win32_Process/);
  assert.match(launcher, /CommandLine/);
  assert.match(launcher, /同安装目录进程的精确参数/);
  assert.match(launcher, /按实际 PID 精确结束安装目录中的进程树/);
  assert.match(launcher, /waitForWorkBuddyCdp\(wb\)/);
  assert.match(launcher, /启动后进程未携带 CDP 参数，准备重试/);
  assert.match(launcher, /CDP 超时最终诊断/);
  assert.match(launcher, /processes: processDiagnostics\(wb\)/);
});

test('Windows launcher refuses elevated or image-name exit fallbacks', () => {
  const launcher = read('win-launcher.js');
  assert.doesNotMatch(launcher, /Start-Process[\s\S]*taskkill\.exe[\s\S]*-Verb RunAs/);
  assert.doesNotMatch(launcher, /taskkill[^\n]*\/IM/);
  assert.doesNotMatch(launcher, /['"]\/T['"]/);
  assert.match(launcher, /请手动关闭该程序/);
});

test('daemon JSON responses are idempotent after headers or body were sent', () => {
  const daemon = read('daemon.js');
  const start = daemon.indexOf('function json(res, code, obj)');
  const end = daemon.indexOf('\n\nconst PUBLIC_API_PATHS', start);
  assert.ok(start >= 0 && end > start);
  const json = new Function('Buffer', `${daemon.slice(start, end)}; return json;`)(Buffer);
  let writes = 0;
  const res = {
    __wbsCorsOrigin: '',
    headersSent: false,
    writableEnded: false,
    writeHead() {
      if (this.headersSent) throw new Error('headers already sent');
      this.headersSent = true;
      writes++;
    },
    end() {
      this.writableEnded = true;
      writes++;
    },
  };
  json(res, 200, { ok: true });
  assert.doesNotThrow(() => json(res, 502, { ok: false }));
  assert.equal(writes, 2, 'duplicate response must not write a second response');
});

test('Windows launcher discovers portable WorkBuddy installations', () => {
  const launcher = read('win-launcher.js');
  assert.match(launcher, /App Paths/);
  assert.match(launcher, /Software[\\/].*workbuddy/i);
  assert.match(launcher, /WBSWITCH_WORKBUDDY_BIN/);
});

test('macOS updater validates and refreshes a cached app before reusing it', () => {
  const daemon = read('daemon.js');
  assert.match(daemon, /cachedArtifact/);
  assert.match(daemon, /cachedMatches/);
  assert.match(daemon, /artifact-cache/);
  assert.match(daemon, /cachedMatches[\s\S]*extractAppFromDmg/);
  assert.match(daemon, /安装包内部 daemon 版本不可读/);
  assert.match(daemon, /安装包应用版本不可读/);
});

test('Windows launcher searches app-data roots and versioned WorkBuddy installs', () => {
  const launcher = read('win-launcher.js');
  const daemon = read('daemon.js');
  assert.match(launcher, /LOCALAPPDATA[\s\S]*WorkBuddy/);
  assert.match(launcher, /APPDATA[\s\S]*WorkBuddy/);
  assert.match(launcher, /Get-ChildItem[\s\S]*-Recurse/);
  assert.match(daemon, /LOCALAPPDATA[\s\S]*WorkBuddy/);
  assert.match(daemon, /APPDATA[\s\S]*WorkBuddy/);
  assert.match(daemon, /Get-ChildItem[\s\S]*-Recurse/);
});

test('Windows launcher selects the Node runtime from an actual daemon or watchdog', () => {
  const launcher = read('win-launcher.js');
  const findNode = launcher.slice(launcher.indexOf('function findNode()'), launcher.indexOf('// ---------- 定位 WorkBuddy.exe'));
  assert.match(findNode, /uniqueNodeProcess\(candidate, DAEMON_SCRIPT\)/);
  assert.match(findNode, /uniqueNodeProcess\(candidate, WATCHDOG_SCRIPT\)/);
  assert.match(findNode, /if \(candidates\.length\) return candidates\[0\]/);
  assert.doesNotMatch(findNode, /hasExistingWatchdogState/);
});

test('Windows release package excludes the troubleshooting prompt', () => {
  const build = fs.readFileSync(path.join(repoRoot, 'scripts', 'build-win-zip.sh'), 'utf8');
  const installer = fs.readFileSync(path.join(repoRoot, 'scripts', 'win', 'workdaddy.iss'), 'utf8');
  assert.doesNotMatch(build, /cp\s+.*安装失败自主解决提示词/);
  assert.doesNotMatch(installer, /Source:.*安装失败自主解决提示词/);
  assert.match(build, /Python zipfile/);
  assert.match(build, /ZIP_DEFLATED/);
});

test('WorkDaddy AI branding preserves CRLF in Windows command files', { skip: process.platform !== 'win32' }, () => {
  const build = fs.readFileSync(path.join(repoRoot, 'scripts', 'build-win-zip.sh'), 'utf8');
  const branding = build.match(/if \[ "\$PROFILE" = "workbuddy-ai" \]; then[\s\S]*?<<'PY'\r?\n([\s\S]*?)\r?\nPY\r?\nfi/);
  assert.ok(branding, 'AI branding Python block is missing');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-ai-branding-'));
  const scriptsDir = path.join(dir, 'scripts');
  const verify = path.join(scriptsDir, 'verify-win.cmd');
  try {
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(verify, Buffer.from([
      '@echo off',
      'rem WorkDaddy Windows 安装包自检',
      'echo WorkDaddy 安装包自检',
      '',
    ].join('\r\n'), 'utf8'));

    const result = childProcess.spawnSync('python', ['-', dir], {
      input: branding[1],
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);

    const branded = fs.readFileSync(verify, 'utf8');
    assert.match(branded, /WorkDaddy AI Windows 安装包自检/);
    assert.equal(branded.replace(/\r\n/g, '').includes('\n'), false, 'branding introduced bare LF line endings');
    assert.equal(branded.replace(/\r\n/g, '').includes('\r'), false, 'branding introduced bare CR line endings');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Windows release packages bundle a pinned Node runtime and build a user-level Setup.exe', () => {
  const build = fs.readFileSync(path.join(repoRoot, 'scripts', 'build-win-zip.sh'), 'utf8');
  const installer = fs.readFileSync(path.join(repoRoot, 'scripts', 'build-win-installer.ps1'), 'utf8');
  const iss = fs.readFileSync(path.join(repoRoot, 'scripts', 'win', 'workdaddy.iss'), 'utf8');
  const workflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'build-win.yml'), 'utf8');
  const launcher = read('launcher.cmd');
  assert.match(build, /NODE_VERSION=.*22\.23\.1/);
  assert.match(build, /NODE_SHA256=.*7df0bc9375723f4a86b3aa1b7cc73342423d9677a8df4538aca31a049e309c29/);
  assert.match(build, /runtime\/node\/node\.exe/);
  assert.match(build, /(?:python3|PYTHON_BIN).*NODE_ARCHIVE_PATH/);
  assert.match(build, /CRLF/);
  assert.match(installer, /Expand-Archive/);
  assert.match(installer, /\[string\]\$Version/);
  assert.match(installer, /ZIP 内部 daemon 版本/);
  assert.match(installer, /bundled Node runtime/);
  assert.match(workflow, /WORKDADDY_BUILD_VERSION:/);
  assert.match(workflow, /-Version \$\{\{ steps\.ver\.outputs\.version \}\}/);
  assert.match(iss, /PrivilegesRequired=lowest/);
  assert.match(iss, /runtime|scripts\\\*/i);
  assert.match(iss, /WorkDaddyLauncher\.exe/);
  assert.doesNotMatch(iss, /install-win\.ps1|launcher-hidden\.vbs|wscript\.exe/i);
  assert.match(build, /GOOS=windows GOARCH=amd64/);
  assert.match(workflow, /actions\/setup-go@v5/);
  assert.match(workflow, /(?:Install Inno Setup|安装 Inno Setup)/);
  assert.match(workflow, /build-win-installer\.ps1/);
  assert.match(workflow, /release\/windows\/WorkDaddy-Setup-\*\.exe/);
  assert.match(launcher, /runtime\\node\\node\.exe/);
});

test('Windows release publishes Setup.exe only and removes temporary ZIP staging', () => {
  const workflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'build-win.yml'), 'utf8');
  const installer = read('build-win-installer.ps1');
  const guide = fs.readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8');
  assert.match(workflow, /仅 Setup\.exe/);
  assert.doesNotMatch(workflow, /release\/windows\/WorkDaddy-\*-win64\.zip/);
  assert.match(workflow, /确认仅保留 Setup\.exe 发行产物/);
  assert.match(installer, /ZIP is only an internal staging input/);
  assert.match(installer, /Remove-Item -LiteralPath \$zipPath/);
  assert.match(guide, /Windows releases are `Setup\.exe` only/);
  assert.match(guide, /temporary staging/);
});

test('Windows Setup waits for WorkBuddy and stops only a native-verified profile lifecycle', () => {
  const installer = fs.readFileSync(path.join(repoRoot, 'scripts', 'win', 'workdaddy.iss'), 'utf8');
  assert.match(installer, /function PrepareToInstall\(var NeedsRestart: Boolean\): String/);
  assert.match(installer, /ExtractTemporaryFile\('WorkDaddyLauncher\.exe'\)/);
  assert.match(installer, /function EnsureWorkBuddyClosed/);
  assert.match(installer, /--check-workbuddy/);
  assert.match(installer, /重新检测/);
  assert.match(installer, /结束进程/);
  assert.match(installer, /--terminate-workbuddy/);
  assert.match(installer, /--stop-lifecycle/);
  assert.match(installer, /ewWaitUntilTerminated/);
  assert.match(installer, /ResultCode <> 10/);
  assert.match(installer, /ResultCode = 11/);
  assert.match(installer, /runtime\\node\\\*/);
  assert.match(installer, /无法安全停止 WorkDaddy 后台进程/);
  assert.match(installer, /IsAdminInstallMode/);
  assert.match(installer, /当前安装程序是以管理员权限运行的/);
  assert.match(installer, /不要选择“以管理员身份运行”/);
  assert.match(installer, /普通安装器不会跨权限强行结束/);
  assert.doesNotMatch(installer, /安装器本身可以使用管理员权限运行/);
  assert.doesNotMatch(installer, /旧版 WorkDaddy 正以管理员权限运行/);
  assert.doesNotMatch(installer, /prepare-win-install|windows-process-boundary|PowerShell/i);
});

test('macOS release staging excludes the troubleshooting prompt', () => {
  const build = fs.readFileSync(path.join(repoRoot, 'scripts', 'build-mac-dmg.sh'), 'utf8');
  assert.doesNotMatch(build, /STAGE\/安装失败自主解决提示词\.txt/);
  assert.doesNotMatch(build, /cat > "\$STAGE\/安装失败自主解决提示词\.txt"/);
});

test('macOS package launcher keeps WorkBuddy CN and AI CDP ports profile-specific', () => {
  const build = fs.readFileSync(path.join(repoRoot, 'scripts', 'build-mac-dmg.sh'), 'utf8');
  assert.match(build, /profile CDP/);
  assert.ok(build.includes("WorkBuddy[[:space:]]*AI|WorkBuddyAI"));
  assert.match(build, /workbuddy-cn\)/);
  assert.match(build, /workbuddy-ai\)/);
});

test('macOS package launcher returns focus to the target WorkBuddy and separates AI identity', () => {
  const build = fs.readFileSync(path.join(repoRoot, 'scripts', 'build-mac-dmg.sh'), 'utf8');
  assert.match(build, /activate_target_app\(\)/);
  assert.match(build, /tell application.*APP_NAME.*activate/);
  assert.match(build, /com\.workdaddy\.ai\.launcher/);
  assert.match(build, /manual inject result:[\s\S]*activate_target_app/);
});

test('troubleshooting prompts keep Sentry reports short and omit raw logs', () => {
  const prompt = fs.readFileSync(path.join(repoRoot, '安装失败自主解决提示词.txt'), 'utf8');
  assert.ok(prompt.length < 3500, 'source prompt should stay compact');
  assert.match(prompt, /报告硬上限 3500 字符/);
  assert.match(prompt, /不要粘贴完整日志/);
});

test('daemon lock falls back when the data-directory lock is not writable on Windows', () => {
  const daemon = read('daemon.js');
  assert.match(daemon, /DAEMON_LOCK_FALLBACK_FILE/);
  assert.match(daemon, /os\.tmpdir\(\)/);
  assert.match(daemon, /\['EACCES', 'EPERM', 'EROFS'\]/);
  assert.match(daemon, /daemon-lock-fallback/);
  assert.match(daemon, /daemonLockPath/);
  assert.match(daemon, /releaseDaemonLock[\s\S]*daemonLockPath/);
});

test('Windows daemon lock validates the owner process instead of trusting a reused PID', () => {
  const daemon = read('daemon.js');
  const lockBlock = daemon.slice(daemon.indexOf('function isCurrentWindowsDaemonProcess'), daemon.indexOf('function acquireDaemonLock'));
  assert.match(lockBlock, /Get-CimInstance Win32_Process -Filter/);
  assert.match(lockBlock, /filterVerifiedNodeProcesses\(item\.ExecutablePath, __filename/);
  assert.match(daemon, /if \(IS_WIN\) alive = isCurrentWindowsDaemonProcess\(ownerPid\)/);
});

test('session ranges use last-modified time and preserve standard WorkBuddy workspaces', () => {
  const daemon = read('daemon.js');
  const inject = read('inject.js');
  assert.match(daemon, /COALESCE\(last_activity_at, updated_at, created_at\) >=/);
  assert.match(daemon, /ORDER BY COALESCE\(last_activity_at, updated_at, created_at\) DESC/);
  assert.match(inject, /sessionsState\.list = \(\(d && d\.sessions\) \|\| \[\]\);/);
  assert.match(inject, /if \(isTaskSessionRecordUI\(s\)\) \{ tasks\.push\(s\); return; \}/);
  assert.match(inject, /fmtHumanTime\(s\.last_activity_at \|\| s\.updated_at \|\| s\.created_at\)/);
});

test('Windows relaunch restores the WorkBuddy window after starting it', () => {
  const daemon = read('daemon.js');
  assert.match(daemon, /restoreWorkBuddyWindow/);
  assert.match(daemon, /await restoreWorkBuddyWindow/);
});

test('account cards keep the compact three-row layout', () => {
  const script = read('inject.js');
  assert.match(script, /wbs-name-group/);
  assert.match(script, /wbs-secondary-row/);
  assert.match(script, /剩余<\/span>/);
  assert.match(script, /今日已签到/);
  // 登录有效期展示：国际版也将 token 有效截止时间展示为「有效期至」而非歧义的「登录过期于」
  assert.match(script, /有效期至/);
  assert.doesNotMatch(script, /登录过期于/);
  assert.match(script, /var isUinMode = !a\.phone;/);
  assert.match(script, /var idLbl = a\.phone \? '手机' : \(a\.uin \? 'UIN' : '账号'\)/);
  assert.match(script, /\.wbs-phone-cell\.wbs-uin-cell\{gap:4px\}/);
  // 国际版：签到标签不展示；新版布局按能力把暂存按钮内联进操作栏按钮组第一位。
  assert.match(script, /if \(PROFILE_ID === 'workbuddy-ai'\) return '';/);
  assert.match(script, /WBS_COMPAT\.findComposerToolbar\(document\)/);
  assert.match(script, /wbs-stash-inline-inline/);
  assert.match(script, /row0\.insertBefore\(stashBtn, row0\.firstChild\)/);
  assert.match(script, /wbs-credit-hidden/);
  assert.match(script, /var expired = isIdentityExpired\(a\)/);
  assert.match(script, /expired \? '' : '<button class="wbs-icon-btn wbs-acc-switch"/);
  assert.match(script, /switchBtn\.style\.display = hidden \? 'none' : ''/);
  assert.match(script, /height:5px;min-height:5px/);
  assert.match(script, /\.wbs-credit-segment:first-child\{border-radius:3px 0 0 3px\}/);
  assert.match(script, /\.wbs-credit-segment:last-child\{border-radius:0 3px 3px 0\}/);
  assert.match(script, /cursor:default/);
  assert.doesNotMatch(script, /data-tip="' \+ attrTip \+ '" title=/);
  assert.match(script, /diff <= day/);
  assert.match(script, /diff <= 3 \* day/);
  assert.match(script, /diff <= 7 \* day/);
  assert.match(script, /diff <= 15 \* day/);
  assert.match(script, /30 \* day/);
  assert.match(script, /\.wbs-credit-segment\.safe\{background:rgba\(34,197,94,\.78\)/);
  assert.match(script, /\.wbs-credit-segment\.within30\{background:rgba\(34,197,94,\.62\)/);
  assert.match(script, /\.wbs-credit-segment\.within15\{background:rgba\(34,197,94,\.46\)/);
  assert.match(script, /\.wbs-credit-segment\.within7\{background:rgba\(34,197,94,\.32\)/);
  assert.match(script, /\.wbs-credit-segment\.within3\{background:rgba\(34,197,94,\.20\)/);
  assert.match(script, /\.wbs-credit-segment\.within1\{background:rgba\(34,197,94,\.10\)/);
  assert.match(script, /html\.cb-dark \.wbs-credit-segment\.safe\{background:rgba\(126,134,255,\.82\)/);
  assert.match(script, /html\.cb-dark \.wbs-credit-segment\.within1\{background:rgba\(126,134,255,\.12\)/);
  assert.match(script, /\.wbs-checkin-tag\.ok\{background:#edf9ef/);
  assert.match(script, /html\.cb-dark \.wbs-checkin-tag\.ok\{/);
  assert.match(script, /今日已签到✓/);
  assert.match(script, /function accountStatusTagsHtml\(a\)/);
  assert.match(script, /function checkinBadgeHtml\(a\)/);
  assert.match(script, /badge \+ checkinBadge/);
  assert.match(script, /if \(!usage \|\| usage\.synced !== true\) return '';/);
  assert.match(script, /wbs-usage-tag/);
  assert.match(script, /wbs-usage-tag[^\n]+今日已使用[^\n]+CREDIT_ICON/);
  assert.match(script, /wbs-usage-tag[^\n]+<b>\x27 \+ fmtCredits\(used\) \+ \x27<\/b>/);
  assert.match(script, /\.wbs-phone-cell \.wbs-lbl,\.wbs-credit-left \.wbs-lbl\{width:28px\}/);
  assert.match(script, /if \(!isFinite\(used\) \|\| used <= 0\) return '';/);
  assert.match(script, /wbs-credit-left/);
  assert.doesNotMatch(script, /今日已用/);
  assert.doesNotMatch(script, /wbs-token-expired/);
  assert.doesNotMatch(script, /按到期时间排序/);
  assert.doesNotMatch(script, /个额度/);
  assert.doesNotMatch(script, /wbs-checkin-cell/);
});

test('account cards place the current logged-in account first', () => {
  const script = read('inject.js');
  assert.match(script, /state\.current = data\.current;\s*state\.accounts = \(data\.accounts \|\| \[\]\)\.slice\(\);/);
  assert.match(script, /state\.accounts\.sort\(function \(left, right\) \{[\s\S]*left\.uid === state\.current\.uid[\s\S]*right\.uid === state\.current\.uid[\s\S]*return leftIsCurrent \? -1 : 1;[\s\S]*\}\);/);
  assert.match(script, /function sortAccountsByCreditExpiry\(\) \{[\s\S]*isCurrent:[\s\S]*if \(a\.isCurrent !== b\.isCurrent\) return a\.isCurrent \? -1 : 1;[\s\S]*if \(a\.expiresAt !== b\.expiresAt\)/);
});

test('quick-phrase layering does not reposition WorkBuddy native chat toolbar', () => {
  const script = read('inject.js');
  assert.match(script, /\.wbs-explore-inline\.wbs-stash-inline-inline\{position:relative;z-index:99999\}/);
  assert.match(script, /\.wbs-explore-pop\{[^}]*z-index:2147483647/);
  assert.doesNotMatch(script, /_chatMessageBottomToolbarWrapper_\}\{position:relative;z-index:68/);
  assert.doesNotMatch(script, /_chatMessageBottomToolbar_\}\{position:relative;z-index:69/);
  assert.doesNotMatch(script, /_chatMessageBottomToolbarItem_\}\{position:relative;z-index:70/);
});

test('auto-continue restores a missing prompt block without disabling the monitor', () => {
  const script = read('inject.js');
  assert.match(script, /prompt-block-lost-restore/);
  assert.match(script, /body: JSON\.stringify\(\{ enabled: true \}\)/);
  assert.doesNotMatch(script, /prompt-block-lost-disable/);
});

test('auto-continue keeps the three-second terminal settle window', () => {
  const script = read('inject.js');
  assert.match(script, /var AC_FB_SETTLE_MS = 3000/);
});

test('robot button decorations remain visible alongside the eye states', () => {
  const script = read('inject.js');
  assert.match(script, /wbs-fab-antenna/);
  assert.doesNotMatch(script, /wbs-fab-ear/); // 用户 08-30 00:37 要求去掉双耳
  assert.match(script, /\.wbs-fab-antenna\{[^}]*background:rgba\(20,20,22,\.55\)[^}]*mask-image:url\("data:image\/svg\+xml/);
  assert.match(script, /\.wbs-fab-antenna-dot\{[^}]*background:transparent/);
  assert.match(script, /viewBox=\\'0 0 14 24\\'>/);
  assert.match(script, /#wbs-fab-sleep-light\.sleep-on\{background:rgba\(46,229,157,\.85\)/);
  assert.match(script, /\.wbs-fab \.click > span:not\(\.wbs-fab-antenna\)\{display:none\}/);
  assert.doesNotMatch(script, /\.wbs-fab \.click span\{display:none\}/);
  assert.match(script, /\.wbs-fab \.click \.button \.speak~\.speak\{display:none\}/);
});

test('robot button defaults to the window bottom-right and snaps right after free dragging', () => {
  const script = read('inject.js');
  assert.match(script, /FAB_POSITION_KEY = 'wbs-fab-bottom-' \+ PROFILE_ID/);
  assert.match(script, /setPointerCapture\(e\.pointerId\)/);
  assert.match(script, /FAB_DRAG_THRESHOLD = 6/);
  assert.match(script, /fabDrag\.startRight - deltaX/);
  assert.match(script, /fabDrag\.startBottom - deltaY/);
  assert.match(script, /applyFabPosition\(fab, FAB_EDGE_GAP, bottom\)/);
  assert.match(script, /localStorage\.setItem\(FAB_POSITION_KEY/);
  assert.match(script, /touchAction = 'none'/);
  assert.match(script, /is-snapping/);
  assert.match(script, /cubic-bezier\(\.22,1\.35,\.36,1\)/);
  assert.doesNotMatch(script, /homeComposerCorner|aiHomeComposerCorner|cb-message-queue\.cb-expand/);
});

test('installers disable login auto-start and clean prior registrations', () => {
  const win = read('install-win.ps1');
  assert.doesNotMatch(win, /Set-ItemProperty\s+-Path\s+\$runKey/);
  assert.match(win, /Remove-ItemProperty[\s\S]*WorkDaddy AI/);
  assert.match(win, /Remove-ItemProperty[\s\S]*WorkDaddy/);

  const mac = read('install.sh');
  assert.doesNotMatch(mac, /<key>RunAtLoad<\/key>/);
  assert.doesNotMatch(mac, /launchctl bootstrap/);
  assert.match(mac, /开机自启\s*:\s*已禁用/);

  const relaunch = read('relaunch-with-cdp.sh');
  assert.doesNotMatch(relaunch, /launchctl bootstrap/);
  assert.match(relaunch, /手动启动(?: WorkDaddy)? 守护进程/);
});

test('daemon and Windows launcher logs identify the active WorkBuddy client', () => {
  assert.match(read('daemon.js'), /\[client=\$\{PROFILE\.name\}\] \[profile=\$\{PROFILE\.id\}\]/);
  assert.match(read('win-launcher.js'), /\[client=\$\{PROFILE\.name\}\] \[profile=\$\{PROFILE\.id\}\]/);
});

test('update card keeps the action button stable beside short progress text', () => {
  const script = read('inject.js');
  assert.match(script, /\.wbs-update-actions\{[^}]*min-width:0/);
  assert.match(script, /\.wbs-update-btn\{[^}]*flex:0 0 112px/);
  assert.match(script, /启动较慢，请稍候…/);
  assert.doesNotMatch(script, /也可双击桌面 .* 图标手动启动/);
});

test('Windows updater stops at the installer prompt after download', () => {
  const script = read('inject.js');
  assert.match(script, /var WBS_PLATFORM = __WBS_PLATFORM__/);
  assert.doesNotMatch(script, /var WBS_PLATFORM = '__WBS_PLATFORM__'/);
  const injectedWindows = script.replace(/__WBS_PLATFORM__/g, JSON.stringify('win32'));
  assert.match(injectedWindows, /var WBS_PLATFORM = "win32";/);
  assert.match(script, /function showWindowsInstallerReady\(prog, btn, card, timer\)/);
  assert.match(script, /function openWindowsInstallerAfterDownload\(prog, btn, card, timer, resolve, reject\)/);
  assert.match(script, /appendUpdateLog\(prog, '即将打开安装包…'\)/);
  assert.match(script, /if \(WBS_PLATFORM === 'win32'\) \{[\s\S]*openWindowsInstallerAfterDownload\(prog, btn, card, timer, resolve, reject\);/);
  assert.doesNotMatch(script, /下载和校验完成，可以打开安装程序。/);
});

test('update notes keep the full release text inside the panel scroll area', () => {
  const script = read('inject.js');
  assert.doesNotMatch(script, /\.slice\(0,\s*3\)\.map/);
  assert.doesNotMatch(script, /l\.length\s*>\s*48/);
  assert.doesNotMatch(script, /\.wbs-update-notes\{[^}]*max-height\s*:/);
  assert.doesNotMatch(script, /\.wbs-update-notes\{[^}]*overflow\s*:\s*hidden/);
  assert.match(script, /\.wbs-update-notes\{[^}]*overflow:visible/);
});

test('auto-continue and session controls are available on Windows and macOS', () => {
  const inject = read('inject.js');
  const daemon = read('daemon.js');
  assert.match(inject, /id="wbs-ac-row"/);
  assert.match(inject, /var acRow = enhancePane && enhancePane\.querySelector\('\#wbs-ac-row'\)/);
  assert.match(inject, /var AC_SUPPORTED = true/);
  assert.doesNotMatch(inject, /WBS_PLATFORM !== 'win32'/);
  assert.match(daemon, /platformSupported: true/);
  assert.doesNotMatch(daemon, /const enabled = !IS_WIN/);
  assert.doesNotMatch(daemon, /if \(IS_WIN\) return readAutoContinueState/);
  assert.match(inject, /id="wbs-sess-stash"/);
  assert.match(inject, /id="wbs-sess-phrase"/);
});

test('session listing does not hide standard timestamped WorkBuddy workspaces', () => {
  const inject = read('inject.js');
  const daemon = read('daemon.js');
  assert.match(inject, /function isTaskSessionRecordUI\(s\)\s*\{[\s\S]*return !!\(s && Number\(s\.is_playground\) === 1\);/);
  assert.match(daemon, /function isTaskSessionRecord\(cwd\)\s*\{[\s\S]*return false;/);
  assert.doesNotMatch(inject, /WorkBuddy\\\\\]\\d\{4\}/);
  assert.doesNotMatch(daemon, /WorkBuddy\\\\\]\\d\{4\}/);
  assert.doesNotMatch(daemon, /\.filter\(\(row\) => !isTaskSessionRecord\(row\.cwd\)\)/);
});

test('session file copy skips destinations nested inside the source directory', () => {
  const daemon = read('daemon.js');
  assert.match(daemon, /path\.relative\(fromResolved, toResolved\)/);
  assert.match(daemon, /targetInsideSource/);
  assert.match(daemon, /跳过源目录内复制/);
});

test('about page reports the running daemon version instead of stale package metadata', () => {
  const daemon = read('daemon.js');
  const aboutStart = daemon.indexOf("p === '/api/about'");
  const updateStart = daemon.indexOf("p === '/api/update-check'", aboutStart);
  assert.ok(aboutStart >= 0 && updateStart > aboutStart);
  const about = daemon.slice(aboutStart, updateStart);
  assert.match(about, /version:\s*DAEMON_VERSION/);
  assert.match(about, /packageVersion/);
  assert.doesNotMatch(about, /build\.version = pjson\.version/);
});

test('update failures preserve stage, attempt id, and apply log details for feedback', () => {
  const daemon = read('daemon.js');
  const inject = read('inject.js');
  assert.match(daemon, /attemptId: updateState\.attemptId/);
  assert.match(daemon, /applyLog: path\.join\(UPDATE_DIR, 'apply\.log'\)/);
  assert.match(inject, /formatUpdateFailure/);
  assert.match(inject, /尝试 ID/);
  assert.match(inject, /日志：/);
  assert.match(inject, /rgba\(226,75,74,\.045\)/);
});

test('update diagnostics persist a redacted local debug log through every major stage', () => {
  const daemon = read('daemon.js');
  const inject = read('inject.js');
  assert.match(daemon, /UPDATE_DEBUG_LOG/);
  assert.match(daemon, /function updateDebug/);
  for (const stage of ['daemon-start', 'check-start', 'check-result', 'download-start', 'download-progress', 'download-verified', 'apply-start', 'apply-script-start']) {
    assert.match(daemon, new RegExp("updateDebug\\('" + stage + "'"));
  }
  assert.match(daemon, /debugLog: UPDATE_DEBUG_LOG/);
  assert.match(daemon, /token\|cookie\|authorization/);
  assert.match(inject, /var runtimeVersion = WBS_VERSION/);
});

test('updaters reject an artifact whose internal daemon version disagrees with its release version', () => {
  const daemon = read('daemon.js');
  const win = read('apply-update.ps1');
  assert.match(daemon, /inspectPackagedApp/);
  assert.match(daemon, /安装包内部 daemon 版本/);
  assert.match(daemon, /artifact-inspect/);
  assert.match(win, /artifact inspect package=/);
  assert.match(win, /更新包内部 daemon 版本/);
  assert.match(win, /新版 daemon 实际版本/);
});

test('Windows update runtime must match the packaged daemon version even without a semver ZIP name', () => {
  const win = read('apply-update.ps1');
  assert.match(win, /-ExpectedVersion \$sourceDaemonVersion/);
  assert.match(win, /running daemon version=\$runningVersion expected=\$sourceDaemonVersion/);
  assert.match(win, /if \(\$runningVersion -ne \$sourceDaemonVersion\)/);
  assert.doesNotMatch(win, /if \(-not \[string\]::IsNullOrWhiteSpace\(\$packageVersion\) -and \$runningVersion -ne/);
});

test('sensitive local API routes require an injected token and do not expose wildcard CORS', () => {
  const daemon = read('daemon.js');
  const inject = read('inject.js');
  assert.match(daemon, /API_TOKEN_FILE/);
  assert.match(daemon, /X-WorkDaddy-Token/);
  assert.match(daemon, /isApiRequestAuthorized/);
  assert.match(daemon, /devtools-proxy.*Origin|Origin.*devtools-proxy/);
  assert.doesNotMatch(daemon, /'Access-Control-Allow-Origin': '\*'/);
  assert.match(inject, /__WBS_API_TOKEN__/);
  assert.match(inject, /X-WorkDaddy-Token/);
});

test('DevTools proxy uses the same persisted CDP port fallback as its URL endpoint', () => {
  const daemon = read('daemon.js');
  assert.match(daemon, /const upstreamPort = cdp\.port \|\| readCdpPortFile\(\) \|\| CDP_PORT_HINT \|\| 9222/);
  assert.match(daemon, /devtoolsPort = cdp\.port \|\| readCdpPortFile\(\) \|\| CDP_PORT_HINT \|\| 9222/);
  assert.match(daemon, /uid\.length > 200.*\[\\\\\/\\0\]/);
});

test('automatic updates use the GitHub asset digest and fail closed without one', () => {
  const daemon = read('daemon.js');
  assert.match(daemon, /normalizeAssetSha256\(asset\.digest\)/);
  assert.match(daemon, /dmgSha256/);
  assert.match(daemon, /发布未提供可信的 SHA-256，已停止更新/);
  assert.match(daemon, /validateUpdateArtifact\(target, expectSha\)/);
});

test('update downloads use a unique partial file before atomically promoting the package', () => {
  const daemon = read('daemon.js');
  assert.match(daemon, /const tempTarget = target \+ '\.part\.'/);
  assert.match(daemon, /createWriteStream\(tempTarget/);
  assert.match(daemon, /validateUpdateArtifact\(tempTarget, expectSha\)/);
  assert.match(daemon, /renameSync\(tempTarget, target\)/);
  assert.match(daemon, /updateDownloadPromise/);
  assert.match(daemon, /try \{ digest = sha256File\(file\); \} catch \(e\) \{[\s\S]*安装包 SHA-256 读取失败/);
});

test('account export asks for a non-empty password and import supports an optional password', () => {
  const daemon = read('daemon.js');
  const inject = read('inject.js');
  const secureTransfer = read('secure-transfer.js');
  assert.match(secureTransfer, /密码不能为空/);
  assert.match(secureTransfer, /randomBytes\(16\)/);
  assert.match(daemon, /version:\s*2/);
  assert.match(daemon, /EXPORT_PASSPHRASE/);
  assert.match(inject, /title:\s*'导出账号'[\s\S]*requirePassword:\s*true/);
  assert.match(inject, /旧版导出文件可留空/);
  assert.match(inject, /type="password"/);
});

test('zero credits omit the empty-state label', () => {
  const script = read('inject.js');
  assert.match(script, /if \(!list\.length\) return Number\(credits\) === 0 \? '' : '<div class="wbs-credit-empty">暂无可用积分<\/div>'/);
});

test('auto-copy rules persist sessions and canonical workspace keys without leaking account metadata', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-auto-copy-'));
  try {
    const expectedWorkspace = '/Users/example/project';
    lib.setAutoCopyRule(dir, { uid: 'source-a', kind: 'session', key: 'session-1', enabled: true });
    lib.setAutoCopyRule(dir, { uid: 'source-a', kind: 'workspace', key: '/Users/example/project/', enabled: true });
    let rules = lib.getAutoCopyRules(dir, 'source-a');
    assert.deepEqual(rules.sessionIds, ['session-1']);
    assert.deepEqual(rules.workspaces, [expectedWorkspace]);
    assert.equal(lib.canonicalWorkspace('/Users/example/project/'), expectedWorkspace);

    const lineageId = lib.getAutoCopySession(dir, 'source-a', 'session-1').lineageId;
    lib.setAutoCopyMapping(dir, lineageId, 'target-b', { targetId: 'copied-1', status: 'copied' });
    assert.equal(lib.getAutoCopyMapping(dir, lineageId, 'target-b').targetId, 'copied-1');
    lib.deleteAutoCopyMapping(dir, lineageId, 'target-b');
    assert.equal(lib.getAutoCopyMapping(dir, lineageId, 'target-b'), null);

    lib.setAutoCopyRule(dir, { uid: 'source-a', kind: 'session', key: 'session-1', enabled: false });
    rules = lib.getAutoCopyRules(dir, 'source-a');
    assert.deepEqual(rules.sessionIds, []);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    assert.ok(meta.autoCopy);
    assert.equal(meta.accounts && Object.keys(meta.accounts).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('automatic session copy includes workspace-only rules when the initial plan is empty', () => {
  const daemon = read('daemon.js');
  const inject = read('inject.js');
  assert.match(daemon, /POST' && p === '\/api\/sessions\/auto-copy'/);
  assert.match(daemon, /GET' && p === '\/api\/sessions\/auto-copy\/status'/);
  assert.match(daemon, /getAutoCopyMapping\(DATA_DIR, lineageId, targetUid\)/);
  assert.match(daemon, /getAutoCopySessionMembers\(DATA_DIR, lineageId, targetUid\)/);
  assert.match(daemon, /const canonicalId = candidates\[0\]\.id/);
  assert.match(daemon, /const sourceRules = sourceUid \? getAutoCopyRules\(DATA_DIR, sourceUid\)/);
  assert.match(daemon, /hasSourceAutoCopyRules/);
  assert.match(daemon, /hasPendingAutoCopyTo\(uid\)/);
  assert.match(daemon, /startAutoCopyJob\(sourceUid, uid, autoCopyPlan\)/);
  assert.match(daemon, /syncAutoCopyLineage\(src\.lineageId, targetUid\)/);
  assert.match(daemon, /selectLatestAutoCopyMember\(live\)/);
  assert.match(daemon, /lineageId = ensureAutoCopySession\(DATA_DIR, source, row\.id\)/);
  assert.match(inject, /data-auto-kind="' \+ kind \+ '"/);
  assert.match(inject, /autoCopyButton\('workspace'/);
  assert.match(inject, /autoCopyButton\('session'/);
});

test('session summary counts effective sessions and models tab only exposes sanitized model APIs', () => {
  const daemon = read('daemon.js');
  const inject = read('inject.js');
  assert.match(inject, /function activeAutoCopyCount\(\)/);
  assert.match(inject, /wbs-sess-summary-tag/);
  assert.match(inject, /data-tab="models"/);
  assert.match(inject, /data-model-tab="official"/);
  assert.match(inject, /data-model-tab="mine"/);
  assert.match(daemon, /GET' && p === '\/api\/models'/);
  assert.match(daemon, /POST' && p === '\/api\/models\/import'/);
  assert.match(daemon, /listInstalledModelSources/);
  assert.match(daemon, /POST' && p === '\/api\/models\/backup'/);
  assert.match(daemon, /POST' && p === '\/api\/models\/delete-official'/);
  assert.match(daemon, /POST' && p === '\/api\/models\/test'/);
  assert.match(daemon, /POST' && p === '\/api\/models\/copy'/);
  assert.match(daemon, /POST' && p === '\/api\/models\/edit'/);
  assert.match(daemon, /POST' && p === '\/api\/models\/delete'/);
  assert.match(daemon, /requested: ids\.length, deleted/);
  assert.match(read('lib.js'), /\.legacy-migrated-v1/);
  assert.match(daemon, /POST' && p === '\/api\/models\/enable'/);
  // 模型页 UI 明文展示 apiKey：列表走 sanitizeModel(model, { revealKey: true })，默认仍脱敏
  assert.match(read('lib.js'), /function sanitizeModel\(model, opts\)/);
  assert.match(read('lib.js'), /revealKey/);
  assert.match(read('lib.js'), /function maskApiKey\(apiKey\)/);
  assert.match(read('lib.js'), /function copyModelBackup\(dataDir, backupId\)/);
  assert.match(read('lib.js'), /function editModelBackup\(dataDir, backupId, patch\)/);
  assert.match(read('lib.js'), /modelBackupsDir\(dataDir\)/);
  assert.match(inject, /data-model-copy=/);
  assert.match(inject, /data-model-edit=/);
  assert.match(inject, /wbs-model-check-all/);
  assert.match(inject, /wbs-model-edit-eye/);
  assert.match(inject, /自定义名称.*wbs-model-edit-name/);
  assert.match(inject, /模型名.*wbs-model-edit-id/);
  assert.doesNotMatch(inject, /模型名（id）|自定义名称（name）/);
  assert.match(inject, /id\.value = item\.id \|\| item\.name/);
  assert.match(inject, /name\.value = item\.name \|\| item\.id/);
  assert.match(inject, /var patch = \{ id: id\.value, name: name\.value, url: url\.value \};/);
  assert.match(inject, /wbs-model-group-title.*esc\(group\.id \|\|/);
  assert.doesNotMatch(inject, /wbs-model-group-title.*esc\(group\.name \|\|/);
  assert.match(read('lib.js'), /模型名对应配置里的 id/);
  assert.match(read('lib.js'), /分组严格依据原始模型配置的 id/);
  assert.match(read('lib.js'), /const id = typeof model\.id === 'string'/);
  assert.match(read('lib.js'), /new Map\(\)/);
  assert.match(read('lib.js'), /groups\.get\(key\)\.items\.push/);
  assert.match(read('lib.js'), /\['id', 'name', 'url', 'apiKey'\]/);
  assert.match(inject, /小贴士.*解决 WorkBuddy 不支持多个同名模型的问题/);
  assert.match(inject, /data-model-tab="official">当前模型/);
  assert.match(inject, /data-model-tab="mine">备选模型/);
  assert.match(inject, /data-model-import=/);
  assert.match(inject, /\/api\/models\/import/);
  assert.match(inject, /签到请求完成后再查询积分/);
  assert.match(inject, /fetchCreditsForAccounts\(\);/);
  assert.match(read('lib.js'), /function checkinDisplayValue\(record, today, pending\)/);
  assert.match(daemon, /CREDIT_USAGE_STORE\.listDailyCheckins/);
  assert.match(daemon, /checkin: checkinDisplayValue\(checked, today, checkinPending\)/);
  assert.doesNotMatch(inject, /id="wbs-model-refresh"/);
  assert.match(inject, /wbs-model-group-title/);
  assert.match(inject, /delete-official/);
  assert.match(inject, /data-model-test=/);
  assert.match(inject, /MODEL_BACKUP_SVG/);
  assert.match(inject, /MODEL_COPY_SVG/);
  assert.doesNotMatch(inject, /不修改时保持原 API Key/);
  assert.match(inject, /height:650px/);
  assert.doesNotMatch(inject, /模型备份保存在 WorkDaddy 本地目录/);
});
