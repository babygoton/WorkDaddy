'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { isVerifiedDaemonLockOwner } = require('../scripts/daemon-lock-owner.js');

const SCRIPT_PATH = '/opt/workdaddy/scripts/daemon.js';
const NODE_PATH = '/usr/local/bin/node';

/** 造一个假的 /proc 根，只放一个 <pid>/cmdline。 */
function makeProcRoot(pid, argv) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-lock-test-'));
  const procDir = path.join(root, String(pid));
  fs.mkdirSync(procDir);
  fs.writeFileSync(path.join(procDir, 'cmdline'), argv.map((a) => `${a}\0`).join(''));
  return root;
}

function withProcRoot(pid, argv, fn) {
  const root = makeProcRoot(pid, argv);
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('Linux：真实 daemon 进程被确认为锁持有者', () => {
  withProcRoot(4242, [NODE_PATH, SCRIPT_PATH], (procRoot) => {
    assert.equal(isVerifiedDaemonLockOwner(4242, { platform: 'linux', scriptPath: SCRIPT_PATH, procRoot }), true);
  });
});

test('Linux：PID 被无关进程复用时不认作 daemon（issue #128 回归）', () => {
  // 旧实现只做 process.kill(pid, 0)：只要 PID 存在就判定「已有 daemon 运行」，
  // 于是新 daemon 永久退出。这里模拟 PID 被系统复用给一个无关进程。
  withProcRoot(1211, ['/usr/sbin/AudioConverterHardenedService'], (procRoot) => {
    assert.equal(isVerifiedDaemonLockOwner(1211, { platform: 'linux', scriptPath: SCRIPT_PATH, procRoot }), false);
  });
});

test('Linux：daemon 脚本路径不匹配时判为陈旧锁', () => {
  withProcRoot(4242, [NODE_PATH, '/opt/workdaddy/scripts/other.js'], (procRoot) => {
    assert.equal(isVerifiedDaemonLockOwner(4242, { platform: 'linux', scriptPath: SCRIPT_PATH, procRoot }), false);
  });
});

test('Linux：进程已不存在时判为陈旧锁', () => {
  withProcRoot(4242, [NODE_PATH, SCRIPT_PATH], (procRoot) => {
    assert.equal(isVerifiedDaemonLockOwner(9999, { platform: 'linux', scriptPath: SCRIPT_PATH, procRoot }), false);
  });
});

test('Linux：路径等价写法（含 .. 归一）仍认作本 daemon', () => {
  const messy = '/opt/workdaddy/scripts/../scripts/daemon.js';
  withProcRoot(4242, [NODE_PATH, messy], (procRoot) => {
    assert.equal(isVerifiedDaemonLockOwner(4242, { platform: 'linux', scriptPath: SCRIPT_PATH, procRoot }), true);
  });
});

test('Linux：安装目录变化但脚本名仍是 daemon.js 时保留锁', () => {
  // 移动/重装 app 后旧 daemon 仍在跑：路径不再相等，但绝不能误判成无关进程而删锁，
  // 否则会同时跑起两个 daemon 写同一份账号数据。
  withProcRoot(4242, [NODE_PATH, '/opt/workdaddy-old/scripts/daemon.js'], (procRoot) => {
    assert.equal(isVerifiedDaemonLockOwner(4242, { platform: 'linux', scriptPath: SCRIPT_PATH, procRoot }), true);
  });
});

test('Linux：cmdline 无法读取时保守保留锁', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-lock-test-'));
  const procDir = path.join(root, String(process.pid));
  fs.mkdirSync(procDir);
  // 目录而非文件：readFileSync 抛 EISDIR/EPERM → 取证失败。用当前进程 PID 保证「进程存在」。
  fs.mkdirSync(path.join(procDir, 'cmdline'));
  try {
    assert.equal(
      isVerifiedDaemonLockOwner(process.pid, { platform: 'linux', scriptPath: SCRIPT_PATH, procRoot: root }),
      true,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('macOS：ps 返回本 daemon 命令行时确认为锁持有者', () => {
  const runPs = () => ({ status: 0, stdout: `${NODE_PATH} ${SCRIPT_PATH}\n`, error: undefined });
  assert.equal(isVerifiedDaemonLockOwner(4242, { platform: 'darwin', scriptPath: SCRIPT_PATH, runPs }), true);
});

test('macOS：PID 被无关进程复用时不认作 daemon（issue #128 回归）', () => {
  const runPs = () => ({ status: 0, stdout: '/usr/sbin/AudioConverterHardenedService\n', error: undefined });
  assert.equal(isVerifiedDaemonLockOwner(1211, { platform: 'darwin', scriptPath: SCRIPT_PATH, runPs }), false);
});

test('macOS：ps 退出 1 且无输出表示进程已消失', () => {
  const runPs = () => ({ status: 1, stdout: '', error: undefined });
  assert.equal(isVerifiedDaemonLockOwner(4242, { platform: 'darwin', scriptPath: SCRIPT_PATH, runPs }), false);
});

test('macOS：ps 本身失败时保守保留锁', () => {
  const runPs = () => ({ status: null, stdout: '', error: new Error('spawn ps ENOENT') });
  assert.equal(
    isVerifiedDaemonLockOwner(process.pid, { platform: 'darwin', scriptPath: SCRIPT_PATH, runPs }),
    true,
  );
});

test('macOS：带空格的应用路径也能匹配（-ww 关闭截断后）', () => {
  const spaced = '/Applications/WorkDaddy AI.app/Contents/Resources/scripts/daemon.js';
  const runPs = () => ({ status: 0, stdout: `/Applications/WorkDaddy AI.app/Contents/Resources/node ${spaced}\n`, error: undefined });
  assert.equal(isVerifiedDaemonLockOwner(4242, { platform: 'darwin', scriptPath: spaced, runPs }), true);
});

test('macOS：安装目录变化但脚本名仍是 daemon.js 时保留锁', () => {
  const runPs = () => ({ status: 0, stdout: '/Applications/WorkDaddy Old.app/Contents/Resources/node /Applications/WorkDaddy Old.app/Contents/Resources/scripts/daemon.js\n', error: undefined });
  assert.equal(isVerifiedDaemonLockOwner(4242, { platform: 'darwin', scriptPath: SCRIPT_PATH, runPs }), true);
});

test('其余平台无取证手段时回退到存在性探测', () => {
  assert.equal(
    isVerifiedDaemonLockOwner(process.pid, { platform: 'freebsd', scriptPath: SCRIPT_PATH }),
    true,
  );
  assert.equal(isVerifiedDaemonLockOwner(99999999, { platform: 'freebsd', scriptPath: SCRIPT_PATH }), false);
});

test('锁文件 PID 非法时按陈旧锁处理', () => {
  for (const bad of [0, -1, NaN, undefined, null, '4242', 1.5]) {
    assert.equal(
      isVerifiedDaemonLockOwner(bad, { platform: 'linux', scriptPath: SCRIPT_PATH, procRoot: '/proc' }),
      false,
      `pid=${String(bad)} 应判为陈旧锁`,
    );
  }
});
