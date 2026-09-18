'use strict';

const fs = require('node:fs');
const path = require('node:path');

function isVerifiedLinuxDaemonProcess(pid, { nodePath, scriptPath, profile, dataDir, uid, procRoot = '/proc' } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !nodePath || !scriptPath || !profile || !dataDir || !Number.isInteger(uid)) {
    return false;
  }
  try {
    const proc = path.join(procRoot, String(pid));
    const status = fs.readFileSync(path.join(proc, 'status'), 'utf8');
    const match = status.match(/^Uid:\s*(\d+)\s+(\d+)\s+/m);
    if (!match || Number(match[1]) !== uid || Number(match[2]) !== uid) return false;
    if (fs.realpathSync(path.join(proc, 'exe')) !== fs.realpathSync(nodePath)) return false;
    const args = fs.readFileSync(path.join(proc, 'cmdline'), 'utf8').split('\0').filter(Boolean);
    if (args.length !== 2 || path.resolve(args[1]) !== path.resolve(scriptPath)) return false;
    const environment = fs.readFileSync(path.join(proc, 'environ'), 'utf8').split('\0');
    return environment.includes(`WBSWITCH_PROFILE=${profile}`) &&
      environment.includes(`WBSWITCH_DATA_DIR=${dataDir}`);
  } catch (_) {
    return false;
  }
}

function startTime(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  return fields[19] || '';
}

async function stopVerifiedLinuxDaemonProcess(pid, options) {
  if (!isVerifiedLinuxDaemonProcess(pid, options)) throw new Error('旧守护进程身份无法验证，请手动确认并停止后重试');
  const started = startTime(pid);
  if (!started) throw new Error('无法确认旧守护进程启动时间');
  process.kill(pid, 'SIGTERM');
  for (let attempt = 0; attempt < 15; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (!fs.existsSync(`/proc/${pid}`)) return;
  }
  if (!isVerifiedLinuxDaemonProcess(pid, options) || startTime(pid) !== started) {
    throw new Error('旧守护进程身份已变化，拒绝强制停止');
  }
  process.kill(pid, 'SIGKILL');
  for (let attempt = 0; attempt < 15; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (!fs.existsSync(`/proc/${pid}`)) return;
  }
  throw new Error('旧守护进程未退出，请手动处理');
}

if (require.main === module && process.argv[2] === '--stop') {
  const pid = Number(process.argv[3]);
  stopVerifiedLinuxDaemonProcess(pid, {
    nodePath: process.argv[4],
    scriptPath: process.argv[5],
    profile: process.argv[6],
    dataDir: process.argv[7],
    uid: process.getuid(),
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { isVerifiedLinuxDaemonProcess, stopVerifiedLinuxDaemonProcess };
