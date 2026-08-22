const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(repoRoot, 'scripts', name), 'utf8');
const lib = require(path.join(repoRoot, 'scripts', 'lib.js'));

test('Windows updater launches the installed scripts launcher', () => {
  const script = read('apply-update.ps1');
  assert.match(script, /Join-Path\s+\$AppDir\s+'scripts\\launcher\.cmd'/);
  assert.match(script, /Join-Path\s+\$AppDir\s+'scripts\\launcher-hidden\.vbs'/);
  assert.match(script, /Start-Process[\s\S]*-ErrorAction Stop/);
  assert.match(script, /Invoke-RestMethod[\s\S]*\/api\/status/);
});

test('Windows updater stops the watchdog before waiting for the API port', () => {
  const script = read('apply-update.ps1');
  const stop = script.indexOf('function Stop-WatchdogAndPort');
  const wait = script.indexOf('for ($wait = 0; $wait -lt 15; $wait++)');
  assert.notEqual(stop, -1);
  assert.notEqual(wait, -1);
  assert.ok(stop < wait, 'watchdog shutdown must precede the port wait');
});

test('Windows install and update release a locked launcher before replacing it', () => {
  const install = read('install-win.ps1');
  const update = read('apply-update.ps1');
  assert.match(install, /FileShare\]\s*::None/);
  assert.match(install, /launcher\.cmd/);
  assert.match(install, /Get-CimInstance\s+Win32_Process/);
  assert.match(install, /taskkill \/F \/T \/PID/);
  assert.ok(install.indexOf('Release-LockedLauncher') < install.indexOf('robocopy $SrcDir $targetScripts'), 'install must release launcher before robocopy');
  assert.match(update, /FileShare\]\s*::None/);
  assert.match(update, /launcher\.cmd/);
  assert.match(update, /Get-CimInstance\s+Win32_Process/);
  assert.ok(update.indexOf('Release-LockedLauncher') < update.indexOf('Move-Item -LiteralPath $AppDir'), 'update must release launcher before moving the old app');
});

