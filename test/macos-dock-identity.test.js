'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
test('packaged macOS launcher starts the app through LaunchServices, not its Electron child', () => {
  const root = path.join(__dirname, '..');
  const build = fs.readFileSync(path.join(root, 'scripts/build-mac-dmg.sh'), 'utf8');
  const blocks = [...build.matchAll(/python3 - "\$PACKAGE_APP\/Contents\/MacOS\/launcher" <<'PY'\n([\s\S]*?)\nPY/g)];
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbs-dock-'));
  try {
    const launcher = path.join(dir, 'launcher');
    fs.copyFileSync(path.join(root, 'WorkDaddy.app/Contents/MacOS/launcher'), launcher);
    for (const block of blocks) execFileSync('python3', ['-', launcher], { input: block[1] });
    const source = fs.readFileSync(launcher, 'utf8');
    assert.doesNotMatch(source, /nohup "\$APP_BIN"/);
    assert.match(source, /\/usr\/bin\/open -a "\$TARGET_APP_BUNDLE" "\$\{OPEN_ARGS\[@\]\}"/);
    execFileSync('/bin/bash', ['-n', launcher]);
    // Execute the generated cold-start block with macOS Bash 3.2 and a fake
    // open command. CN/AI must reach open even without a native inspector arg.
    const start = source.indexOf('TARGET_APP_BUNDLE="${APP_BIN%/Contents/MacOS/*}"');
    const end = source.indexOf('\nfi', source.indexOf('if ! /usr/bin/open', start)) + 3;
    assert.ok(start > 0 && end > start);
    const launch = source.slice(start, end).replace('/usr/bin/open', 'capture_open');
    const app = path.join(dir, 'Client With Spaces.app');
    fs.mkdirSync(app);
    for (const [profile, port, inspector] of [
      ['workbuddy-cn', '9222', null], ['workbuddy-ai', '9223', null],
      ['codebuddy-cn', '9224', '9244'], ['codebuddy-intl', '9225', '9245'],
    ]) {
      const output = execFileSync('/bin/bash', ['-s'], {
        input: 'set -eu\ncapture_open() { printf "%s\\n" "$@"; }\nnotify() { :; }\n' + launch,
        env: { ...process.env, PROFILE: profile, PORT: port, APP_BIN: app + '/Contents/MacOS/Electron' },
        encoding: 'utf8',
      });
      assert.deepEqual(output.trim().split('\n'), [
        '-a', app, '--args', '--remote-debugging-port=' + port,
        ...(inspector ? ['--inspect=127.0.0.1:' + inspector] : []),
      ], profile);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
