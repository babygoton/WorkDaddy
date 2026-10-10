'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * 判定锁文件里记录的 PID 是否真的是「本 profile 的 WorkDaddy 守护进程」。
 *
 * 背景（issue #128）：旧实现只做 `process.kill(pid, 0)` 存在性探测。更新流程杀掉旧
 * daemon 后锁文件未被清理，PID 一旦被系统复用给无关进程，探测仍返回「进程存在」，
 * 新 daemon 便误判「已有 daemon 运行」并退出，形成约 10 秒一次的死循环——端口无人
 * 监听、面板按钮消失，用户只能手工删锁恢复。
 *
 * Windows 分支早已用 isCurrentWindowsDaemonProcess() 做「可执行路径 + 命令行」校验，
 * POSIX 分支却一直停留在裸存在性探测，这里补齐同一层校验。可移植的取证方式：
 *   - Linux：读 /proc/<pid>/cmdline（hidepid=2 下同 UID 进程仍可见）；
 *   - macOS：`ps -ww -o command= -p <pid>`（-ww 关闭宽度截断，否则长路径会被截掉）。
 *
 * 返回值语义（与 Windows 分支对齐）：
 *   true  —— 已证实是本 daemon，或无法取证但必须保守保留锁（权限不足、ps 不可用等）。
 *   false —— 已证实该 PID 不是本 daemon（进程已不存在，或已被无关进程复用）。
 *
 * 注意：保守方向是「保留锁」。误留一个陈旧锁只会让 daemon 起不来，而误删一个仍有
 * 效的锁会让两个 daemon 同时操作同一份账号数据——后者代价更高。
 */

/** 进程存在性探测：存在（含无权限信号）返回 true，确定不存在返回 false。 */
function probeProcessExistence(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM 说明进程存在，只是当前身份无权向它发信号。
    return !!(error && error.code === 'EPERM');
  }
}

function resolvePathSafe(target) {
  try {
    return fs.realpathSync(target);
  } catch (_) {
    return path.resolve(target);
  }
}

/**
 * Linux：读 /proc/<pid>/cmdline。
 * @returns {{state: 'ok', argv: string[]}|{state: 'absent'}|{state: 'unknown'}}
 */
function readLinuxArgv(pid, procRoot) {
  const procDir = path.join(procRoot, String(pid));
  try {
    if (!fs.existsSync(procDir)) return { state: 'absent' };
  } catch (_) {
    return { state: 'unknown' };
  }
  try {
    const raw = fs.readFileSync(path.join(procDir, 'cmdline'), 'utf8');
    return { state: 'ok', argv: raw.split('\0').filter((arg) => arg.length > 0) };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { state: 'absent' };
    return { state: 'unknown' };
  }
}

function defaultRunPs(pid) {
  return spawnSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
}

/**
 * macOS：用 ps 取完整命令行。
 * @returns {{state: 'ok', command: string}|{state: 'absent'}|{state: 'unknown'}}
 */
function readDarwinCommand(pid, runPs) {
  let result;
  try {
    result = runPs(pid);
  } catch (_) {
    return { state: 'unknown' };
  }
  if (!result || typeof result !== 'object' || result.error) return { state: 'unknown' };
  const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : '';
  // ps 对不存在的 PID 静默退出 1，无输出。
  if (stdout === '') return result.status === 1 ? { state: 'absent' } : { state: 'unknown' };
  if (result.status !== 0) return { state: 'unknown' };
  return { state: 'ok', command: stdout };
}

/** argv 中是否存在指向 daemon 脚本的项。 */
function argvMatchesDaemon(argv, scriptPath) {
  const canonical = resolvePathSafe(scriptPath);
  const expectedName = path.basename(scriptPath);
  for (const arg of argv) {
    if (!arg) continue;
    if (arg === scriptPath || resolvePathSafe(arg) === canonical) return true;
  }
  // 安装目录变化（移动 app、换安装路径）时路径不再逐字相等，但脚本名仍一致。
  // 宁可认作本 daemon 而保留锁，也不要误删活锁导致两个 daemon 同时写账号数据。
  return argv.some((arg) => path.basename(arg) === expectedName);
}

/** 命令行字符串是否指向 daemon 脚本（macOS 路径可能带空格，用子串匹配）。 */
function commandMatchesDaemon(command, scriptPath) {
  if (command.includes(scriptPath) || command.includes(resolvePathSafe(scriptPath))) return true;
  const expectedName = path.basename(scriptPath);
  return command.split(/\s+/).some((token) => path.basename(token) === expectedName);
}

function isVerifiedDaemonLockOwner(pid, options = {}) {
  const {
    platform = process.platform,
    scriptPath = path.join(__dirname, 'daemon.js'),
    procRoot = '/proc',
    runPs = defaultRunPs,
  } = options;

  // 锁文件缺 PID / 内容损坏：与 Windows 分支一致，按陈旧锁处理。
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;

  if (platform === 'linux') {
    const read = readLinuxArgv(pid, procRoot);
    if (read.state === 'absent') return false;
    if (read.state === 'ok') return argvMatchesDaemon(read.argv, scriptPath);
    return probeProcessExistence(pid);
  }

  if (platform === 'darwin') {
    const read = readDarwinCommand(pid, runPs);
    if (read.state === 'absent') return false;
    if (read.state === 'ok') return commandMatchesDaemon(read.command, scriptPath);
    return probeProcessExistence(pid);
  }

  // 其余平台没有可靠的命令行取证手段：只能沿用存在性探测。
  return probeProcessExistence(pid);
}

module.exports = { isVerifiedDaemonLockOwner };
