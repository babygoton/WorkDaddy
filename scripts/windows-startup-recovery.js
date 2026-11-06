'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Only sample metadata of the selected installation; never read application or
// account contents, search other installations, or infer updates from age alone.
function readWorkBuddyInstallation(binary) {
  const root = path.dirname(binary);
  const files = [binary, path.join(root, 'resources', 'app.asar'),
    path.join(root, 'resources', 'app', 'package.json'), path.join(root, 'chrome_elf.dll'),
    path.join(root, 'icudtl.dat')];
  const stamps = files.map(file => {
    try {
      const stat = fs.statSync(file);
      return stat.isFile() ? [stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino] : null;
    } catch (_) { return null; }
  });
  return { signature: JSON.stringify(stamps), ready: !!(stamps[0] && (stamps[1] || stamps[2])) };
}

async function waitForStableWorkBuddyInstallation(binary, deadline, options = {}) {
  const now = options.now || Date.now;
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const read = options.read || readWorkBuddyInstallation;
  let previous = null, stableSince = now();
  while (now() < deadline) {
    const current = read(binary);
    if (!current.ready || !previous || !previous.ready || current.signature !== previous.signature) stableSince = now();
    if (current.ready && now() - stableSince >= 3000) return;
    previous = current;
    await sleep(Math.min(1000, deadline - now()));
  }
  const error = new Error('WorkBuddy 安装文件仍在变化或尚不完整，请等待官方更新完成后重试');
  error.exitCode = 15;
  throw error;
}

module.exports = { readWorkBuddyInstallation, waitForStableWorkBuddyInstallation };
