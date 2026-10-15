'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const reporter = path.join(repoRoot, 'scripts', 'sentry-report.js');
const { setTelemetryEnabled, telemetryEnabled } = require(reporter);
const reporterSource = fs.readFileSync(reporter, 'utf8');
const daemonSource = fs.readFileSync(path.join(repoRoot, 'scripts', 'daemon.js'), 'utf8');
const injectSource = fs.readFileSync(path.join(repoRoot, 'scripts', 'inject.js'), 'utf8');

function dryRun(profile, sharedDataDir) {
  const result = childProcess.spawnSync(process.execPath, [reporter, '--dry-run', '--stage', 'test', '--message', 'profile test'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      WBSWITCH_PROFILE: profile,
      WBSWITCH_SHARED_DATA_DIR: sharedDataDir,
      WORKDADDY_TELEMETRY: '0',
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function dryRunAsync(profile, sharedDataDir) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, [reporter, '--dry-run', '--stage', 'test', '--message', 'profile test'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        WBSWITCH_PROFILE: profile,
        WBSWITCH_SHARED_DATA_DIR: sharedDataDir,
        WORKDADDY_TELEMETRY: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) reject(new Error(stderr || `Sentry dry run exited ${code}`));
      else {
        try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
      }
    });
  });
}

test('Sentry events identify WorkBuddy CN and WorkBuddy AI without account data', () => {
  const sharedDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-sentry-identity-'));
  try {
    const cn = dryRun('workbuddy-cn', sharedDataDir);
    assert.equal(cn.tags.client, 'workbuddy');
    assert.equal(cn.tags.client_name, 'WorkBuddy');
    assert.equal(cn.tags.workbuddy_variant, 'workbuddy');
    assert.deepEqual(cn.contexts.client, { name: 'WorkBuddy', profile: 'workbuddy-cn', variant: 'workbuddy' });

    const ai = dryRun('workbuddy-ai', sharedDataDir);
    assert.equal(ai.tags.client, 'workbuddy-ai');
    assert.equal(ai.tags.client_name, 'WorkBuddy AI');
    assert.equal(ai.tags.workbuddy_variant, 'workbuddy-ai');
    assert.deepEqual(ai.contexts.client, { name: 'WorkBuddy AI', profile: 'workbuddy-ai', variant: 'workbuddy-ai' });
    assert.match(cn.user.id, /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
    assert.equal(ai.user.id, cn.user.id, 'CN and AI profiles must share one anonymous installation id');
    assert.equal(fs.readFileSync(path.join(sharedDataDir, 'installation-id'), 'utf8').trim(), cn.user.id);
    assert.doesNotMatch(JSON.stringify(ai), /accessToken|refreshToken|cookie|password/i);
  } finally {
    fs.rmSync(sharedDataDir, { recursive: true, force: true });
  }
});

test('concurrent first-run reporters publish one complete installation id', async () => {
  const sharedDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-sentry-concurrent-'));
  try {
    const events = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      dryRunAsync(index % 2 ? 'workbuddy-ai' : 'workbuddy-cn', sharedDataDir)));
    const ids = new Set(events.map((event) => event.user && event.user.id));
    assert.equal(ids.size, 1);
    const [id] = ids;
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
    assert.equal(fs.readFileSync(path.join(sharedDataDir, 'installation-id'), 'utf8').trim(), id);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.join(sharedDataDir, 'installation-id')).mode & 0o777, 0o600);
      assert.equal(fs.statSync(sharedDataDir).mode & 0o777, 0o700);
    }
  } finally {
    fs.rmSync(sharedDataDir, { recursive: true, force: true });
  }
});

