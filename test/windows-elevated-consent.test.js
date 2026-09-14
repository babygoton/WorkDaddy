'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const boundary = require('../scripts/windows-process-boundary.js');
const read = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

// Windows APIs and Inno UI need Windows; lock down their integration here.
test('installer obtains explicit consent before cleanup and enables subsequent shortcut launches', () => {
  const src = read('scripts/win/workdaddy.iss');
  assert.match(src, /--desktop-token-status/);
  assert.match(src, /Caption := '我已了解风险，继续安装'/);
  assert.match(src, /Button\.Default := False/);
  assert.match(src, /CancelButton\.Default := True/);
  assert.match(src, /WizardSilent[\s\S]*--check-elevated-session/);
  assert.match(src, /--accept-elevated-session --app-dir/);
  assert.match(src, /function ShouldLaunchElevatedSession[\s\S]*Result := ElevatedSessionConfirmed/);
  assert.match(src, /if IsAdmin and not ElevatedSessionConfirmed then\s+exit/);
  assert.match(src, /if ElevatedSessionConfirmed then[\s\S]*Result := Exec\(/);
  const prepare = src.slice(src.indexOf('function PrepareToInstall'));
  assert.ok(prepare.indexOf('ConfirmElevatedInstall') < prepare.indexOf('EnsureWorkBuddyClosed'));
});

test('elevated exception requires unsplit desktop token and persisted user/profile/install consent', () => {
  const src = read('scripts/windows-native/main.go');
  assert.match(src, /func desktopSessionSupportsElevated/);
  assert.match(src, /tokenElevationType/);
  assert.match(src, /elevationType != 1/);
  assert.match(src, /shellSID == currentSID/);
  assert.match(src, /windows-elevated-consent\.json/);
  assert.match(src, /consent\.Version == 1/);
  assert.match(src, /consent\.Profile == profile/);
  assert.match(src, /samePath\(consent\.AppDir, appDir\)/);
  assert.match(src, /consent\.UserSID == sid/);
  assert.match(src, /func elevatedSessionAllowed[\s\S]*desktopSessionSupportsElevated/);
  assert.match(src, /func terminateExactProcess[\s\S]*verifySameProcessSecurity\(handle\)/);
  assert.match(src, /--launch-context/);
  assert.match(src, /elevated && !elevatedSessionAllowed/);
});

test('native privilege query validates real helper response and never defaults errors to standard', () => {
  for (const privilege of ['standard', 'elevated']) {
    const actual = boundary.detectNativeWindowsPrivilege('C:\\Apps\\WorkDaddy', 'workbuddy-cn', (exe, args) => {
      assert.match(exe, /WorkDaddyLauncher\.exe$/);
      assert.deepEqual(args, ['--launch-context', '--profile', 'workbuddy-cn', '--app-dir', 'C:\\Apps\\WorkDaddy']);
      return { status: 0, stdout: JSON.stringify({ profile: 'workbuddy-cn', privilege }) };
    });
    assert.equal(actual, privilege);
  }
  for (const result of [
    { status: 5, stdout: '{"privilege":"elevated","profile":"workbuddy-cn"}' },
    { status: 0, stdout: '{}' },
    { status: 0, stdout: 'broken' },
    { status: 0, stdout: '{"privilege":"unknown","profile":"workbuddy-cn"}' },
    { status: 0, stdout: '{"privilege":"elevated","profile":"workbuddy-ai"}' },
    { status: null, error: new Error('timeout') },
  ]) assert.throws(() => boundary.detectNativeWindowsPrivilege('C:\\Apps\\WorkDaddy', 'workbuddy-cn', () => result));
});

test('native daemon reuse requires matching actual privilege as well as profile/build/data identity', () => {
  const src = read('scripts/win-launcher.js');
  const fn = src.slice(src.indexOf('function nativeDaemonStatusMatches('), src.indexOf('\nasync function waitForNativeDaemon'));
  const baseline = { ok: true, profile: { id: 'workbuddy-cn' }, dataDir: 'data', version: '1', buildId: 'build', privilege: 'elevated' };
  for (const privilege of ['elevated', 'standard']) {
    const context = vm.createContext({ WINDOWS_PRIVILEGE: privilege, readDaemonIdentity: () => ({ version: '1', buildId: 'build' }), PROFILE: { id: 'workbuddy-cn' }, DATA_DIR: 'data', sameWindowsPath: (a, b) => a === b });
    vm.runInContext(fn, context);
    const status = { ...baseline, privilege };
    assert.equal(context.nativeDaemonStatusMatches(status), true);
    for (const delta of [{ privilege: privilege === 'standard' ? 'elevated' : 'standard' }, { version: 'old' }, { buildId: 'old' }, { dataDir: 'other' }, { profile: { id: 'workbuddy-ai' } }]) {
      assert.equal(context.nativeDaemonStatusMatches({ ...status, ...delta }), false);
    }
  }
  assert.match(read('scripts/daemon.js'), /detectNativeWindowsPrivilege/);
  assert.doesNotMatch(read('scripts/daemon.js'), /WBSWITCH_NATIVE_LAUNCHER === '1' \? 'standard'/);
  assert.match(src, /function hasElevatedSessionConsent[\s\S]*--check-elevated-session/);
});

test('native consent policy rejects missing, corrupt, foreign and no-longer-eligible consent', (t) => {
  const { spawnSync } = require('node:child_process');
  const os = require('node:os');
  if (spawnSync('go', ['version']).status !== 0) return t.skip('Go compiler unavailable');
  const source = read('scripts/windows-native/main.go');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-consent-policy-'));
  try {
    // Compile the actual policy functions unchanged. Only Win32 probes are
    // substituted, so refusal and persistence can be tested on macOS/Linux.
    const policy = source.slice(source.indexOf('func elevatedSessionAllowed('), source.indexOf('\nfunc helperAppDir('));
    const structure = source.slice(source.indexOf('type elevatedConsent struct'), source.indexOf('\nfunc tokenDword('));
    fs.writeFileSync(path.join(dir, 'policy.go'), `package main
import ("encoding/json"; "errors"; "os"; "path/filepath"; "strings")
var eligible = true
var activeSID = "test-user"
var root string
func desktopSessionSupportsElevated() bool { return eligible }
func currentUserSID() (string, error) { return activeSID, nil }
func dataDir(profile string) (string, error) { return filepath.Join(root, profile), nil }
func samePath(a, b string) bool { return strings.EqualFold(filepath.Clean(a), filepath.Clean(b)) }
${structure}
${policy}`);
    fs.writeFileSync(path.join(dir, 'policy_test.go'), `package main
import ("os"; "path/filepath"; "testing")
func TestConsent(t *testing.T) {
 root = t.TempDir()
 app := filepath.Join(root, "install")
 if elevatedSessionAllowed("cn", app) { t.Fatal("missing consent allowed") }
 if err := saveElevatedConsent("cn", app); err != nil { t.Fatal(err) }
 if !elevatedSessionAllowed("cn", app) { t.Fatal("accepted consent rejected") }
 if elevatedSessionAllowed("ai", app) { t.Fatal("foreign profile allowed") }
 if elevatedSessionAllowed("cn", app+"-other") { t.Fatal("foreign install allowed") }
 if elevatedSessionAllowed("cn", "relative") { t.Fatal("relative path allowed") }
 activeSID = "another-user"
 if elevatedSessionAllowed("cn", app) { t.Fatal("foreign user allowed") }
 activeSID = "test-user"
 eligible = false
 if elevatedSessionAllowed("cn", app) { t.Fatal("ordinary desktop bypassed downgrade") }
 if err := saveElevatedConsent("ai", app); err == nil { t.Fatal("ineligible session saved consent") }
 eligible = true
 name := filepath.Join(root, "cn", "windows-elevated-consent.json")
 for _, contents := range []string{"", "{", "null", "{}", "[]", "{\\\"version\\\":2}"} {
  if err := os.WriteFile(name, []byte(contents), 0600); err != nil { t.Fatal(err) }
  if elevatedSessionAllowed("cn", app) { t.Fatal("invalid consent accepted", contents) }
 }
 if err := saveElevatedConsent("cn", app); err != nil { t.Fatal(err) }
 if !elevatedSessionAllowed("cn", app) { t.Fatal("repaired consent rejected") }
}`);
    const result = spawnSync('go', ['test', 'policy.go', 'policy_test.go'], { cwd: dir, encoding: 'utf8', timeout: 60000 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
