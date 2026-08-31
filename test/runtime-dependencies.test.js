'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const scriptsDir = path.join(root, 'scripts');

test('runtime entry points have every relative CommonJS dependency', () => {
  const pending = ['daemon.js', 'win-launcher.js', 'watchdog.js'];
  const visited = new Set();
  const optional = new Set(['package.json', 'plist-reader.js']);
  while (pending.length) {
    const relativeFile = pending.pop();
    if (visited.has(relativeFile)) continue;
    visited.add(relativeFile);
    const source = fs.readFileSync(path.join(scriptsDir, relativeFile), 'utf8');
    for (const match of source.matchAll(/require\(['"](\.\/[^'"]+)['"]\)/g)) {
      const dependency = path.normalize(path.join(path.dirname(relativeFile), match[1]));
      const dependencyFile = path.extname(dependency) ? dependency : dependency + '.js';
      if (optional.has(dependencyFile)) continue;
      assert.equal(fs.existsSync(path.join(scriptsDir, dependencyFile)), true,
        `${relativeFile} requires missing ${dependencyFile}`);
      if (dependencyFile.endsWith('.js')) pending.push(dependencyFile);
    }
  }
});

test('macOS release stages every daemon startup dependency', () => {
  const daemonSource = fs.readFileSync(path.join(scriptsDir, 'daemon.js'), 'utf8');
  const buildSource = fs.readFileSync(path.join(scriptsDir, 'build-mac-dmg.sh'), 'utf8');
  const manifest = buildSource.match(/for f in ([^;\n]+); do/);
  assert.ok(manifest, 'macOS build script must expose its staged script manifest');
  const stagedFiles = new Set(manifest[1].trim().split(/\s+/));
  const startupEnd = daemonSource.indexOf('const PROFILE = getProfile();');
  assert.ok(startupEnd > 0, 'daemon startup import boundary is missing');

  const pending = [{ file: 'daemon.js', source: daemonSource.slice(0, startupEnd) }];
  const visited = new Set();
  const optional = new Set(['package.json', 'plist-reader.js']);
  while (pending.length) {
    const current = pending.pop();
    if (visited.has(current.file)) continue;
    visited.add(current.file);
    for (const match of current.source.matchAll(/require\(['"](\.\/[^'"]+)['"]\)/g)) {
      const dependency = path.normalize(path.join(path.dirname(current.file), match[1]));
      const dependencyFile = path.extname(dependency) ? dependency : dependency + '.js';
      if (optional.has(dependencyFile)) continue;
      assert.equal(stagedFiles.has(dependencyFile), true,
        `macOS package omits startup dependency ${current.file} -> ${dependencyFile}`);
      if (dependencyFile.endsWith('.js')) {
        pending.push({
          file: dependencyFile,
          source: fs.readFileSync(path.join(scriptsDir, dependencyFile), 'utf8'),
        });
      }
    }
  }
});

test('macOS release synchronizes the optional internal picker without stale shell copies', () => {
  const buildSource = fs.readFileSync(path.join(scriptsDir, 'build-mac-dmg.sh'), 'utf8');
  assert.match(buildSource, /if \[ -f "scripts\/picker-internal\.js" \]; then/);
  assert.match(buildSource, /cp "scripts\/picker-internal\.js" "\$APP\/Contents\/Resources\/scripts\/picker-internal\.js"/);
  assert.match(buildSource, /rm -f "\$APP\/Contents\/Resources\/scripts\/picker-internal\.js"/);
});

test('WorkBuddy target configuration prefers explicit environment and fails closed', () => {
  const { readWorkBuddyTarget } = require('../scripts/workbuddy-target.js');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-target-'));
  try {
    assert.deepEqual(readWorkBuddyTarget({ dataDir, profileId: 'workbuddy-cn', env: {} }), {
      configured: false, binary: '', version: '', source: 'default',
    });

    fs.writeFileSync(path.join(dataDir, 'workbuddy-target.json'), JSON.stringify({
      profileId: 'workbuddy-cn', binary: 'D:\\Portable\\WorkBuddy.exe', version: '3.2.1',
    }));
    assert.deepEqual(readWorkBuddyTarget({ dataDir, profileId: 'workbuddy-cn', env: {} }), {
      configured: true, binary: 'D:\\Portable\\WorkBuddy.exe', version: '3.2.1', source: 'file',
    });
    assert.equal(readWorkBuddyTarget({ dataDir, profileId: 'workbuddy-ai', env: {} }).binary, '');

    const explicit = readWorkBuddyTarget({
      dataDir,
      profileId: 'workbuddy-cn',
      env: { WBSWITCH_WORKBUDDY_BIN: 'E:\\WorkBuddy\\WorkBuddy.exe', WBSWITCH_WORKBUDDY_VERSION: '4.0.0' },
    });
    assert.deepEqual(explicit, {
      configured: true, binary: 'E:\\WorkBuddy\\WorkBuddy.exe', version: '4.0.0', source: 'environment',
    });

    fs.writeFileSync(path.join(dataDir, 'workbuddy-target.json'), '{broken');
    assert.deepEqual(readWorkBuddyTarget({ dataDir, profileId: 'workbuddy-cn', env: {} }), {
      configured: true, binary: '', version: '', source: 'file',
    });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
