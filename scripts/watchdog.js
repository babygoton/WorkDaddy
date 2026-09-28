#!/usr/bin/env node
/**
 * WorkDaddy Windows watchdog.
 *
 * The loopback lock belongs to the OS and disappears automatically when this
 * process exits. watchdog.pid is only a hint for the native install helper;
 * it is never trusted on its own for process termination.
 */
'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { getProfile, profileDataDir } = require('./profiles.js');

const PROFILE_ID = process.env.WBSWITCH_PROFILE || 'workbuddy-cn';
const PROFILE = getProfile(PROFILE_ID);
const DATA_DIR = process.env.WBSWITCH_DATA_DIR || profileDataDir(PROFILE);
const PID_FILE = path.join(DATA_DIR, 'watchdog.pid');
const LOG_FILE = path.join(DATA_DIR, 'watchdog.log');
const DAEMON_FILE = path.join(__dirname, 'daemon.js');
const LOCK_PORT = ({'workbuddy-cn':47932,'workbuddy-ai':47933,'codebuddy-cn':47934,'codebuddy-intl':47935})[PROFILE.id];

let child = null;
let stopping = false;
let restartDelay = 3000;

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch (_) {}
  try { process.stdout.write(line); } catch (_) {}
}

function writePidFile() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temporary = PID_FILE + '.tmp.' + process.pid;
  fs.writeFileSync(temporary, String(process.pid), 'utf8');
  try {
    fs.renameSync(temporary, PID_FILE);
  } catch (_) {
    try { fs.unlinkSync(PID_FILE); } catch (_) {}
    fs.renameSync(temporary, PID_FILE);
  }
}

function removePidFile() {
  try {
    if (Number(fs.readFileSync(PID_FILE, 'utf8').trim()) === process.pid) fs.unlinkSync(PID_FILE);
  } catch (_) {}
}

function startDaemon() {
  if (stopping) return;
  const args = ['--experimental-sqlite', DAEMON_FILE];
  log('启动 daemon: ' + process.execPath + ' ' + args.join(' '));
  child = spawn(process.execPath, args, { stdio: 'ignore', windowsHide: true, env: process.env });
  child.on('error', (error) => log('daemon 启动错误: ' + error.message));
  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) {
      log('daemon 已退出（watchdog 停止中）');
      return;
    }
    const delay = restartDelay;
    log('daemon 退出 code=' + code + ' signal=' + signal + '，' + delay + 'ms 后重启');
    setTimeout(startDaemon, delay);
    restartDelay = Math.min(restartDelay * 2, 60000);
  });
  setTimeout(() => { restartDelay = 3000; }, 60000);
}

function shutdown() {
  if (stopping) return;
  stopping = true;
  log('watchdog 收到停止信号，结束 daemon');
  if (child) {
    try { child.kill(); } catch (_) {}
  }
  setTimeout(() => {
    removePidFile();
    try { lockServer.close(); } catch (_) {}
    process.exit(0);
  }, 800);
}

const lockServer = net.createServer();
lockServer.unref();
lockServer.once('error', (error) => {
  if (error && error.code === 'EADDRINUSE') {
    log('当前 profile 的 watchdog 已在运行，本实例退出');
    process.exit(0);
  }
  throw error;
});
lockServer.listen({ host: '127.0.0.1', port: LOCK_PORT, exclusive: true }, () => {
  writePidFile();
  log('watchdog 已获取回环单实例锁 port=' + LOCK_PORT + ' pid=' + process.pid);
  startDaemon();
});

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('exit', removePidFile);