test('diagnostic telemetry defaults on and respects explicit overrides', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-telemetry-setting-'));
  try {
    const env = { WBSWITCH_DATA_DIR: dataDir };
    assert.equal(telemetryEnabled(env), true);
    assert.equal(telemetryEnabled({ ...env, WORKDADDY_TELEMETRY: '0' }), false);
    assert.equal(telemetryEnabled({ ...env, WORKDADDY_TELEMETRY: 'true' }), true);
    assert.equal(telemetryEnabled({ ...env, WORKDADDY_TELEMETRY: '1' }), true);
    setTelemetryEnabled(false, { WBSWITCH_DATA_DIR: dataDir });
    assert.equal(telemetryEnabled(env), false);
    setTelemetryEnabled(true, { WBSWITCH_DATA_DIR: dataDir });
    assert.equal(telemetryEnabled(env), true);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('disabled telemetry returns before sending or draining the outbox', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-telemetry-'));
  const outbox = path.join(dataDir, 'telemetry', 'outbox');
  const queued = path.join(outbox, 'queued.json');
  try {
    fs.mkdirSync(outbox, { recursive: true });
    fs.writeFileSync(queued, '{}');
    const script = `require(${JSON.stringify(reporter)}).captureMessage('disabled test').then((result) => process.stdout.write(JSON.stringify(result)))`;
    const result = childProcess.spawnSync(process.execPath, ['-e', script], {
      cwd: repoRoot,
      env: { ...process.env, WBSWITCH_DATA_DIR: dataDir, WORKDADDY_TELEMETRY: '0' },
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { disabled: true });
    assert.equal(fs.existsSync(queued), true);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('production daemon does not persist composer contents through a debug route', () => {
  assert.doesNotMatch(daemonSource, /\/api\/save-composer/);
  assert.doesNotMatch(daemonSource, /composer-captures|composer-debug\.json/);
});

test('renderer diagnostics share the telemetry setting, stay redacted, and require a token', () => {
  assert.match(daemonSource, /function diagnosticsEnabled\(\) \{[\s\S]+diagnosticsState = \{ value: telemetryEnabled\(\)/);
  assert.doesNotMatch(daemonSource, /WORKDADDY_DIAGNOSTIC_LOGS/);
  assert.equal((daemonSource.match(/if \(!diagnosticsEnabled\(\)\) break;/g) || []).length, 2);
  assert.doesNotMatch(daemonSource, /!origin[^\n]+\/api\/breadcrumb/);
  assert.match(daemonSource, /\[breadcrumb\][^\n]+redactDiagnosticText/);
  assert.match(daemonSource, /if \(!shouldPersistBreadcrumb\(body\)\) return json/);
  assert.match(daemonSource, /replace\(\/__WBS_DIAGNOSTICS_ENABLED__\/g, diagnosticsEnabled\(\) \? 'true' : 'false'\)/);
  assert.match(daemonSource, /注入脚本页面抛错[^\n]+redactDiagnosticText\(desc, 500\)/);

  const errorHookStart = injectSource.indexOf('function wbsReportErr');
  const errorHookEnd = injectSource.indexOf("window.addEventListener('error'", errorHookStart);
  assert.ok(errorHookStart >= 0 && errorHookEnd > errorHookStart);
  const errorHook = injectSource.slice(errorHookStart, errorHookEnd);
  assert.match(injectSource, /var WBS_DIAGNOSTICS_ENABLED = __WBS_DIAGNOSTICS_ENABLED__/);
  assert.match(errorHook, /if \(WBS_DIAGNOSTICS_ENABLED\) \{[\s\S]+\/api\/breadcrumb/);
  assert.equal((errorHook.match(/\/api\/breadcrumb/g) || []).length, 1);

  const start = daemonSource.indexOf('function redactDiagnosticText');
  const end = daemonSource.indexOf('function validCdpPort', start);
  assert.ok(start >= 0 && end > start);
  const getDiagnosticHelpers = new Function(`${daemonSource.slice(start, end)}; return { redactDiagnosticText, shouldPersistBreadcrumb };`);
  const helpers = getDiagnosticHelpers();
  const redacted = helpers.redactDiagnosticText('authorization: Basic dXNlcjpwYXNz password="two words" secret=plain apiKey="sk-test" cookie: sid=private eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123', 300);
  assert.doesNotMatch(redacted, /dXNlcjpwYXNz|two words|plain|sk-test|sid=private|eyJhbGci/);
  assert.match(redacted, /redacted/i);
  const jwtRedacted = helpers.redactDiagnosticText('failure eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123', 200);
  assert.doesNotMatch(jwtRedacted, /eyJhbGci|signature123/);
  assert.equal(helpers.shouldPersistBreadcrumb({ msg: 'crash:error:private', extra: { stack: 'private' } }, false), false);
  assert.equal(helpers.shouldPersistBreadcrumb({ msg: 'operational', extra: { stack: 'private' } }, false), false);
  assert.equal(helpers.shouldPersistBreadcrumb({ msg: 'enqueue:done' }, false), true);
  assert.equal(helpers.shouldPersistBreadcrumb({ msg: 'crash:error:private' }, true), true);
  assert.doesNotMatch(injectSource, /crumb\([^\n]+\+\s*sessionId/);
});

test('telemetry settings are token-protected and default to enabled', () => {
  assert.match(daemonSource, /p === '\/api\/telemetry-settings'/);
  assert.match(daemonSource, /enabled: telemetryEnabled\(\)/);
  assert.match(daemonSource, /setTelemetryEnabled\(body\.enabled\)/);
  assert.match(daemonSource, /telemetryEnvironmentOverride\(\) !== null/);
  const publicApiBlock = daemonSource.match(/const PUBLIC_API_PATHS = new Set\(\[[\s\S]*?\]\);/);
  assert.ok(publicApiBlock);
  assert.doesNotMatch(publicApiBlock[0], /telemetry-settings/);
  assert.match(injectSource, /id="wbs-telemetry-switch"/);
  assert.match(injectSource, /发送错误诊断/);
  assert.match(injectSource, /wbs-telemetry-help/);
  assert.match(injectSource, /wbs-telemetry-label \.wbs-pcard-title\{margin-bottom:0\}/);
  assert.match(injectSource, /wbs-telemetry-tooltip/);
  assert.match(injectSource, /wbs-about-hero[\s\S]*wbs-telemetry-card/);
  assert.match(injectSource, /api\('\/api\/telemetry-settings'/);
});

test('privacy documentation distinguishes local data from required remote services', () => {
  const readme = require('node:fs').readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  assert.doesNotMatch(readme, /零远程通信/);
  assert.match(readme, /WORKDADDY_TELEMETRY=0/);
  assert.match(readme, /发送错误诊断/);
  assert.doesNotMatch(readme, /WORKDADDY_DIAGNOSTIC_LOGS/);
  assert.match(readme, /本地脱敏渲染器日志/);
  assert.match(readme, /GitHub Releases/);
  assert.match(readme, /WorkBuddy 官方 API/);
  assert.doesNotMatch(readme, /内置导入密钥/);
  assert.match(readme, /每次导出随机 salt/);
  assert.match(readme, /模型连通测试/);
  assert.match(readme, /对应 API Key/);
});

test('repair reporter requires a verified Sentry send when requested', () => {
  assert.match(reporterSource, /if \(key === 'force-send'\)/);
  assert.match(reporterSource, /if \(args\.requireSent && result\.sent !== true\) process\.exitCode = 1/);
  assert.match(reporterSource, /process\.exitCode = 1/);
});