test('macOS updater stops the daemon before waiting for the API port', () => {
  const script = read('apply-update.sh');
  const stop = script.indexOf('pkill -f');
  const wait = script.indexOf('for i in $(seq 1 30)');
  assert.notEqual(stop, -1);
  assert.notEqual(wait, -1);
  assert.ok(stop < wait, 'daemon shutdown must precede the port wait');
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

test('CDP startup supports a persisted fallback port instead of hardcoding 9222', { skip: !fs.existsSync(path.join(repoRoot, 'WorkDaddy.app', 'Contents', 'MacOS', 'launcher')) ? 'WorkDaddy.app 打包产物不在源码仓库中，macOS launcher 断言仅在含产物的环境验证' : false }, () => {
  const daemon = read('daemon.js');
  const macLauncher = fs.readFileSync(path.join(repoRoot, 'WorkDaddy.app', 'Contents', 'MacOS', 'launcher'), 'utf8');
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
  assert.match(launcher, /elapsedMs\s*<\s*CDP_STARTUP_TIMEOUT_MS/);
});

test('Windows launcher discovers portable WorkBuddy installations', () => {
  const launcher = read('win-launcher.js');
  assert.match(launcher, /App Paths/);
  assert.match(launcher, /Software[\\/].*workbuddy/i);
  assert.match(launcher, /WBSWITCH_WORKBUDDY_BIN/);
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
  assert.match(script, /剩余积分/);
  assert.match(script, /今日已签到/);
  assert.match(script, /登录过期于/);
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
  assert.doesNotMatch(script, /wbs-token-expired/);
  assert.doesNotMatch(script, /按到期时间排序/);
  assert.doesNotMatch(script, /个额度/);
  assert.doesNotMatch(script, /wbs-checkin-cell/);
});

test('robot button decorations remain visible alongside the eye states', () => {
  const script = read('inject.js');
  assert.match(script, /wbs-fab-antenna/);
  assert.match(script, /wbs-fab-ear wbs-fab-ear-left/);
  assert.match(script, /wbs-fab-ear wbs-fab-ear-right/);
  assert.match(script, /\.wbs-fab-ear\{[^}]*width:20px;height:30px[^}]*background:#141416/);
  assert.match(script, /\.wbs-fab-ear::before\{[^}]*width:12px;height:22px[^}]*background:#141416/);
  assert.doesNotMatch(script, /\.wbs-fab-ear::before\{[^}]*background:#fff/);
  assert.match(script, /\.wbs-fab-ear::after\{[^}]*width:4px;height:10px[^}]*background:#141416/);
  assert.match(script, /wbs-fab-ear-left\{left:-11px;transform:[^}]*rotate\(-8deg\)/);
  assert.match(script, /wbs-fab-ear-right\{right:-11px;transform:[^}]*rotate\(8deg\)/);
  assert.match(script, /\.wbs-fab \.click > span:not\(\.wbs-fab-antenna\):not\(\.wbs-fab-ear\)\{display:none\}/);
  assert.doesNotMatch(script, /\.wbs-fab \.click span\{display:none\}/);
  assert.match(script, /\.wbs-fab \.click \.button \.speak~\.speak\{display:none\}/);
});

test('home composer keeps the robot button at the WorkBuddy bottom-right', () => {
  const script = read('inject.js');
  assert.match(script, /\.wb-home-page \[class\*="_topRightSlotStandalone_"\] > div:nth-child\(1\) > div:nth-child\(3\)/);
  assert.match(script, /fab\.style\.right = '22px';\s*fab\.style\.bottom = '22px';/);
});

test('zero credits omit the empty-state label', () => {
  const script = read('inject.js');
  assert.match(script, /if \(!list\.length\) return Number\(credits\) === 0 \? '' : '<div class="wbs-credit-empty">暂无可用积分<\/div>'/);
});

test('auto-copy rules persist sessions and canonical workspace keys without leaking account metadata', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-auto-copy-'));
  try {
    lib.setAutoCopyRule(dir, { uid: 'source-a', kind: 'session', key: 'session-1', enabled: true });
    lib.setAutoCopyRule(dir, { uid: 'source-a', kind: 'workspace', key: '/Users/example/project/', enabled: true });
    let rules = lib.getAutoCopyRules(dir, 'source-a');
    assert.deepEqual(rules.sessionIds, ['session-1']);
    // canonicalWorkspace 在 Windows 上会转小写，断言用同一函数求期望值，保持跨平台一致
    const expectedWorkspace = lib.canonicalWorkspace('/Users/example/project');
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

test('automatic session copy has a status endpoint, idempotency mapping, and no task-level marker', () => {
  const daemon = read('daemon.js');
  const inject = read('inject.js');
  assert.match(daemon, /POST' && p === '\/api\/sessions\/auto-copy'/);
  assert.match(daemon, /GET' && p === '\/api\/sessions\/auto-copy\/status'/);
  assert.match(daemon, /getAutoCopyMapping\(DATA_DIR, lineageId, targetUid\)/);
  assert.match(daemon, /startAutoCopyJob\(sourceUid, uid, autoCopyPlan\)/);
  assert.match(inject, /data-auto-kind="' \+ kind \+ '"/);
  assert.match(inject, /autoCopyButton\('workspace'/);
  assert.match(inject, /autoCopyButton\('session'/);
  assert.match(inject, /任务组本身没有自动复制按钮/);
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
  assert.match(daemon, /POST' && p === '\/api\/models\/backup'/);
  assert.match(daemon, /POST' && p === '\/api\/models\/delete-official'/);
  assert.match(daemon, /POST' && p === '\/api\/models\/test'/);
  assert.match(daemon, /POST' && p === '\/api\/models\/copy'/);
  assert.match(daemon, /POST' && p === '\/api\/models\/edit'/);
  assert.match(daemon, /POST' && p === '\/api\/models\/delete'/);
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
  assert.match(inject, /小贴士.*解决 WorkBuddy 不支持多个同名模型的问题/);
  assert.match(inject, /data-model-tab="official">当前模型/);
  assert.match(inject, /data-model-tab="mine">备选模型/);
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
