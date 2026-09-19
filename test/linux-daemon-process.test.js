'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { isVerifiedLinuxDaemonProcess } = require('../scripts/linux-daemon-process.js');

test('both Linux launchers delegate daemon termination to the verified process boundary', () => {
  for (const name of ['install-linux.sh', 'relaunch-with-cdp-linux.sh']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', name), 'utf8');
    assert.match(source, /linux-daemon-process\.js" --stop/);
    assert.doesNotMatch(source, /kill -9 "\$(?:pid|OLD_PID)"/);
  }
});

test('Linux installer only stops its exact same-user daemon', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-proc-test-'));
  const pid = 12345;
  const nodePath = process.execPath;
  const scriptPath = path.join(root, 'scripts', 'daemon.js');
  const dataDir = path.join(root, 'profile');
  const proc = path.join(root, String(pid));
  fs.mkdirSync(proc);
  fs.symlinkSync(nodePath, path.join(proc, 'exe'));
  const write = (name, value) => fs.writeFileSync(path.join(proc, name), value);
  const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
  const options = { nodePath, scriptPath, dataDir, profile: 'workbuddy-ai', uid, procRoot: root };
  try {
    write('status', `Name:\tnode\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
    write('cmdline', `${nodePath}\0${scriptPath}\0`);
    write('environ', `WBSWITCH_PROFILE=workbuddy-ai\0WBSWITCH_DATA_DIR=${dataDir}\0`);
    assert.equal(isVerifiedLinuxDaemonProcess(pid, options), true);
    assert.equal(isVerifiedLinuxDaemonProcess(pid, { ...options, profile: 'workbuddy-cn' }), false);
    assert.equal(isVerifiedLinuxDaemonProcess(pid, { ...options, nodePath: scriptPath }), false);
    assert.equal(isVerifiedLinuxDaemonProcess(pid, { ...options, scriptPath: '/tmp/other-daemon.js' }), false);
    write('status', `Uid:\t${uid}\t${uid + 1}\t${uid}\t${uid}\n`);
    assert.equal(isVerifiedLinuxDaemonProcess(pid, options), false);
    write('status', `Uid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
    write('cmdline', `${nodePath}\0${scriptPath}\0--unexpected\0`);
    assert.equal(isVerifiedLinuxDaemonProcess(pid, options), false);
    assert.equal(isVerifiedLinuxDaemonProcess(0, options), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
