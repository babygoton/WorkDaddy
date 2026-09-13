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
    assert.match(source, /\/usr\/bin\/open -a "\$TARGET_APP_BUNDLE" --args "--remote-debugging-port=\$PORT"/);
    execFileSync('bash', ['-n', launcher]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
