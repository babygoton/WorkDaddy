#!/usr/bin/env node
/**
 * WorkDaddy Windows 启动器（macOS launcher 的 Windows 对应物，node 实现）
 *
 * 幂等三步：
 *   1) 确保 daemon 运行 —— watchdog 常驻（崩溃自动拉起）；daemon 版本与内置不一致时强制重启
 *   2) WorkBuddy 已在 CDP 模式（9222）→ 直接注入组件即完成
 *   3) 否则退出 WorkBuddy 并以 --remote-debugging-port=9222 重启 → 等端口 → 注入
 *
 * 由 launcher.cmd 调用（cmd 负责兜底找 node），也可 node win-launcher.js 直接运行。
 * 所有操作用户态完成（HKCU / %LOCALAPPDATA% / %APPDATA%），无需管理员权限。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const SCRIPTS_DIR = __dirname;
const DATA_DIR =
  process.env.WBSWITCH_DATA_DIR ||
  path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'WorkDaddy');
const UI_PORT_BASE = parseInt(process.env.WBSWITCH_PORT || '47832', 10);
let actualUiPort = UI_PORT_BASE;
const cliCdpPort = process.argv.find((arg) => /^--cdp-port=\d+$/i.test(arg));
const CONFIGURED_CDP_PORT = parseInt(process.env.WBSWITCH_CDP_PORT || (cliCdpPort ? cliCdpPort.split('=')[1] : '') || '9222', 10);
let CDP_PORT = CONFIGURED_CDP_PORT;
const ELEVATED_HELPER_MODE = process.argv.includes('--inject-helper');
const LAUNCHER_LOCK_FILE = path.join(DATA_DIR, 'launcher.lock');

function log(...args) {
  const line = `[launcher] ${new Date().toISOString()} ${args.join(' ')}\n`;
  try { process.stdout.write(line); } catch (_) {}
  try { fs.appendFileSync(path.join(DATA_DIR, 'launcher.log'), line); } catch (_) {}
}

// ---------- 小工具 ----------
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function processCommandLine(pid) {
  if (!pid || pid === process.pid) return false;
  try {
    const r = spawnSync('powershell', [
      '-NoProfile', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" -ErrorAction SilentlyContinue).CommandLine`,
    ], {
      encoding: 'utf8', timeout: 5000, windowsHide: true,
    });
    return r.status === 0 ? String(r.stdout || '').trim() : '';
  } catch (_) { return ''; }
}

function processOwnsScript(pid, scriptPath) {
  const commandLine = processCommandLine(pid);
  return !!commandLine && commandLine.toLowerCase().includes(path.resolve(scriptPath).toLowerCase());
}

async function acquireLauncherLock(waitMs) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const deadline = Date.now() + Math.max(0, waitMs || 0);
  do {
    try {
      fs.writeFileSync(LAUNCHER_LOCK_FILE, JSON.stringify({
        pid: process.pid,
        role: ELEVATED_HELPER_MODE ? 'elevated-helper' : 'launcher',
        startedAt: new Date().toISOString(),
      }), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      let ownerPid = 0;
      try { ownerPid = Number(JSON.parse(fs.readFileSync(LAUNCHER_LOCK_FILE, 'utf8')).pid); } catch (_) {}
      if (!processOwnsScript(ownerPid, path.join(SCRIPTS_DIR, 'win-launcher.js'))) {
        try { fs.unlinkSync(LAUNCHER_LOCK_FILE); } catch (_) {}
        continue;
      }
      if (Date.now() >= deadline) return false;
      await sleep(200);
    }
  } while (Date.now() <= deadline);
  return false;
}

function releaseLauncherLock() {
  try {
    const owner = JSON.parse(fs.readFileSync(LAUNCHER_LOCK_FILE, 'utf8'));
    if (Number(owner.pid) === process.pid) fs.unlinkSync(LAUNCHER_LOCK_FILE);
  } catch (_) {}
}

// 当前进程是否为管理员（Windows）
function isElevated() {
  try {
    const r = spawnSync(
      'net', ['session'], { stdio: 'ignore', windowsHide: true, timeout: 8000 }
    );
    return r.status === 0;
  } catch (_) { return false; }
}

// 以管理员身份运行"重启注入助手"（child 脚本），launcher 本体保持普通权限。
// 返回是否已成功派发（派发后 launcher 立即退出，由助手完成真正的重启+注入）。
function spawnElevatedHelper() {
  const nodeBin = process.execPath;                 // 当前 node
  const childJs = path.join(SCRIPTS_DIR, 'win-inject-helper.js');
  if (!fs.existsSync(childJs)) return false;
  // 用 UTF-16LE 编码 PowerShell 命令，避免安装目录含中文时经过当前代码页导致路径乱码；
  // Node 参数顺序必须是「脚本路径 → 脚本参数」，否则 --inject-helper 会被 Node 当成自身选项。
  const childArg = '"' + childJs + '"';
  const command = [
    "$ErrorActionPreference = 'Stop'",
    'Start-Process -FilePath ' + psQuote(nodeBin) + ' ' +
      '-ArgumentList @(' + [psQuote(childArg), psQuote('--inject-helper'), psQuote(String(CDP_PORT))].join(', ') + ') ' +
      '-Verb RunAs -WindowStyle Hidden',
  ].join('; ');
  const encodedCommand = Buffer.from(command, 'utf16le').toString('base64');
  const ps = [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', encodedCommand,
  ];
  try {
    const r = spawnSync('powershell', ps, { stdio: 'ignore', windowsHide: true, timeout: 15000 });
    if (r.error || r.status !== 0) {
      log('提权助手派发失败: ' + (r.error ? r.error.message : 'powershell exit ' + r.status));
      return false;
    }
    return true;
  } catch (e) {
    log('提权助手派发异常: ' + e.message);
    return false;
  }
}

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    const t = setTimeout(() => { s.destroy(); resolve(false); }, 1200);
    s.on('connect', () => { clearTimeout(t); s.destroy(); resolve(true); });
    s.on('error', () => { clearTimeout(t); resolve(false); });
  });
}

function httpGet(port, p) {
  return new Promise((resolve) => {
    const token = readApiToken();
    const req = http.get({
      host: '127.0.0.1', port, path: p, timeout: 1500,
      headers: token ? { 'X-WorkDaddy-Token': token } : {},
    }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function httpPost(port, p) {
  return new Promise((resolve) => {
    const token = readApiToken();
    const req = http.request({
      host: '127.0.0.1', port, path: p, method: 'POST', timeout: 1500,
      headers: token ? { 'X-WorkDaddy-Token': token } : {},
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

function readApiToken() {
  try { return fs.readFileSync(path.join(DATA_DIR, 'api-token'), 'utf8').trim(); } catch (_) { return ''; }
}

async function isWorkBuddyCdpAt(port) {
  const version = await httpGet(port, '/json/version');
  if (!version || version.status !== 200) return false;
  try {
    const info = JSON.parse(version.body || '{}');
    return /workbuddyai|workbuddy|codebuddy/i.test([info.Browser, info['User-Agent']].filter(Boolean).join(' '));
  } catch (_) { return false; }
}

async function isWorkBuddyCdp() { return isWorkBuddyCdpAt(CDP_PORT); }

async function selectCdpPort() {
  const candidates = [...new Set([CONFIGURED_CDP_PORT, 9222, 9223, 9333])];
  for (const port of candidates) {
    if (await isWorkBuddyCdpAt(port)) return { port, existing: true };
  }
  for (const port of candidates) {
    if (!(await portOpen(port))) return { port, existing: false };
  }
  throw new Error('没有可用的 WorkBuddy CDP 端口（已检查 ' + candidates.join(', ') + '）');
}

function psOut(cmd) {
  try {
    return spawnSync('powershell', ['-NoProfile', '-Command', cmd], {
      encoding: 'utf8', timeout: 10000, windowsHide: true,
    }).stdout || '';
  } catch (_) { return ''; }
}

function readDaemonVersion() {
  try {
    const src = fs.readFileSync(path.join(SCRIPTS_DIR, 'daemon.js'), 'utf8');
    const m = src.match(/DAEMON_VERSION\s*=\s*'([^']+)'/);
    return m ? m[1] : '';
  } catch (_) { return ''; }
}

// ---------- 定位 node（WorkBuddyAI/legacy 托管运行时优先，其次 PATH） ----------
function findNode() {
  let verDirs = [];
  for (const homeName of ['.workbuddy-ai', '.workbuddy']) {
    const base = path.join(os.homedir(), homeName, 'binaries', 'node', 'versions');
    try {
      verDirs.push(...fs.readdirSync(base)
        .map((d) => path.join(base, d, 'node.exe'))
        .filter((p) => fs.existsSync(p)));
    } catch (_) {}
  }
  verDirs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (verDirs.length) return verDirs[verDirs.length - 1];
  try {
    const r = spawnSync('node', ['-v'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
    if (r.status === 0) return 'node';
  } catch (_) {}
  return null;
}

// ---------- 定位 WorkBuddy/WorkBuddyAI（环境变量 > 运行进程 > 注册表 > 常见路径） ----------
let wbBinaryCache = null;
function findWorkBuddy() {
  if (wbBinaryCache) return wbBinaryCache;
  const tryFile = (p) => { try { if (p && fs.existsSync(p)) return p; } catch (_) {} return null; };
  const envBin = tryFile(process.env.WBSWITCH_WORKBUDDY_BIN);
  if (envBin) return (wbBinaryCache = envBin);
  try {
    const p = psOut('Get-Process WorkBuddyAI,WorkBuddy -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path').split(/\r?\n/).filter(Boolean).pop();
    const hit = tryFile(p);
    if (hit) return (wbBinaryCache = hit);
  } catch (_) {}
  try {
    const p = psOut("$k=@('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'); Get-ItemProperty $k -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'WorkBuddy|CodeBuddy' } | Select-Object -First 1 DisplayIcon,InstallLocation | ForEach-Object { if($_.DisplayIcon){ ($_.DisplayIcon -replace ',.*$','').Trim() } elseif($_.InstallLocation){ $ai=Join-Path $_.InstallLocation 'WorkBuddyAI.exe'; $legacy=Join-Path $_.InstallLocation 'WorkBuddy.exe'; if(Test-Path $ai){$ai}else{$legacy} } }").split(/\r?\n/).filter(Boolean).pop();
    const hit = tryFile(p);
    if (hit) return (wbBinaryCache = hit);
  } catch (_) {}
  for (const c of [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'WorkBuddyAI', 'WorkBuddyAI.exe'),
    path.join(process.env.ProgramFiles || '', 'WorkBuddyAI', 'WorkBuddyAI.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'WorkBuddyAI', 'WorkBuddyAI.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'WorkBuddy', 'WorkBuddy.exe'),
    path.join(process.env.ProgramFiles || '', 'WorkBuddy', 'WorkBuddy.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'WorkBuddy', 'WorkBuddy.exe'),
    'D:\\workbody\\WorkBuddy\\WorkBuddy.exe',
  ]) {
    const hit = tryFile(c);
    if (hit) return (wbBinaryCache = hit);
  }
  return null;
}

// ---------- 1. 确保 daemon 运行 ----------
function watchdogAlive() {
  try {
    const pid = parseInt(fs.readFileSync(path.join(DATA_DIR, 'watchdog.pid'), 'utf8').trim(), 10);
    return !!pid && processOwnsScript(pid, path.join(SCRIPTS_DIR, 'watchdog.js'));
  } catch (_) { return false; }
}

async function findDaemonPort() {
  for (let port = UI_PORT_BASE; port < UI_PORT_BASE + 8; port++) {
    const health = await httpGet(port, '/healthz');
    if (health && health.status === 200) {
      try {
        const parsed = JSON.parse(health.body);
        if (parsed && parsed.ok === true && parsed.service === 'workdaddy') {
          actualUiPort = port;
          return { port, health: parsed };
        }
      } catch (_) {}
    }
    // 1.0.5 did not expose /healthz. Recognize its richer status payload only
    // for the upgrade path, then restart it into the authenticated API.
    const legacyStatus = await httpGet(port, '/api/status');
    if (legacyStatus && legacyStatus.status === 200) {
      try {
        const parsed = JSON.parse(legacyStatus.body);
        if (parsed && parsed.ok === true && typeof parsed.version === 'string' && parsed.cdp && parsed.dataDir) {
          actualUiPort = port;
          return { port, health: { ...parsed, service: 'workdaddy' } };
        }
      } catch (_) {}
    }
  }
  return null;
}

async function daemonRunning() {
  return !!(await findDaemonPort());
}

async function ensureDaemon(nodeBin, forceRestart) {
  fs.mkdirSync(path.join(DATA_DIR, 'accounts'), { recursive: true });
  // 已有 daemon：检查版本一致性（旧版本代码继续注入会出兼容问题）
  const found = await findDaemonPort();
  if (found) {
    const runningVer = found.health.version || '';
    const want = readDaemonVersion();
    if (!forceRestart && runningVer === want) {
      log('daemon 已在运行且版本一致 (' + runningVer + ', port=' + actualUiPort + ')，跳过启动');
      return true;
    }
    log('daemon 需要重启 (' + runningVer + ' -> ' + want + ', cdp=' + CDP_PORT + ')');
    stopDaemonByPort(actualUiPort);
  } else if (watchdogAlive()) {
    log('watchdog 在运行但 daemon 未就绪，等待其拉起...');
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      if (await daemonRunning()) { log('daemon 已就绪 (port=' + actualUiPort + ')'); return true; }
    }
    log('等待超时，主动拉起 watchdog');
  }
  // 启动 watchdog（它负责启动 daemon + 崩溃拉起）
  if (!watchdogAlive()) {
    log('启动 watchdog: ' + nodeBin);
    const child = spawn(nodeBin, [path.join(SCRIPTS_DIR, 'watchdog.js')], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  }
  for (let i = 0; i < 30; i++) {
    await sleep(400);
    if (await daemonRunning()) { log('daemon 已就绪 (port=' + actualUiPort + ')'); return true; }
  }
  log('等待 daemon 就绪超时');
  return await daemonRunning();
}

function stopDaemonByPort(port = actualUiPort) {
  // 杀 watchdog（会连带杀 daemon）→ 兜底按端口杀
  try {
    const pid = parseInt(fs.readFileSync(path.join(DATA_DIR, 'watchdog.pid'), 'utf8').trim(), 10);
    if (pid && processOwnsScript(pid, path.join(SCRIPTS_DIR, 'watchdog.js'))) {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    }
    try { fs.unlinkSync(path.join(DATA_DIR, 'watchdog.pid')); } catch (_) {}
  } catch (_) {}
  // 兜底：杀监听 UI 端口的进程
  const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8', timeout: 8000, windowsHide: true }).stdout || '';
  const lines = out.split(/\r?\n/).filter((l) => l.includes(':' + port) && /LISTENING/i.test(l));
  const pids = new Set();
  for (const l of lines) {
    const m = l.trim().split(/\s+/);
    const pid = m[m.length - 1];
    if (pid && /^\d+$/.test(pid)) pids.add(pid);
  }
  for (const pid of pids) {
    if (processOwnsScript(Number(pid), path.join(SCRIPTS_DIR, 'daemon.js'))) {
      spawnSync('taskkill', ['/F', '/T', '/PID', pid], { stdio: 'ignore', windowsHide: true });
    } else {
      log('拒绝结束端口 ' + port + ' 上的非 WorkDaddy 进程 pid=' + pid);
    }
  }
  return pids.size > 0;
}

// ---------- 2/3. WorkBuddy CDP 处理 ----------
function workBuddyRunning(wb) {
  const imageName = path.basename(wb || '') || 'WorkBuddy.exe';
  try {
    const r = spawnSync(
      'tasklist',
      ['/FI', 'IMAGENAME eq ' + imageName, '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', timeout: 5000, windowsHide: true }
    );
    return r.status === 0 && (r.stdout || '').toLowerCase().includes('"' + imageName.toLowerCase() + '"');
  } catch (_) {
    return true;
  }
}

function runTaskkill(args) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const p = spawn('taskkill', args, { stdio: 'ignore', windowsHide: true });
    p.on('error', (error) => finish({ code: null, error }));
    p.on('exit', (code, signal) => finish({ code, signal, error: null }));
    timer = setTimeout(() => finish({ code: null, error: new Error('taskkill 超时') }), 10000);
  });
}

async function waitForWorkBuddyExit(wb, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!workBuddyRunning(wb)) return true;
    await sleep(200);
  }
  return !workBuddyRunning(wb);
}

async function quitWorkBuddy(wb) {
  const imageName = path.basename(wb || '') || 'WorkBuddy.exe';
  if (!workBuddyRunning(wb)) return true;
  await runTaskkill(['/IM', imageName]);
  if (await waitForWorkBuddyExit(wb, 1800)) return true;
  await runTaskkill(['/F', '/T', '/IM', imageName]);
  if (await waitForWorkBuddyExit(wb, 4000)) return true;
  throw new Error('无法确认 WorkBuddy 已退出');
}

function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

/**
 * 从管理员 launcher 启动 WorkBuddy 时，不能直接 spawn 子进程：Electron/Chromium
 * 在部分 Windows 环境以高完整性令牌启动会出现白屏。通过 Explorer 的 ShellExecute
 * 让桌面 shell 以当前用户令牌创建 GUI 进程；普通权限 launcher 仍走同一条路径。
 */
function launchWorkBuddy(wb) {
  const args = '--remote-debugging-port=' + CDP_PORT;
  if (isElevated()) {
    const command = [
      '$shell = New-Object -ComObject Shell.Application',
      '$shell.ShellExecute(' + [
        psQuote(wb),
        psQuote(args),
        psQuote(path.dirname(wb)),
        "'open'",
        '1',
      ].join(', ') + ')',
    ].join('; ');
    const result = spawnSync(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { stdio: 'ignore', windowsHide: true, timeout: 15000 }
    );
    if (result.status === 0) {
      log('WorkBuddy 已通过 Explorer ShellExecute 以当前用户权限启动');
      return true;
    }
    log('ShellExecute 启动 WorkBuddy 失败，改用 explorer.exe 兜底 (code=' + result.status + ')');
    try {
      const shell = spawn('explorer.exe', [wb, args], { detached: true, stdio: 'ignore', windowsHide: true });
      shell.unref();
      return true;
    } catch (e) {
      log('explorer.exe 启动 WorkBuddy 失败: ' + e.message);
    }
  }

  const child = spawn(wb, [args], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', (e) => { log('启动 WorkBuddy 失败: ' + e.message); });
  child.unref();
  return true;
}

async function injectNow() {
  const result = await httpPost(actualUiPort, '/api/inject');
  return !!(result && result.status >= 200 && result.status < 300);
}

async function waitForInjection() {
  for (let i = 0; i < 12; i++) {
    if (await injectNow()) return true;
    await sleep(500);
  }
  return false;
}

function handoffToElevatedHelper() {
  if (!spawnElevatedHelper()) return false;
  // The elevated launcher waits for this owner to release the lock. Releasing
  // only after Start-Process succeeds closes the old UAC/lock race.
  releaseLauncherLock();
  log('已把启动流程交给管理员助手');
  return true;
}

// ---------- main ----------
(async () => {
  // 入口级 breadcrumb 必须先于 Node/PowerShell/进程探测写出，避免管理员启动时
  // 探测耗时让 Windows Terminal 看起来像“空白无响应”；同一行也会落到 launcher.log。
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
  log('启动入口: scripts=' + SCRIPTS_DIR + ' data=' + DATA_DIR + ' pid=' + process.pid);
  if (!(await acquireLauncherLock(ELEVATED_HELPER_MODE ? 10000 : 0))) {
    log('已有 launcher 实例在运行，本次启动跳过');
    process.exit(0);
  }
  process.on('exit', releaseLauncherLock);

  const nodeBin = findNode();
  if (!nodeBin) {
    log('未找到 Node.js（需 .workbuddy-ai/.workbuddy 托管 node 或 PATH 中的 node）');
    console.error('错误：未找到 Node.js。请先安装 Node.js 或安装 WorkBuddy（自带托管 node）。');
    process.exit(1);
  }

  const cdpSelection = await selectCdpPort();
  CDP_PORT = cdpSelection.port;
  process.env.WBSWITCH_CDP_PORT = String(CDP_PORT);
  log('CDP 端口: ' + CDP_PORT + (cdpSelection.existing ? '（已有 WorkBuddy）' : '（可用）'));

  // 提权助手接管时，先停掉普通权限启动的 watchdog/daemon，避免两个权限级别的
  // daemon 同时占用端口；WorkBuddy GUI 后续仍由 ShellExecute 以用户权限启动。
  if (ELEVATED_HELPER_MODE) {
    log('提权流程：接管普通权限 daemon');
    stopDaemonByPort();
    await sleep(800);
  }
  const daemonReady = await ensureDaemon(nodeBin, CDP_PORT !== CONFIGURED_CDP_PORT);
  if (!daemonReady) {
    console.error('WorkDaddy daemon 启动失败。日志：' + path.join(DATA_DIR, 'launcher.log'));
    process.exit(5);
  }

  // 已在 CDP 模式 → 幂等注入
  if (await isWorkBuddyCdp()) {
    if (!(await waitForInjection())) {
      log('WorkBuddy 已在调试模式，但 /api/inject 调用失败');
      process.exit(6);
    }
    log('WorkBuddy 已在调试模式（端口 ' + CDP_PORT + '），组件已注入');
    console.log('WorkDaddy：WorkBuddy 已在调试模式，组件已注入 ✓');
    process.exit(0);
  }

  // 未开 CDP → 需要重启 WorkBuddy 带调试端口
  const wb = findWorkBuddy();
  if (!wb) {
    console.error('未找到 WorkBuddy/WorkBuddyAI 可执行文件。可用环境变量 WBSWITCH_WORKBUDDY_BIN 指定完整路径。');
    log('未找到 WorkBuddy/WorkBuddyAI 可执行文件');
    process.exit(2);
  }

  log('重启 WorkBuddy（带 --remote-debugging-port=' + CDP_PORT + '，GUI 使用当前用户权限）: ' + wb);
  console.log('正在以调试模式重启 WorkBuddy（约几秒）...');

  try {
    await quitWorkBuddy(wb);
  } catch (e) {
    log('普通权限退出 WorkBuddy 失败: ' + e.message);
    if (!isElevated() && !ELEVATED_HELPER_MODE && handoffToElevatedHelper()) process.exit(0);
    throw e;
  }
  await sleep(500);
  launchWorkBuddy(wb);

  let ok = false;
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    if (await isWorkBuddyCdp()) { ok = true; break; }
  }
  if (ok) {
    await sleep(1500);
    if (!(await waitForInjection())) {
      log('WorkBuddy CDP 已启动，但 /api/inject 调用失败');
      process.exit(6);
    }
    log('WorkBuddy 已启动（调试模式），组件已注入');
    console.log('WorkDaddy：WorkBuddy 已启动（调试模式），组件已注入 ✓');
    process.exit(0);
  }

  log('等待 20 秒未检测到 WorkBuddy CDP 端口 ' + CDP_PORT);
  if (!isElevated() && !ELEVATED_HELPER_MODE && handoffToElevatedHelper()) process.exit(0);
  console.log('等待超时：未检测到 WorkBuddy CDP 端口 ' + CDP_PORT + '。可手动执行：cd /d ' + path.dirname(wb) + ' && "' + wb + '" --remote-debugging-port=' + CDP_PORT);
  process.exit(3);
})().catch((e) => {
  log('launcher 异常: ' + (e && e.stack || e));
  console.error('WorkDaddy 启动异常: ' + (e && e.message || e));
  process.exit(4);
});
