#!/usr/bin/env node
/**
 * WorkDaddy Windows 启动器（macOS launcher 的 Windows 对应物，node 实现）
 *
 * 冷启动流程：
 *   1) 确保 daemon 运行 —— watchdog 常驻（崩溃自动拉起）；daemon 版本与内置不一致时强制重启
 *   2) 若当前 profile 的 WorkBuddy 已在运行但没有 CDP，先按已验证 PID 重启
 *   3) 以自动选择的 CDP 端口启动 → 等端口 → 注入
 *
 * 由 launcher.cmd 调用（cmd 负责兜底找 node），也可 node win-launcher.js 直接运行。
 * 默认按普通用户运行；用户明确以管理员身份启动时，先通过桌面 Shell
 * 重启为标准权限。若无法确认已降权，则 fail closed 并提示用户。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const {
  assertAuthenticatedDaemonCapability,
  assertDaemonServiceIdentity,
  assertDaemonTerminationIdentity,
  assertSameProcessIdentity,
  detectWindowsPrivilege,
  assertVerifiedNodeProcess,
  buildNativeProcessQuery,
  filterVerifiedNodeProcesses,
  filterVerifiedWindowsProcesses,
  parseCimProcessResult,
  resolveWindowsExecutable,
  sameWindowsPath,
  selectRunningProfileBinary,
  selectPreferredDiscoveredBinary,
} = require('./windows-process-boundary.js');
let WINDOWS_PRIVILEGE = 'standard';
if (process.platform === 'win32' && process.env.WBSWITCH_NATIVE_LAUNCHER !== '1') {
  try {
    WINDOWS_PRIVILEGE = detectWindowsPrivilege();
  } catch (error) {
    console.error(error.message);
    process.exit(5);
  }
}
const { captureMessage, captureException } = require('./sentry-report.js');
const { getProfile, profileDataDir } = require('./profiles.js');
const { isTargetForProfile } = require('./cdp-targets.js');
const { replaceFileWithRetry } = require('./atomic-file-write.js');
const { parseUiPortState, profileUiPortCandidates } = require('./ui-port.js');

const SCRIPTS_DIR = __dirname;
const WORKDADDY_APP_DIR = path.resolve(SCRIPTS_DIR, '..');
process.env.WBSWITCH_APP_DIR = WORKDADDY_APP_DIR;
const HOST = '127.0.0.1';
const PROFILE_ID = process.env.WBSWITCH_PROFILE || 'workbuddy-cn';
if (!process.env.WBSWITCH_PROFILE) process.env.WBSWITCH_PROFILE = PROFILE_ID;
const PROFILE = getProfile(PROFILE_ID);
const WBS_BRAND = PROFILE.appName || 'WorkDaddy'; // 品牌显示名跟随 profile（WorkDaddy AI / WorkDaddy）
const DATA_DIR =
  process.env.WBSWITCH_DATA_DIR ||
  profileDataDir(PROFILE);
const API_TOKEN_FILE = path.join(DATA_DIR, '.api-token');
const DESKTOP_RELAUNCH_ARG = '--desktop-shell-relaunch';
const DEFAULT_UI_PORT = { 'workbuddy-cn': 47832, 'workbuddy-ai': 47833, 'codebuddy-cn': 47834, 'codebuddy-intl': 47835 }[PROFILE.id] || 47832;
const REQUESTED_UI_PORT = parseInt(process.env.WBSWITCH_PORT || String(DEFAULT_UI_PORT), 10);
let UI_PORT = REQUESTED_UI_PORT;
// Make the profile's initial UI port available to every child process immediately.
// configureUiPort() may replace it with a persisted fallback later.
process.env.WBSWITCH_PORT = String(UI_PORT);
const UI_PORT_FILE = path.join(DATA_DIR, 'ui-port.json');
const PROFILE_CDP_PORTS = {
  'workbuddy-cn': [9222, 9226, 9227, 9228, 9229, 9230, 9231, 9232],
  'workbuddy-ai': [9223, 9233, 9234, 9235, 9236, 9237, 9238, 9239],
  'codebuddy-cn': [9224],
  'codebuddy-intl': [9225],
};
const DEFAULT_CDP_PORT = Number(PROFILE.cdp && PROFILE.cdp.port) || (PROFILE_CDP_PORTS[PROFILE.id] || [9222])[0];
const cliCdpPort = process.argv.find((arg) => /^--cdp-port=\d+$/i.test(arg));
const HAS_EXPLICIT_CDP_PORT = Boolean(process.env.WBSWITCH_CDP_PORT || cliCdpPort);
let CDP_PORT = parseInt(process.env.WBSWITCH_CDP_PORT || (cliCdpPort ? cliCdpPort.split('=')[1] : '') || String(DEFAULT_CDP_PORT), 10);
process.env.WBSWITCH_CDP_PORT = String(CDP_PORT);
const CDP_PORT_FILE = path.join(DATA_DIR, 'cdp-port.json');
// 便携版/低速磁盘上的 WorkBuddy 首次启动可能超过 20 秒；超时只应在足够长的窗口后报告。
const CDP_STARTUP_TIMEOUT_MS = 60000;
// Electron/ShellExecute 冷启动可能超过 5 秒；过早换端口会让首个实例与重试实例发生单实例冲突。
const CDP_PORT_RETRY_GRACE_MS = 15000;
const INJECT_REQUEST_TIMEOUT_MS = 5000;
const INJECT_MAX_ATTEMPTS = 6;
const INJECT_RETRY_DELAY_MS = 1000;
// 每个 profile 只查询自己的主程序镜像；其他 CodeBuddy/WorkBuddy profile 不参与退出判定。
const PROFILE_BINARY_NAME_LIST = PROFILE.binaryNames || (PROFILE.id === 'workbuddy-ai' ? ['workbuddyai.exe'] :
  PROFILE.id === 'workbuddy-cn' ? ['workbuddy.exe'] : ['codebuddy.exe']);
const PROFILE_PROCESS_NAMES = new Set(PROFILE_BINARY_NAME_LIST.map((name) => String(name).toLowerCase()));
const PROFILE_BINARY_NAMES = new Set(PROFILE_BINARY_NAME_LIST.map((name) => String(name).toLowerCase()));

function log(...args) {
  const line = `[launcher] ${new Date().toISOString()} [client=${PROFILE.name}] [profile=${PROFILE.id}] ${args.join(' ')}\n`;
  try { process.stdout.write(line); } catch (_) {}
  try { fs.appendFileSync(path.join(DATA_DIR, 'launcher.log'), line); } catch (_) {}
}

// ---------- 小工具 ----------
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function readApiToken() {
  try {
    const token = fs.readFileSync(API_TOKEN_FILE, 'utf8').trim();
    return /^[a-f0-9]{64}$/i.test(token) ? token : '';
  } catch (_) { return ''; }
}

function localApiHeaders() {
  const token = readApiToken();
  return token ? { 'X-WorkDaddy-Token': token } : {};
}

function readUiPortFile() {
  try { return parseUiPortState(fs.readFileSync(UI_PORT_FILE, 'utf8'), PROFILE.id); } catch (_) { return null; }
}

function writeUiPortFile(port) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  replaceFileWithRetry(UI_PORT_FILE, JSON.stringify({
    profileId: PROFILE.id,
    port,
    updatedAt: new Date().toISOString(),
  }) + '\n', 0o600);
}

function useUiPort(port) {
  UI_PORT = port;
  process.env.WBSWITCH_PORT = String(port);
  writeUiPortFile(port);
  return port;
}

async function configureUiPort() {
  const candidates = profileUiPortCandidates(PROFILE.id, {
    preferredPort: REQUESTED_UI_PORT,
    persistedPort: readUiPortFile(),
  });
  for (const port of candidates) {
    const response = await httpGet(port, '/api/status', localApiHeaders());
    if (!response || response.status !== 200) continue;
    let status;
    try { status = JSON.parse(response.body); } catch (_) { continue; }
    if (status && status.profile && status.profile.id === PROFILE.id &&
        status.dataDir && sameWindowsPath(status.dataDir, DATA_DIR)) {
      log('发现当前 profile daemon UI 端口: ' + port);
      return useUiPort(port);
    }
  }
  for (const port of candidates) {
    if (await isLocalPortAvailable(port)) {
      log((port === DEFAULT_UI_PORT ? '选择默认' : '选择备用') + ' daemon UI 端口: ' + port);
      return useUiPort(port);
    }
  }
  throw new Error('当前 profile 的 daemon UI 端口均不可绑定。请关闭占用端口的软件或 WSL2/Hyper-V 后重试');
}

function relaunchWithDesktopShell(nodeBin) {
  const helper = path.join(SCRIPTS_DIR, 'windows-relaunch-standard.ps1');
  if (!fs.existsSync(helper)) throw new Error('缺少标准权限重启脚本 windows-relaunch-standard.ps1');
  const powershell = path.join(
    process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
  );
  const result = spawnSync(powershell, [
    '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
    '-File', helper, '-NodePath', nodeBin, '-LauncherPath', __filename,
  ], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(`无法通过桌面 Shell 重新启动${detail ? ': ' + detail : ''}`);
  }
}

function runHiddenPowerShell(script) {
  if (process.platform !== 'win32') return;
  try {
    const encoded = Buffer.from(String(script), 'utf16le').toString('base64');
    // Resolve the system PowerShell explicitly. The managed Node runtime may
    // resolve a different shim when the shortcut is launched via wscript.
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const result = spawnSync(powershell, [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', encoded,
    ], { stdio: 'ignore', windowsHide: true, timeout: 10000 });
    if (result.error) log('Windows 本地提示调用失败: ' + result.error.message);
    else if (result.status !== 0) log('Windows 本地提示退出码: ' + result.status);
    else log('Windows 本地提示已完成');
  } catch (error) {
    log('Windows 本地提示调用失败: ' + error.message);
  }
}

function showWindowsMessageBox(title, message) {
  const ps = `$ErrorActionPreference='SilentlyContinue'; Add-Type -AssemblyName PresentationFramework; ` +
    `[System.Windows.MessageBox]::Show(${powershellQuote(message)},${powershellQuote(title)},'OK','Warning') | Out-Null`;
  runHiddenPowerShell(ps);
}

function showWindowsNotification(title, message) {
  const ps = `$ErrorActionPreference='SilentlyContinue'; Add-Type -AssemblyName System.Windows.Forms; ` +
    `Add-Type -AssemblyName System.Drawing; $n=New-Object System.Windows.Forms.NotifyIcon; ` +
    `$n.Icon=[System.Drawing.SystemIcons]::Information; $n.Visible=$true; ` +
    `$n.BalloonTipTitle=${powershellQuote(title)}; $n.BalloonTipText=${powershellQuote(message)}; ` +
    `$n.ShowBalloonTip(5000); Start-Sleep -Milliseconds 5500; $n.Dispose()`;
  runHiddenPowerShell(ps);
}

function powershellQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

async function reportAndExit(code, message, stage = 'windows-launcher') {
  try { await captureMessage(message, { stage, extra: { exitCode: code } }); } catch (_) {}
  process.exit(code);
}

function validCdpPort(port) {
  return Number.isInteger(port) && port >= 1024 && port <= 65535;
}

function readCdpPortFile() {
  try {
    const port = JSON.parse(fs.readFileSync(CDP_PORT_FILE, 'utf8')).port;
    return validCdpPort(port) ? port : 0;
  } catch (_) { return 0; }
}

function writeCdpPortFile(port) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = CDP_PORT_FILE + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ port, updatedAt: new Date().toISOString() }) + '\n');
    fs.renameSync(tmp, CDP_PORT_FILE);
  } catch (e) { log('保存 CDP 端口配置失败: ' + e.message); }
}

function cdpPortCandidates() {
  const result = [];
  const profilePorts = PROFILE_CDP_PORTS[PROFILE.id] || [DEFAULT_CDP_PORT];
  const add = (port) => { if (validCdpPort(port) && !result.includes(port)) result.push(port); };
  if (HAS_EXPLICIT_CDP_PORT || profilePorts.includes(CDP_PORT)) add(CDP_PORT);
  const savedPort = readCdpPortFile();
  if (profilePorts.includes(savedPort)) add(savedPort);
  for (const port of profilePorts) add(port);
  return result;
}

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: HOST });
    const t = setTimeout(() => { s.destroy(); resolve(false); }, 1200);
    s.on('connect', () => { clearTimeout(t); s.destroy(); resolve(true); });
    s.on('error', () => { clearTimeout(t); resolve(false); });
  });
}

function isLocalPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;
    const finish = (available) => {
      if (settled) return;
      settled = true;
      if (available) {
        try { server.close(() => resolve(true)); } catch (_) { resolve(true); }
      } else {
        try { server.close(); } catch (_) {}
        resolve(false);
      }
    };
    server.once('error', () => finish(false));
    server.listen({ host: HOST, port }, () => finish(true));
  });
}

function httpGet(port, p, headers = {}) {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port, path: p, headers, timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function httpPost(port, p, timeoutMs = INJECT_REQUEST_TIMEOUT_MS, headers = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: HOST, port, path: p, method: 'POST', headers, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; if (body.length > 20000) body = body.slice(0, 20000); });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

async function isWorkBuddyCdp() {
  return isWorkBuddyCdpAt(CDP_PORT);
}

async function isWorkBuddyCdpAt(port, binary = null) {
  const [version, targets] = await Promise.all([
    httpGet(port, '/json/version'),
    httpGet(port, '/json/list'),
  ]);
  if (!version || version.status !== 200 || !targets || targets.status !== 200) return false;
  let list;
  try {
    JSON.parse(version.body || '{}');
    list = JSON.parse(targets.body || '[]');
  } catch (_) {
    return false;
  }
  if (Array.isArray(list) && list.some((target) => isTargetForProfile(target, PROFILE))) return true;
  // 某些版本隐藏页面强信号；只有同安装目录进程的精确参数带着该端口时才允许兜底。
  // CIM 查询错误由共享边界直接抛出，不能伪装成“没有目标进程”。
  return Boolean(binary && workBuddyProcesses(binary).some((p) => processCdpPort(p) === Number(port)));
}

async function configureCdpPort() {
  for (const port of cdpPortCandidates()) {
    if (await isWorkBuddyCdpAt(port)) {
      CDP_PORT = port;
      process.env.WBSWITCH_CDP_PORT = String(port);
      writeCdpPortFile(port);
      log('发现 WorkBuddy CDP 端口: ' + port);
      return port;
    }
  }
  for (const port of cdpPortCandidates()) {
    // TCP connect 对无响应的残留 socket 可能返回超时并误报空闲；bind 才能确认新进程能否监听。
    if (await isLocalPortAvailable(port)) {
      CDP_PORT = port;
      process.env.WBSWITCH_CDP_PORT = String(port);
      writeCdpPortFile(port);
      log('选择可绑定 CDP 端口: ' + port);
      return port;
    }
  }
  throw new Error('当前 profile 的 CDP 端口均被占用，无法启动 WorkBuddy');
}

function strictPowerShellLines(cmd) {
  const utf8Command = '$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); ' + cmd;
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', utf8Command], {
    encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`PowerShell 路径发现失败: ${String(result.stderr || '').trim()}`);
  return String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function bestEffortPowerShellLines(cmd, label) {
  try {
    return strictPowerShellLines(cmd);
  } catch (error) {
    log(`跳过 ${label} PowerShell 路径发现: ${error.message}`);
    return [];
  }
}

function powershellLiteral(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

// 通过 CIM 查询当前 profile 主程序的路径、父 PID 和命令行；命令行正文绝不写入日志/Sentry。
function getWorkBuddyProcesses() {
  if (process.platform !== 'win32') return [];
  const names = [...PROFILE_PROCESS_NAMES].map((name) => `\"${name}\"`).join(',');
  const command = buildNativeProcessQuery(
    path.join(SCRIPTS_DIR, 'windows-process-boundary.ps1'),
    `$names=@(${names}); Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $names -contains $_.Name }`
  );
  const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  return parseCimProcessResult(result, {
    requireCommandLine: true,
    requireCurrentOwner: true,
    requireNativeArguments: true,
    allowTransientNotFound: true,
  });
}

// 仅保留为本地端口诊断；daemon 启动成功必须走 exactDaemonStatus 完整身份校验。
function daemonRunning() {
  return portOpen(UI_PORT);
}

function isPrewarmProcess(process) {
  return /(?:^|\s)--prewarm(?:\s|$)/i.test(String(process && process.CommandLine || ''));
}

function workBuddyProcesses(binary = null) {
  // WorkBuddy AI keeps a headless prewarm helper alive between windows. It is
  // not the user-facing app and must not block a cold launch or be terminated.
  const processes = getWorkBuddyProcesses().filter((process) => !isPrewarmProcess(process));
  if (!binary) return processes;
  const verified = filterVerifiedWindowsProcesses(
    binary, processes, fs.realpathSync.native, PROFILE.customTarget ? PROFILE_BINARY_NAMES : null
  );
  if (processes.length !== verified.length) {
    throw new Error('存在当前 profile 进程，但没有进程属于已验证安装目录，请先手动退出后重试');
  }
  return verified;
}

// 只读诊断：tasklist 结果仅写入失败快照，绝不进入任何 taskkill 参数或退出判定。
function tasklistProcessIds(names = PROFILE_PROCESS_NAMES) {
  const ids = new Set();
  for (const name of names) {
    try {
      const result = spawnSync('tasklist', ['/FI', 'IMAGENAME eq ' + name, '/FO', 'CSV', '/NH'], {
        encoding: 'utf8', timeout: 5000, windowsHide: true,
      });
      for (const line of String(result.stdout || '').split(/\r?\n/)) {
        const match = line.match(/^"[^"]+","(\d+)"/);
        if (match) ids.add(match[1]);
      }
    } catch (_) {}
  }
  return ids;
}

function processCdpPort(process) {
  const commandLine = String(process && process.CommandLine || '');
  const match = commandLine.match(/(?:^|\s)--remote-debugging-port(?:=|\s+)(\d+)(?:\s|$)/i);
  return match ? Number(match[1]) : 0;
}

function processHasCdpArg(process, port = CDP_PORT) {
  return processCdpPort(process) === Number(port);
}

function processDiagnostics(binary = null) {
  try {
    return workBuddyProcesses(binary).map((p) => ({
      pid: Number(p.ProcessId),
      parentPid: Number(p.ParentProcessId) || null,
      name: String(p.Name || ''),
      executable: path.basename(String(p.ExecutablePath || '')),
      hasCommandLine: Boolean(String(p.CommandLine || '').trim()),
      hasCdpArg: processCdpPort(p) > 0,
      cdpPort: processCdpPort(p) || null,
      hasExpectedCdpArg: processHasCdpArg(p),
    }));
  } catch (error) {
    // CIM is a live snapshot. A process exiting between enumeration and parsing
    // must not turn the diagnostic path into a launcher failure. Lifecycle and
    // termination authorization still call workBuddyProcesses directly.
    log('WorkBuddy 进程诊断暂不可用（进程可能刚刚退出）: ' + error.message);
    return [];
  }
}

function logProcessDiagnostics(binary, prefix = 'WorkBuddy 进程诊断') {
  const rows = processDiagnostics(binary);
  log(prefix + ': ' + (rows.length ? JSON.stringify(rows) : '无匹配进程'));
  return rows;
}

// 仅保留给旧调用方的状态查询。真正的启动流程会在 findWorkBuddy() 后，
// 通过 quitWorkBuddy() 对当前 profile 的已验证进程做精确重启。
function requireWorkBuddyClosedBeforeLaunch() {
  if (process.platform !== 'win32') return false;
  let rows;
  try {
    rows = workBuddyProcesses();
  } catch (error) {
    log('无法确认 WorkBuddy 是否已退出: ' + error.message);
    showWindowsMessageBox(WBS_BRAND, '无法确认 WorkBuddy 当前状态，请先完全退出 WorkBuddy 后再重试。');
    return true;
  }
  if (!rows.length) return false;
  log('检测到 WorkBuddy 已在运行，停止本次冷启动请求');
  showWindowsMessageBox(WBS_BRAND, '请先完全退出 WorkBuddy，再重新点击桌面快捷方式。');
  return true;
}

function readDaemonVersion() {
  try {
    const src = fs.readFileSync(path.join(SCRIPTS_DIR, 'daemon.js'), 'utf8');
    const m = src.match(/DAEMON_VERSION\s*=\s*'([^']+)'/);
    return m ? m[1] : '';
  } catch (_) { return ''; }
}

function readDaemonIdentity() {
  try {
    const src = fs.readFileSync(path.join(SCRIPTS_DIR, 'daemon.js'), 'utf8');
    return {
      version: (src.match(/DAEMON_VERSION\s*=\s*'([^']+)'/) || [])[1] || '',
      buildId: (src.match(/DAEMON_BUILD_ID\s*=\s*'([^']+)'/) || [])[1] || '',
    };
  } catch (_) {
    return { version: '', buildId: '' };
  }
}

// ---------- 定位 node（安装包内置优先，WorkBuddy 托管运行时次之，最后 PATH） ----------
function findNode() {
  const bundled = path.join(SCRIPTS_DIR, 'runtime', 'node', 'node.exe');
  const base = path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'versions');
  let verDirs = [];
  try {
    verDirs = fs.readdirSync(base)
      .map((d) => path.join(base, d, 'node.exe'))
      .filter((p) => fs.existsSync(p))
      .sort();
  } catch (_) {}

  // A stale watchdog.pid is not evidence that the daemon uses WorkBuddy's
  // managed Node. Select a runtime only when its exact daemon/watchdog process
  // is actually running; otherwise a stale PID file can make identity checks
  // reject a valid daemon started by the bundled runtime.
  const candidates = [];
  for (const candidate of [bundled, ...verDirs]) {
    try {
      const resolved = resolveWindowsExecutable(candidate);
      if (!candidates.some((item) => sameWindowsPath(item, resolved))) candidates.push(resolved);
    } catch (_) {}
  }
  for (const candidate of candidates) {
    try {
      if (uniqueNodeProcess(candidate, DAEMON_SCRIPT) || uniqueNodeProcess(candidate, WATCHDOG_SCRIPT)) {
        return candidate;
      }
    } catch (_) {}
  }
  if (candidates.length) return candidates[0];
  try {
    const r = spawnSync('where.exe', ['node.exe'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
    const candidate = String(r.stdout || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (r.status === 0 && candidate) return resolveWindowsExecutable(candidate);
  } catch (_) {}
  return null;
}

// ---------- 定位 WorkBuddy.exe（环境变量 > 运行进程 > App Paths/卸载注册表 > 常见便携路径） ----------
let wbBinaryCache = null;
function findWorkBuddy() {
  if (wbBinaryCache) return wbBinaryCache;
  const tryFile = (p) => {
    try {
      const candidate = String(p || '').trim().replace(/^"(.*)"(?:,\d+)?$/, '$1').replace(/,\d+$/, '');
      if (!candidate || !fs.existsSync(candidate)) return null;
      const resolved = resolveWindowsExecutable(candidate);
      return PROFILE_BINARY_NAMES.has(path.win32.basename(resolved).toLowerCase()) ? resolved : null;
    } catch (_) {}
    return null;
  };
  const runningBin = selectRunningProfileBinary(
    [...PROFILE_BINARY_NAMES],
    getWorkBuddyProcesses().filter((process) => !isPrewarmProcess(process))
  );
  const envBin = tryFile(process.env.WBSWITCH_WORKBUDDY_BIN);
  if (process.env.WBSWITCH_WORKBUDDY_BIN && !envBin) {
    throw new Error('WBSWITCH_WORKBUDDY_BIN 不是可验证的当前 profile 主程序');
  }
  if (envBin) {
    if (runningBin && !sameWindowsPath(runningBin, envBin)) {
      throw new Error('检测到当前 profile 正从另一安装目录运行，请先手动退出后重试');
    }
    return (wbBinaryCache = envBin);
  }
  if (runningBin) return (wbBinaryCache = runningBin);
  const discovered = [];
  const addCandidate = (candidate) => {
    const hit = tryFile(candidate);
    if (hit) discovered.push(hit);
  };
  addCandidate(PROFILE.appPath);
  // 便携版通常没有卸载项，但可能注册了 App Paths；优先读取其真实可执行路径。
  for (const candidate of bestEffortPowerShellLines("$k=@('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\WorkBuddy.exe','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\WorkBuddy.exe','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\CodeBuddy.exe','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\CodeBuddy.exe'); Get-ItemProperty $k -ErrorAction SilentlyContinue | ForEach-Object { if ($_.'(default)') { $_.'(default)' } elseif ($_.Path) { $_.Path } }", 'App Paths')) {
    addCandidate(candidate);
  }
  for (const candidate of bestEffortPowerShellLines("$k=@('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'); Get-ItemProperty $k -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'WorkBuddy|CodeBuddy' } | ForEach-Object { if($_.DisplayIcon){ ($_.DisplayIcon -replace ',.*$','').Trim() } elseif($_.InstallLocation){ Join-Path $_.InstallLocation 'WorkBuddy.exe' } }", '卸载注册表')) {
    addCandidate(candidate);
  }
  const roots = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'WorkBuddy', 'WorkBuddy.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'WorkBuddyAI', 'WorkBuddyAI.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'CodeBuddy', 'CodeBuddy.exe'),
    path.join(process.env.ProgramFiles || '', 'WorkBuddy', 'WorkBuddy.exe'),
    path.join(process.env.ProgramFiles || '', 'WorkBuddyAI', 'WorkBuddyAI.exe'),
    path.join(process.env.ProgramFiles || '', 'CodeBuddy', 'CodeBuddy.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'WorkBuddy', 'WorkBuddy.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'WorkBuddy', 'WorkBuddy.exe'),
    path.join(process.env.APPDATA || '', 'WorkBuddy', 'WorkBuddy.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'CodeBuddy', 'CodeBuddy.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'CodeBuddy', 'CodeBuddy.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'CodeBuddy', 'WorkBuddy.exe'),
    path.join(process.env.USERPROFILE || '', 'scoop', 'apps', 'workbuddy', 'current', 'WorkBuddy.exe'),
    'D:\\workbuddy\\WorkBuddy.exe',
  ];
  if (PROFILE.id === 'workbuddy-ai') {
    roots.unshift(
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'WorkBuddyAI', 'WorkBuddyAI.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'WorkBuddyAI', 'WorkBuddyAI.exe')
    );
  }
  if (process.env.WBSWITCH_WORKBUDDY_DIR) {
    roots.push(path.join(process.env.WBSWITCH_WORKBUDDY_DIR, [...PROFILE_BINARY_NAMES][0]));
  }
  // 兼容类似 D:\\Software\\workbuddy\\WorkBuddy.exe 的便携目录，不递归扫描整盘。
  const driveRoots = bestEffortPowerShellLines('(Get-PSDrive -PSProvider FileSystem).Root', '磁盘根目录');
  for (const root of driveRoots) {
    roots.push(path.join(root, 'Software', 'workbuddy', 'WorkBuddy.exe'));
    roots.push(path.join(root, 'Software', 'workbuddy-ai', 'WorkBuddyAI.exe'));
    roots.push(path.join(root, 'Software', 'codebuddy', 'CodeBuddy.exe'));
    roots.push(path.join(root, 'workbuddy', 'WorkBuddy.exe'));
    roots.push(path.join(root, 'WorkBuddy', 'WorkBuddy.exe'));
  }
  for (const candidate of roots) addCandidate(candidate);
  // 兼容 Electron/Squirrel 的 app-<version> 子目录；收集全部命中后再要求唯一真实路径。
  const scanDirs = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'WorkBuddy'),
    path.join(process.env.LOCALAPPDATA || '', 'WorkBuddy'),
    path.join(process.env.APPDATA || '', 'WorkBuddy'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'CodeBuddy'),
    path.join(process.env.LOCALAPPDATA || '', 'CodeBuddy'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'WorkBuddyAI'),
    path.join(process.env.LOCALAPPDATA || '', 'WorkBuddyAI'),
  ];
  const psLiteral = (value) => "'" + String(value).replace(/'/g, "''") + "'";
  const scanCommand = [
    '$roots=@(' + scanDirs.map(psLiteral).join(', ') + ')',
    '$names=@(' + [...PROFILE_BINARY_NAMES].map(psLiteral).join(', ') + ')',
    'foreach($root in $roots){',
    'if(-not (Test-Path -LiteralPath $root -PathType Container)){continue}',
    'Get-ChildItem -LiteralPath $root -File -Recurse -Depth 5 -ErrorAction SilentlyContinue | Where-Object { $names -contains $_.Name } | Select-Object -ExpandProperty FullName',
    '}',
  ].join('; ');
  for (const candidate of bestEffortPowerShellLines(scanCommand, '安装目录扫描')) addCandidate(candidate);
  const selected = selectPreferredDiscoveredBinary(PROFILE_BINARY_NAMES, discovered);
  if (discovered.length > 1) {
    log('检测到多个 dormant WorkBuddy 安装目录，按发现优先级选择: ' + selected);
  }
  return selected ? (wbBinaryCache = selected) : null;
}

// ---------- 1. 确保 daemon 运行 ----------
const WATCHDOG_PID_FILE = path.join(DATA_DIR, 'watchdog.pid');
const WATCHDOG_SCRIPT = path.join(SCRIPTS_DIR, 'watchdog.js');
const DAEMON_SCRIPT = path.join(SCRIPTS_DIR, 'daemon.js');

function listenerPids(port) {
  const result = spawnSync('netstat', ['-ano', '-p', 'tcp'], {
    encoding: 'utf8', timeout: 8000, windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error('无法查询 daemon 监听进程');
  const pids = new Set();
  for (const line of String(result.stdout || '').split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5 || !/LISTENING/i.test(fields[3]) || !fields[1].endsWith(':' + port)) continue;
    const pid = Number(fields[fields.length - 1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('daemon 监听 PID 无效');
    pids.add(pid);
  }
  return [...pids];
}

function queryNodeProcesses(nodeBin, pids = null, commandLineHint = '') {
  if (!nodeBin) throw new Error('Node 运行时路径缺失，无法验证进程');
  const expectedNode = powershellLiteral(nodeBin);
  let source = `Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" -ErrorAction Stop | Where-Object { $_.ExecutablePath -ieq ${expectedNode} }`;
  if (commandLineHint) {
    const hint = String(commandLineHint).replace(/'/g, "''");
    source += ` | Where-Object { $_.CommandLine -like '*${hint}*' }`;
  }
  if (pids !== null) {
    const safePids = [...new Set(pids.map(Number))];
    if (!safePids.length) return [];
    if (safePids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)) throw new Error('目标 Node PID 无效');
    source = `$ids=@(${safePids.join(',')}); ${source} | Where-Object { $ids -contains [int]$_.ProcessId }`;
  }
  const command = buildNativeProcessQuery(
    path.join(SCRIPTS_DIR, 'windows-process-boundary.ps1'), source
  );
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  return parseCimProcessResult(result, {
    requireCommandLine: true,
    requireCurrentOwner: true,
    requireNativeArguments: true,
  });
}

function uniqueNodeProcess(nodeBin, expectedScript) {
  const matches = filterVerifiedNodeProcesses(
    nodeBin,
    expectedScript,
    queryNodeProcesses(nodeBin, null, path.basename(expectedScript))
  );
  if (matches.length > 1) throw new Error(`目标 Node 入口存在多个进程: ${expectedScript}`);
  return matches[0] || null;
}

function readWatchdogPid() {
  try {
    const text = fs.readFileSync(WATCHDOG_PID_FILE, 'utf8').trim();
    const pid = Number(text);
    if (!Number.isSafeInteger(pid) || pid <= 0 || String(pid) !== text) throw new Error('watchdog.pid 内容无效');
    return pid;
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function watchdogState(nodeBin) {
  let pid = readWatchdogPid();
  let exact = uniqueNodeProcess(nodeBin, WATCHDOG_SCRIPT);
  if (!pid) {
    // A detached watchdog can be visible to CIM a moment before its atomic
    // PID-file write becomes visible. Give that startup race a short window;
    // after it expires, a single exact process can be recovered below while
    // ambiguous or duplicate instances still fail closed.
    for (let attempt = 0; attempt < 10 && !pid; attempt += 1) {
      if (attempt > 0) await sleep(250);
      pid = readWatchdogPid();
      if (pid) break;
      exact = uniqueNodeProcess(nodeBin, WATCHDOG_SCRIPT);
    }
  }
  if (!pid && exact) {
    // An installer/update can remove watchdog.pid after the exact watchdog
    // process has started but before that process exits. The executable path,
    // entry script, owner, and profile-specific scripts directory are already
    // stronger identity evidence than the user-writable PID file. Recreate the
    // file only for this single exact process, then re-read it and verify the
    // process again before allowing reuse.
    try {
      fs.writeFileSync(WATCHDOG_PID_FILE, String(exact.ProcessId), { flag: 'wx' });
      log(`通过精确身份恢复缺失的 watchdog.pid=${exact.ProcessId}`);
      pid = readWatchdogPid();
    } catch (error) {
      const current = readWatchdogPid();
      if (current !== Number(exact.ProcessId)) {
        throw new Error('当前 profile 的 watchdog.pid 缺失，且无法安全恢复: ' + error.message);
      }
      pid = current;
    }
  }
  if (!pid) return { kind: 'absent', pid: null };
  let processes;
  try {
    processes = queryNodeProcesses(nodeBin, [pid], path.basename(WATCHDOG_SCRIPT));
  } catch (error) {
    if (!exact || exact.ProcessId === pid) throw error;
    processes = [];
  }
  if (processes.length === 0) {
    if (exact) {
      const current = readWatchdogPid();
      if (current !== pid) throw new Error('watchdog.pid 在修复前发生变化');
      fs.writeFileSync(WATCHDOG_PID_FILE, String(exact.ProcessId), 'utf8');
      log(`watchdog.pid 已从陈旧 PID=${pid} 修复为精确 PID=${exact.ProcessId}`);
      return { kind: 'verified', pid: exact.ProcessId, process: exact };
    }
    return { kind: 'stale', pid };
  }
  const process = assertVerifiedNodeProcess(pid, nodeBin, WATCHDOG_SCRIPT, processes);
  if (!exact || exact.ProcessId !== pid) throw new Error('watchdog.pid 与枚举到的精确 watchdog 进程不一致');
  assertSameProcessIdentity(exact, process);
  return { kind: 'verified', pid, process };
}

function validateDaemonProcess(nodeBin, status = null) {
  const listeners = listenerPids(UI_PORT);
  if (listeners.length !== 1) throw new Error('daemon 监听 PID 不唯一或不存在');
  if (status && status.pid != null &&
      (!Number.isSafeInteger(status.pid) || status.pid <= 0 || status.pid !== listeners[0])) {
    throw new Error('daemon 状态 PID 无效或与监听 PID 不一致');
  }
  const processes = queryNodeProcesses(nodeBin, listeners);
  assertVerifiedNodeProcess(listeners[0], nodeBin, DAEMON_SCRIPT, processes);
  return { listenerPids: listeners, nodeProcesses: processes };
}

function exactDaemonStatus(nodeBin, status, allowPrivilegeMismatch = false) {
  const identity = readDaemonIdentity();
  const processIdentity = validateDaemonProcess(nodeBin, status);
  assertDaemonServiceIdentity({
    status,
    expectedVersion: identity.version,
    expectedBuildId: identity.buildId,
    expectedProfileId: PROFILE.id,
    listenerPids: processIdentity.listenerPids,
    expectedNode: nodeBin,
    expectedScript: DAEMON_SCRIPT,
    expectedPrivilege: allowPrivilegeMismatch ? '' : WINDOWS_PRIVILEGE,
    nodeProcesses: processIdentity.nodeProcesses,
  });
  return status;
}

async function readStatus() {
  const response = await httpGet(UI_PORT, '/api/status', localApiHeaders());
  if (!response) return null;
  if (response.status !== 200) throw new Error(`daemon 状态接口返回 ${response.status}`);
  try { return JSON.parse(response.body); } catch (_) { throw new Error('daemon 状态接口返回无效 JSON'); }
}

function authenticatedElevatedDaemonStatus(status) {
  const identity = readDaemonIdentity();
  return assertAuthenticatedDaemonCapability({
    status,
    expectedProfileId: PROFILE.id,
    expectedVersion: identity.version,
    expectedDataDir: DATA_DIR,
    listenerPids: listenerPids(UI_PORT),
    allowVersionMismatch: true,
  });
}

async function waitForExactDaemon(nodeBin, attempts) {
  for (let i = 0; i < attempts; i++) {
    await sleep(400);
    const status = await readStatus();
    const listeners = listenerPids(UI_PORT);
    // The daemon can bind its socket before /api/status is ready. Treat that
    // transient half-ready state like any other startup retry instead of
    // passing null into the identity validator and aborting cold launch.
    if (!status || listeners.length !== 1) continue;
    return exactDaemonStatus(nodeBin, status);
  }
  return null;
}

function killVerifiedNodeProcess(process, nodeBin, expectedScript) {
  const pid = Number(process.ProcessId);
  const rows = queryNodeProcesses(nodeBin, [pid]);
  if (rows.length === 0) return false;
  const current = assertVerifiedNodeProcess(pid, nodeBin, expectedScript, rows);
  assertSameProcessIdentity(process, current);
  const result = spawnSync('taskkill', ['/F', '/PID', String(pid)], {
    stdio: 'ignore', windowsHide: true, timeout: 10000,
  });
  if (result.error || result.status !== 0) {
    // taskkill can race with a process that exits after the final identity
    // check. Re-query the exact PID before failing; a missing PID means the
    // requested termination already happened.
    if (queryNodeProcesses(nodeBin, [pid]).length === 0) return true;
    throw new Error(`无法结束已验证进程 PID=${pid}`);
  }
  if (queryNodeProcesses(nodeBin, [pid]).length !== 0) throw new Error(`已验证进程 PID=${pid} 未退出`);
  return true;
}

function authorizeDaemonTermination(nodeBin, status, allowLowerPrivilege = false) {
  const processIdentity = validateDaemonProcess(nodeBin, status);
  return assertDaemonTerminationIdentity({
    status,
    expectedProfileId: PROFILE.id,
    listenerPids: processIdentity.listenerPids,
    expectedNode: nodeBin,
    expectedScript: DAEMON_SCRIPT,
    expectedPrivilege: allowLowerPrivilege ? '' : WINDOWS_PRIVILEGE,
    nodeProcesses: processIdentity.nodeProcesses,
  });
}

function removeWatchdogPidIf(pid) {
  const current = readWatchdogPid();
  if (current === null) return;
  if (current !== pid) throw new Error('watchdog.pid 在清理前发生变化');
  fs.unlinkSync(WATCHDOG_PID_FILE);
}

async function stopDaemonByPort(nodeBin, allowLowerPrivilege = false) {
  const watchdog = await watchdogState(nodeBin);
  if (watchdog.kind === 'untracked') {
    throw new Error('发现没有当前 profile PID 文件的 watchdog 进程，拒绝复用或结束');
  }
  if (watchdog.kind === 'stale') {
    removeWatchdogPidIf(watchdog.pid);
    log('已清理确认不存在的旧 watchdog.pid');
  }
  const listeners = listenerPids(UI_PORT);
  if (listeners.length > 1) throw new Error('daemon 监听 PID 不唯一');
  const daemon = uniqueNodeProcess(nodeBin, DAEMON_SCRIPT);
  let authorizedDaemon = null;
  if (daemon || listeners.length) {
    const status = await readStatus();
    if (!status || listeners.length !== 1) {
      throw new Error('daemon 未绑定当前 UI 端口与当前 profile 状态，拒绝结束');
    }
    authorizedDaemon = authorizeDaemonTermination(nodeBin, status, allowLowerPrivilege);
    if (!daemon || daemon.ProcessId !== authorizedDaemon.ProcessId) {
      throw new Error('daemon 监听 PID 与枚举到的精确 daemon 进程不一致');
    }
    const identity = readDaemonIdentity();
    if (!allowLowerPrivilege && status.version === identity.version && status.buildId === identity.buildId) {
      throw new Error('daemon 版本与构建已匹配，拒绝结束当前实例');
    }
  }
  if (watchdog.kind === 'verified') {
    killVerifiedNodeProcess(watchdog.process, nodeBin, WATCHDOG_SCRIPT);
    removeWatchdogPidIf(watchdog.pid);
  }
  if (authorizedDaemon) killVerifiedNodeProcess(authorizedDaemon, nodeBin, DAEMON_SCRIPT);
  await sleep(300);
  // 终止窗口内出现的 daemon 没有独立的端口与 status 绑定证据，绝不自动结束。
  const remainingDaemon = uniqueNodeProcess(nodeBin, DAEMON_SCRIPT);
  if (remainingDaemon) {
    throw new Error('发现未绑定当前 profile 状态的新 daemon 进程，拒绝结束');
  }
  await sleep(300);
  if (uniqueNodeProcess(nodeBin, DAEMON_SCRIPT) || listenerPids(UI_PORT).length || await portOpen(UI_PORT)) {
    throw new Error('daemon 停止失败，端口仍被占用');
  }
}

async function ensureDaemon(nodeBin) {
  fs.mkdirSync(path.join(DATA_DIR, 'accounts'), { recursive: true });
  const status = await readStatus();
  const listeners = listenerPids(UI_PORT);
  if (status || listeners.length) {
    let upgradedPrivilege = false;
    try {
      authorizeDaemonTermination(nodeBin, status);
    } catch (error) {
      // An explicitly elevated launcher may replace an older standard daemon.
      // The inverse transition is refused because a standard process cannot
      // safely terminate an elevated one.
      if (WINDOWS_PRIVILEGE === 'elevated' && status && status.privilege === 'standard') {
        log('检测到旧 daemon 为 standard，当前 launcher 为 elevated，准备升级权限模式');
        await stopDaemonByPort(nodeBin, true);
        upgradedPrivilege = true;
      } else if (WINDOWS_PRIVILEGE === 'standard' && status && status.privilege === 'elevated') {
        // Windows intentionally hides an elevated process's executable and
        // command line from this standard process. The per-profile API token
        // provides a non-termination capability proof for safe reuse.
        authenticatedElevatedDaemonStatus(status);
        log('普通权限 launcher 复用已验证的 elevated 服务；不会跨权限结束进程');
        return true;
      } else {
        throw error;
      }
    }
    if (!upgradedPrivilege) {
      const identity = readDaemonIdentity();
      if (status.version === identity.version && status.buildId === identity.buildId) {
        exactDaemonStatus(nodeBin, status);
        log('daemon 身份、版本、构建和权限均已验证，跳过启动');
        return true;
      }
      log('daemon 版本或构建不匹配，停止已绑定当前 profile 的旧进程');
      await stopDaemonByPort(nodeBin);
    }
  }

  let watchdog = await watchdogState(nodeBin);
  if (watchdog.kind === 'untracked') {
    throw new Error('发现没有当前 profile PID 文件的 watchdog 进程，拒绝复用或结束');
  }
  if (watchdog.kind === 'verified') {
    const ready = await waitForExactDaemon(nodeBin, 20);
    if (ready) return true;
    await stopDaemonByPort(nodeBin);
    watchdog = { kind: 'absent', pid: null };
  }
  if (watchdog.kind === 'stale') {
    removeWatchdogPidIf(watchdog.pid);
    log('已清理确认不存在的旧 watchdog.pid，继续启动');
    watchdog = { kind: 'absent', pid: null };
  }
  const orphanDaemon = uniqueNodeProcess(nodeBin, DAEMON_SCRIPT);
  if (orphanDaemon) {
    throw new Error('发现未绑定当前 UI 端口与当前 profile 状态的 daemon 进程，拒绝结束或启动重复实例');
  }
  log('启动 watchdog: ' + nodeBin);
  const child = spawn(nodeBin, [WATCHDOG_SCRIPT], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  if (await waitForExactDaemon(nodeBin, 30)) {
    log('daemon 已通过完整身份校验');
    return true;
  }
  throw new Error('等待 daemon 完整身份校验超时');
}

// ---------- 2/3. WorkBuddy CDP 处理 ----------
function workBuddyRunning(binary = null) {
  return workBuddyProcesses(binary).length > 0;
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

async function waitForWorkBuddyExit(timeoutMs, binary = null) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!workBuddyRunning(binary)) return true;
    await sleep(200);
  }
  return !workBuddyRunning(binary);
}

function exitSnapshot(binary = null) {
  return {
    binary: binary ? path.basename(binary) : null,
    processes: processDiagnostics(binary),
    unverifiedTasklistPids: Array.from(tasklistProcessIds()),
  };
}

async function killForExit(args, stage, verifyGone) {
  const result = await runTaskkill(args);
  const error = result.error ? result.error.message : '';
  log(`[exit] ${stage} taskkill=${args.join(' ')} code=${result.code == null ? 'null' : result.code}${error ? ' error=' + error : ''}`);
  if (result.error || result.code !== 0) {
    // Windows may report ERRORLEVEL 128 when the target exits between the
    // caller's identity re-check and taskkill. Accept it only when this exact
    // target PID has disappeared.
    if (verifyGone && await verifyGone()) {
      log(`[exit] ${stage} taskkill 非零但目标 PID 已消失，按竞态成功处理`);
      return result;
    }
    throw result.error || new Error(`${stage} taskkill 失败 (code=${result.code})`);
  }
  return result;
}

async function killVerifiedWorkBuddyProcess(binary, process, force, stage) {
  const pid = Number(process.ProcessId);
  const current = workBuddyProcesses(binary).find((item) => Number(item.ProcessId) === pid);
  if (!current) return false;
  assertSameProcessIdentity(process, current);
  await killForExit(
    [...(force ? ['/F'] : []), '/PID', String(pid)],
    stage,
    async () => {
      const after = workBuddyProcesses(binary).find((item) => Number(item.ProcessId) === pid);
      if (!after) return true;
      assertSameProcessIdentity(process, after);
      return false;
    }
  );
  return true;
}

async function quitWorkBuddy(binary) {
  const initial = workBuddyProcesses(binary);
  if (!initial.length && !workBuddyRunning(binary)) return true;

  if (!initial.length) {
    throw new Error(`${PROFILE.name} 正在运行，但无法验证其绝对可执行路径；为避免误杀，已停止重启`);
  }

  log(`[exit] 开始确认退出 profile=${PROFILE.id} snapshot=${JSON.stringify(exitSnapshot(binary))}`);
  // 按实际 PID 精确结束安装目录中的进程树：每个成员都先经 CIM 路径验证，
  // 再逐 PID 结束，不按镜像名或未验证 PID 兜底。
  for (const process of initial) {
    await killVerifiedWorkBuddyProcess(binary, process, false, '结束已验证进程');
  }
  if (await waitForWorkBuddyExit(2500, binary)) {
    log(`[exit] 已确认退出 profile=${PROFILE.id} snapshot=${JSON.stringify(exitSnapshot(binary))}`);
    return true;
  }

  // 单实例宿主可能在第一次 taskkill 后重新生成辅助进程；刷新并重新验证 PID 后强杀两轮。
  for (let round = 1; round <= 2; round++) {
    const current = workBuddyProcesses(binary);
    log(`[exit] 强制结束第 ${round} 轮 snapshot=${JSON.stringify(exitSnapshot(binary))}`);
    for (const process of current) {
      await killVerifiedWorkBuddyProcess(binary, process, true, `强制结束第${round}轮`);
    }
    if (await waitForWorkBuddyExit(2500, binary)) {
      log(`[exit] 强制结束后已确认退出 profile=${PROFILE.id} snapshot=${JSON.stringify(exitSnapshot(binary))}`);
      return true;
    }
  }

  const final = exitSnapshot(binary);
  log(`[exit] 无法确认退出 profile=${PROFILE.id} final=${JSON.stringify(final)}`);
  const names = final.processes.map((p) => p.name).filter(Boolean).join(',') || 'unknown';
  const pidsLeft = final.processes.map((p) => p.pid).filter(Boolean).join(',') || 'unknown';
  throw new Error(`${PROFILE.name} 无法在当前权限模式下安全退出（剩余镜像=${names}; PID=${pidsLeft}）。请手动关闭该程序，并用相同权限重新启动 WorkDaddy`);
}

function launchWorkBuddy(wb) {
  const environmentMode = !!(PROFILE.cdp && PROFILE.cdp.mode === 'environment');
  const args = environmentMode ? [] : ['--remote-debugging-port=' + CDP_PORT];
  const env = environmentMode
    ? { ...process.env, WORKBUDDY_REMOTE_DEBUGGING_PORT: String(CDP_PORT) }
    : process.env;
  const child = spawn(wb, args, {
    cwd: path.dirname(wb), detached: true, stdio: 'ignore', windowsHide: true, env,
  });
  const state = { method: 'node-spawn', pid: Number.isSafeInteger(child.pid) ? child.pid : null, errorCode: null, exitCode: null, signal: null };
  child.on('error', (e) => {
    state.errorCode = String(e && e.code || 'spawn-error').slice(0, 80);
    log('启动 WorkBuddy 失败: ' + e.message);
  });
  child.on('exit', (code, signal) => {
    state.exitCode = Number.isInteger(code) ? code : null;
    state.signal = signal ? String(signal).slice(0, 32) : null;
  });
  child.unref();
  return state;
}

async function waitForWorkBuddyCdp(binary) {
  const deadline = Date.now() + CDP_STARTUP_TIMEOUT_MS;
  let retryWithoutCdpArg = false;
  let retryOnNextPort = false;
  let lastDiagnosticAt = 0;
  let launchStartedAt = Date.now();

  const start = () => {
    const launched = launchWorkBuddy(binary);
    launchStartedAt = Date.now();
    log('WorkBuddy 启动请求已派发 method=' + launched.method + ' expectedPort=' + CDP_PORT +
      (launched.pid ? ' pid=' + launched.pid : ''));
  };
  start();

  while (Date.now() < deadline) {
    await sleep(1000);
    if (await isWorkBuddyCdpAt(CDP_PORT, binary)) return true;

    const elapsed = Date.now() - launchStartedAt;
    const diagnostics = processDiagnostics(binary);
    const hasProcessWithoutArg = diagnostics.length > 0 && !diagnostics.some((p) => p.hasCdpArg);
    if (!retryOnNextPort && Date.now() - launchStartedAt >= CDP_PORT_RETRY_GRACE_MS && diagnostics.length === 0 &&
        await isLocalPortAvailable(CDP_PORT)) {
      const nextPort = await findNextAvailableCdpPort(CDP_PORT);
      if (nextPort) {
        retryOnNextPort = true;
        CDP_PORT = nextPort;
        process.env.WBSWITCH_CDP_PORT = String(nextPort);
        writeCdpPortFile(nextPort);
        log('当前 CDP 端口未成功监听，改用备用端口重试: ' + nextPort);
        start();
        continue;
      }
    }
    if (!(PROFILE.cdp && PROFILE.cdp.mode === 'environment') &&
        hasProcessWithoutArg && elapsed >= 5000 && !retryWithoutCdpArg) {
      // 单实例宿主可能接管了第一次启动请求；精确结束该安装目录的进程树后只重试一次。
      logProcessDiagnostics(binary, '启动后进程未携带 CDP 参数，准备重试');
      retryWithoutCdpArg = true;
      await quitWorkBuddy(binary);
      await sleep(1000);
      start();
      continue;
    }
    if (Date.now() - lastDiagnosticAt >= 5000) {
      lastDiagnosticAt = Date.now();
      log('等待 WorkBuddy CDP: ' + Math.min(Date.now() - (deadline - CDP_STARTUP_TIMEOUT_MS), CDP_STARTUP_TIMEOUT_MS) +
        'ms/' + CDP_STARTUP_TIMEOUT_MS + 'ms');
      if (diagnostics.length) logProcessDiagnostics(binary, '等待期间');
    }
  }

  // 端口可能在启动后被系统/其他进程抢占；超时前再扫描候选端口一次，避免只盯着旧的 9222。
  for (const port of cdpPortCandidates()) {
    if (port === CDP_PORT) continue;
    if (await isWorkBuddyCdpAt(port, binary)) {
      CDP_PORT = port;
      process.env.WBSWITCH_CDP_PORT = String(port);
      writeCdpPortFile(port);
      log('超时前发现 WorkBuddy 使用备用 CDP 端口: ' + port);
      return true;
    }
  }
  logProcessDiagnostics(binary, 'CDP 超时最终诊断');
  return false;
}

async function findNextAvailableCdpPort(exclude) {
  for (const port of cdpPortCandidates()) {
    if (port === exclude) continue;
    if (await isWorkBuddyCdpAt(port)) return port;
    if (await isLocalPortAvailable(port)) return port;
  }
  return 0;
}

async function injectNow() {
  // daemon 的 /api/inject 可能需要等待 renderer 完成首屏；客户端断开不代表 daemon 停止注入。
  let lastError = '注入请求无响应';
  for (let attempt = 1; attempt <= INJECT_MAX_ATTEMPTS; attempt += 1) {
    const response = await httpPost(UI_PORT, '/api/inject', INJECT_REQUEST_TIMEOUT_MS, localApiHeaders());
    if (!response) {
      lastError = '注入请求超时，daemon 仍可能在后台重试';
    } else {
      let payload = null;
      try { payload = JSON.parse(response.body || '{}'); } catch (_) {}
      if (response.status === 200 && payload && payload.ok === true && payload.mounted === true) {
        return payload;
      }
      if (response.status === 401 || response.status === 404) {
        const detail = payload && payload.error ? ': ' + payload.error : ` (HTTP ${response.status})`;
        throw new Error('WorkDaddy 组件注入失败' + detail);
      }
      lastError = payload && payload.error
        ? payload.error
        : `注入响应未完成 (HTTP ${response.status})`;
    }
    if (attempt < INJECT_MAX_ATTEMPTS) {
      log(`[inject] 第 ${attempt}/${INJECT_MAX_ATTEMPTS} 次未完成：${lastError}；${INJECT_RETRY_DELAY_MS}ms 后重试`);
      await sleep(INJECT_RETRY_DELAY_MS);
    }
  }
  return { pending: true, error: lastError };
}

async function injectNowOrPending() {
  const result = await injectNow();
  if (!result || result.pending) {
    const detail = result && result.error ? `（${result.error}）` : '';
    log(`[inject] launcher 放弃等待，后台继续注入${detail}`);
    console.log(WBS_BRAND + '：后台正在注入组件，WorkBuddy 页面就绪后会自动生效。');
    return false;
  }
  return true;
}

function nativeHelperPath() {
  return path.join(WORKDADDY_APP_DIR, 'WorkDaddyLauncher.exe');
}

function runNativeHelper(args, options = {}) {
  const helper = nativeHelperPath();
  if (!fs.existsSync(helper)) throw new Error('缺少原生启动器 WorkDaddyLauncher.exe');
  const result = spawnSync(helper, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeout || 20000,
  });
  if (result.error) throw result.error;
  return result;
}

function comparableVersion(value) {
  const parts = String(value || '').trim().split('.').map((part) => Number(part));
  if (!parts.length || parts.some((part) => !Number.isInteger(part) || part < 0)) return '';
  while (parts.length > 2 && parts[parts.length - 1] === 0) parts.pop();
  return parts.join('.');
}

function nativeFileVersion(binary) {
  const result = runNativeHelper(['--file-version', '--binary', binary], { timeout: 10000 });
  if (result.status !== 0) return '';
  return String(result.stdout || '').trim();
}

function verifyConfiguredWorkBuddyVersion(binary) {
  if (!PROFILE.configuredTarget || !PROFILE.lockTargetVersion || !PROFILE.targetVersion) return;
  const actual = nativeFileVersion(binary);
  if (!actual) throw new Error('无法读取所选 WorkBuddy 的版本，已停止启动；请重新运行 WorkDaddy 安装程序确认客户端路径');
  if (comparableVersion(actual) !== comparableVersion(PROFILE.targetVersion)) {
    throw new Error(`所选 WorkBuddy 版本已变化（期望 ${PROFILE.targetVersion}，实际 ${actual}），请重新运行 WorkDaddy 安装程序确认新版本`);
  }
}

let nativeDiscoveryState = null;
let nativeWatchdogAttempts = [];
let nativeLaunchState = null;

function nativeWorkBuddyProcessSummary() {
  const summary = { queryStatus: null, count: 0, withPath: 0, uniquePathCount: 0 };
  try {
    const result = runNativeHelper(['--list-workbuddy', '--profile', PROFILE.id]);
    summary.queryStatus = result.status;
    if (result.status !== 0) return summary;
    const rows = JSON.parse(String(result.stdout || '[]'));
    if (!Array.isArray(rows)) return summary;
    const paths = [];
    summary.count = rows.length;
    for (const row of rows) {
      const value = String(row && row.path || '').trim();
      if (!value) continue;
      summary.withPath += 1;
      if (!paths.some((item) => sameWindowsPath(item, value))) paths.push(value);
    }
    summary.uniquePathCount = paths.length;
  } catch (error) {
    summary.errorCode = String(error && error.code || 'query-failed').slice(0, 80);
  }
  return summary;
}

function nativeWorkBuddyDiscoverySummary() {
  return nativeDiscoveryState ? { ...nativeDiscoveryState } : { completed: false };
}

function nativeWorkBuddyRunning() {
  const result = runNativeHelper(['--check-workbuddy', '--profile', PROFILE.id]);
  if (result.status === 10) return true;
  if (result.status !== 0) throw new Error('原生 WorkBuddy 进程检测失败（错误码 ' + result.status + '）');
  return false;
}

function stopNativeWorkBuddy() {
  const result = runNativeHelper(['--terminate-workbuddy', '--profile', PROFILE.id], { timeout: 60000 });
  if (result.status !== 0) {
    throw new Error('无法精确重启当前 WorkBuddy（错误码 ' + result.status + '）');
  }
}

function findWorkBuddyNative() {
  const candidates = [];
  const summary = {
    completed: false,
    nativeProcessCount: 0,
    explicitCandidateCount: 0,
    registeredCandidateCount: 0,
    portableCandidateCount: 0,
    scannedCandidateCount: 0,
    validCandidateCount: 0,
  };
  nativeDiscoveryState = summary;
  const add = (value, source) => {
    const candidate = String(value || '').trim().replace(/^"(.*)"(?:,\d+)?$/, '$1').replace(/,\d+$/, '');
    if (!candidate || candidates.some((item) => sameWindowsPath(item.path, candidate))) return;
    candidates.push({ path: candidate, source });
    const key = source + 'CandidateCount';
    if (Object.hasOwn(summary, key)) summary[key] += 1;
  };
  try {
    const result = runNativeHelper(['--list-workbuddy', '--profile', PROFILE.id]);
    summary.nativeProcessQueryStatus = result.status;
    if (result.status === 0) {
      const rows = JSON.parse(String(result.stdout || '[]'));
      if (Array.isArray(rows)) {
        summary.nativeProcessCount = rows.length;
        for (const row of rows) add(row && row.path, 'explicit');
      }
    }
  } catch (error) {
    summary.nativeProcessQueryError = String(error && error.code || 'query-failed').slice(0, 80);
  }
  add(process.env.WBSWITCH_WORKBUDDY_BIN, 'explicit');
  add(PROFILE.appPath, 'explicit');
  const local = process.env.LOCALAPPDATA || '';
  const programFiles = process.env.ProgramFiles || '';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || '';
  const expectedNames = [...PROFILE_BINARY_NAMES];
  const expectedName = expectedNames[0];
  if (process.env.WBSWITCH_WORKBUDDY_DIR) {
    for (const name of expectedNames) add(path.join(process.env.WBSWITCH_WORKBUDDY_DIR, name), 'explicit');
  }
  const appPathNames = PROFILE.customTarget ? [] : (PROFILE.id === 'workbuddy-ai' ? ['WorkBuddyAI.exe'] : ['WorkBuddy.exe']);
  const appPathKeys = [];
  for (const name of appPathNames) {
    appPathKeys.push(`HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${name}`);
    appPathKeys.push(`HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${name}`);
  }
  const appPathCommand = "$k=@(" + appPathKeys.map(powershellLiteral).join(',') + "); Get-ItemProperty $k -ErrorAction SilentlyContinue | ForEach-Object { if ($_.'(default)') { $_.'(default)' } elseif ($_.Path) { Join-Path $_.Path " + powershellLiteral(expectedName) + " } }";
  for (const candidate of bestEffortPowerShellLines(appPathCommand, 'App Paths')) add(candidate, 'registered');
  const uninstallCommand = "$k=@('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'); Get-ItemProperty $k -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'WorkBuddy' } | ForEach-Object { if($_.DisplayIcon){ ($_.DisplayIcon -replace ',.*$','').Trim() } elseif($_.InstallLocation){ Join-Path $_.InstallLocation " + powershellLiteral(expectedName) + " } }";
  for (const candidate of bestEffortPowerShellLines(uninstallCommand, '卸载注册表')) add(candidate, 'registered');
  if (PROFILE.id === 'workbuddy-ai') {
    add(path.join(local, 'Programs', 'WorkBuddyAI', 'WorkBuddyAI.exe'), 'portable');
    add(path.join(local, 'Programs', 'WorkBuddy AI', 'WorkBuddyAI.exe'), 'portable');
    add(path.join(programFiles, 'WorkBuddyAI', 'WorkBuddyAI.exe'), 'portable');
    add(path.join(programFiles, 'WorkBuddy AI', 'WorkBuddyAI.exe'), 'portable');
    add(path.join(programFilesX86, 'WorkBuddyAI', 'WorkBuddyAI.exe'), 'portable');
    add(path.join(programFilesX86, 'WorkBuddy AI', 'WorkBuddyAI.exe'), 'portable');
  } else {
    add(path.join(local, 'Programs', 'WorkBuddy', 'WorkBuddy.exe'), 'portable');
    add(path.join(programFiles, 'WorkBuddy', 'WorkBuddy.exe'), 'portable');
    add(path.join(programFilesX86, 'WorkBuddy', 'WorkBuddy.exe'), 'portable');
  }
  const driveRoots = bestEffortPowerShellLines('(Get-PSDrive -PSProvider FileSystem).Root', '磁盘根目录');
  for (const root of driveRoots) {
    add(path.join(root, 'Software', PROFILE.id === 'workbuddy-ai' ? 'workbuddy-ai' : 'workbuddy', expectedName), 'portable');
    add(path.join(root, PROFILE.id === 'workbuddy-ai' ? 'WorkBuddyAI' : 'WorkBuddy', expectedName), 'portable');
  }
  const scanDirs = PROFILE.id === 'workbuddy-ai'
    ? [path.join(local, 'Programs', 'WorkBuddyAI'), path.join(local, 'Programs', 'WorkBuddy AI'), path.join(local, 'WorkBuddyAI')]
    : [path.join(local, 'Programs', 'WorkBuddy'), path.join(local, 'WorkBuddy'), path.join(process.env.APPDATA || '', 'WorkBuddy')];
  const scanCommand = [
    '$roots=@(' + scanDirs.map(powershellLiteral).join(',') + ')',
    'foreach($root in $roots){',
    'if(-not (Test-Path -LiteralPath $root -PathType Container)){continue}',
    'Get-ChildItem -LiteralPath $root -File -Recurse -Depth 5 -ErrorAction SilentlyContinue | Where-Object { $_.Name -ieq ' + powershellLiteral(expectedName) + ' } | Select-Object -ExpandProperty FullName',
    '}',
  ].join('; ');
  for (const candidate of bestEffortPowerShellLines(scanCommand, '安装目录扫描')) add(candidate, 'scanned');
  for (const item of candidates) {
    try {
      if (!fs.statSync(item.path).isFile()) continue;
      if (!PROFILE_BINARY_NAMES.has(path.win32.basename(item.path).toLowerCase())) continue;
      if (PROFILE.customTarget && !sameWindowsPath(path.win32.dirname(item.path), path.win32.dirname(PROFILE.appPath))) continue;
      summary.validCandidateCount += 1;
      summary.selectedSource = item.source;
      summary.completed = true;
      return fs.realpathSync.native(item.path);
    } catch (_) {}
  }
  summary.completed = true;
  return null;
}

async function stopVerifiedLegacyManagedLifecycle(bundledNode) {
  const legacyNode = findNode();
  if (!legacyNode || sameWindowsPath(legacyNode, bundledNode)) return false;
  await stopDaemonByPort(legacyNode);
  log('已通过验证边界停止旧托管 Node 的当前 profile 生命周期');
  return true;
}

async function nativeDaemonDiagnostics() {
  const result = {
    uiPort: UI_PORT,
    watchdogAttempts: nativeWatchdogAttempts.map((item) => ({ ...item })),
    watchdogPidFile: { present: false, valid: false, pid: null },
    daemonLockFile: { present: false },
  };
  try {
    result.listeners = listenerPids(UI_PORT);
  } catch (error) {
    result.listenerErrorCode = String(error && error.code || 'query-failed').slice(0, 80);
  }
  try {
    const pid = readWatchdogPid();
    result.watchdogPidFile = { present: pid !== null, valid: pid !== null, pid };
  } catch (_) {
    result.watchdogPidFile = { present: true, valid: false, pid: null };
  }
  try { result.daemonLockFile.present = fs.existsSync(path.join(DATA_DIR, '.daemon.lock')); } catch (_) {}
  try {
    const status = await readStatus();
    const identity = readDaemonIdentity();
    result.status = status ? {
      reachable: true,
      ok: status.ok === true,
      pid: Number.isSafeInteger(status.pid) ? status.pid : null,
      profileMatches: Boolean(status.profile && status.profile.id === PROFILE.id),
      dataDirMatches: Boolean(status.dataDir && sameWindowsPath(status.dataDir, DATA_DIR)),
      versionMatches: status.version === identity.version,
      buildMatches: status.buildId === identity.buildId,
      privilege: String(status.privilege || 'unknown').slice(0, 32),
    } : { reachable: false };
    result.statusPidMatchesListener = Boolean(status && Array.isArray(result.listeners) && result.listeners.length === 1 && status.pid === result.listeners[0]);
  } catch (error) {
    result.status = { reachable: false, errorCode: String(error && error.code || 'invalid-response').slice(0, 80) };
  }
  return result;
}

async function nativeCdpDiagnostics() {
  const ports = await Promise.all(cdpPortCandidates().map(async (port) => {
    const [version, targets] = await Promise.all([httpGet(port, '/json/version'), httpGet(port, '/json/list')]);
    let targetCount = null;
    let profileTarget = false;
    if (targets && targets.status === 200) {
      try {
        const rows = JSON.parse(targets.body || '[]');
        if (Array.isArray(rows)) {
          targetCount = rows.length;
          profileTarget = rows.some((target) => isTargetForProfile(target, PROFILE));
        }
      } catch (_) {}
    }
    return {
      port,
      versionStatus: version ? version.status : null,
      targetsStatus: targets ? targets.status : null,
      targetCount,
      profileTarget,
    };
  }));
  return { ports, launch: nativeLaunchState ? { ...nativeLaunchState } : null };
}

function nativeDaemonStatusMatches(status) {
  const identity = readDaemonIdentity();
  return Boolean(
    status && status.ok === true &&
    status.profile && status.profile.id === PROFILE.id &&
    status.dataDir && sameWindowsPath(status.dataDir, DATA_DIR) &&
    status.version === identity.version &&
    status.buildId === identity.buildId &&
    status.privilege === 'standard'
  );
}

async function waitForNativeDaemon(attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(250);
    const status = await readStatus();
    if (nativeDaemonStatusMatches(status)) return status;
  }
  return null;
}

function stopNativeLifecycle() {
  const result = runNativeHelper([
    '--stop-lifecycle', '--profile', PROFILE.id, '--app-dir', WORKDADDY_APP_DIR,
  ], { timeout: 30000 });
  if (result.status !== 0) {
    const detail = String(result.stderr || '').trim();
    throw new Error('无法停止旧版 WorkDaddy 后台进程（错误码 ' + result.status + '）' + (detail ? ': ' + detail : ''));
  }
}

async function ensureDaemonNative(nodeBin) {
  fs.mkdirSync(path.join(DATA_DIR, 'accounts'), { recursive: true });
  let status = await readStatus();
  if (status && nativeDaemonStatusMatches(status)) {
    log('daemon profile、版本、构建和标准权限均已验证，跳过启动');
    return true;
  }
  if (status) {
    log('daemon 身份或版本不匹配，先检查旧托管 Node 生命周期');
    await stopVerifiedLegacyManagedLifecycle(nodeBin);
    stopNativeLifecycle();
    await sleep(800);
  }

  const startWatchdog = () => {
    log('通过内置 Node 启动无 CIM watchdog: ' + nodeBin);
    const attempt = { attempt: nativeWatchdogAttempts.length + 1, pid: null, errorCode: null, exitCode: null, signal: null };
    nativeWatchdogAttempts.push(attempt);
    const child = spawn(nodeBin, [WATCHDOG_SCRIPT], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
    attempt.pid = Number.isSafeInteger(child.pid) ? child.pid : null;
    child.once('error', (error) => { attempt.errorCode = String(error && error.code || 'spawn-error').slice(0, 80); });
    child.once('exit', (code, signal) => {
      attempt.exitCode = Number.isInteger(code) ? code : null;
      attempt.signal = signal ? String(signal).slice(0, 32) : null;
    });
    child.unref();
  };
  startWatchdog();
  status = await waitForNativeDaemon();
  if (status) return true;

  // A previous watchdog may own the OS lock while its daemon is unhealthy.
  // Stop only the PID whose executable path is the bundled node, then retry once.
  log('首次等待 daemon 超时，原生 helper 清理精确 lifecycle 后重试');
  await stopVerifiedLegacyManagedLifecycle(nodeBin);
  stopNativeLifecycle();
  await sleep(800);
  startWatchdog();
  status = await waitForNativeDaemon();
  if (status) return true;
  const error = new Error('等待 WorkDaddy 后台服务启动超时');
  error.sentryStage = 'windows-native-launcher-daemon-timeout';
  error.sentryExtra = { daemon: await nativeDaemonDiagnostics() };
  throw error;
}

async function waitForWorkBuddyCdpNative(binary) {
  let restartedAfterHandoff = false;
  let launchStartedAt = 0;
  const start = () => {
    nativeLaunchState = launchWorkBuddy(binary);
    launchStartedAt = Date.now();
    log('WorkBuddy 启动请求已派发 method=' + nativeLaunchState.method + ' expectedPort=' + CDP_PORT +
      (nativeLaunchState.pid ? ' pid=' + nativeLaunchState.pid : ''));
  };
  start();
  const deadline = Date.now() + CDP_STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(1000);
    for (const port of cdpPortCandidates()) {
      if (await isWorkBuddyCdpAt(port)) {
        CDP_PORT = port;
        process.env.WBSWITCH_CDP_PORT = String(port);
        writeCdpPortFile(port);
        return true;
      }
    }
    if (nativeLaunchFailed(nativeLaunchState)) {
      if (!restartedAfterHandoff && nativeWorkBuddyRunning()) {
        restartedAfterHandoff = true;
        log('WorkBuddy 启动进程异常退出但同 profile 进程仍在运行，精确停止后重试一次');
        stopNativeWorkBuddy();
        await sleep(1000);
        start();
        continue;
      }
      const error = new Error('WorkBuddy 启动进程异常退出' +
        (nativeLaunchState.errorCode ? '（' + nativeLaunchState.errorCode + '）' : '（退出码 ' + nativeLaunchState.exitCode + '）'));
      error.sentryStage = 'windows-native-launcher-workbuddy-exit';
      error.sentryExtra = {
        cdpPort: CDP_PORT,
        launch: { ...nativeLaunchState },
        processes: nativeWorkBuddyProcessSummary(),
        discovery: nativeWorkBuddyDiscoverySummary(),
      };
      throw error;
    }
    if (!restartedAfterHandoff && Number.isInteger(nativeLaunchState && nativeLaunchState.exitCode) &&
        Date.now() - launchStartedAt >= 5000 && nativeWorkBuddyRunning()) {
      restartedAfterHandoff = true;
      log('WorkBuddy 启动请求已被无 CDP 的单实例接管，精确停止后重试一次');
      stopNativeWorkBuddy();
      await sleep(1000);
      start();
    }
  }
  return false;
}

function nativeLaunchFailed(state) {
  return Boolean(state && (
    state.errorCode ||
    (Number.isInteger(state.exitCode) && state.exitCode !== 0)
  ));
}

async function nativeStartupMain() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
  log('原生启动入口: scripts=' + SCRIPTS_DIR + ' data=' + DATA_DIR + ' pid=' + process.pid);
  const nodeBin = path.join(SCRIPTS_DIR, 'runtime', 'node', 'node.exe');
  if (!fs.existsSync(nodeBin)) throw new Error('安装文件不完整：缺少内置 Node.js');

  await configureCdpPort();
  await configureUiPort();
  verifyConfiguredWorkBuddyVersion(PROFILE.appPath);
  let wb = null;
  if (!(await isWorkBuddyCdp())) {
    wb = findWorkBuddyNative();
    if (!wb) {
      const error = new Error('未找到安装时选择的 WorkBuddy 客户端；请重新运行 WorkDaddy 安装程序修改路径');
      error.sentryStage = 'windows-native-launcher-workbuddy-path';
      error.sentryExtra = {
        discovery: nativeWorkBuddyDiscoverySummary(),
        processes: nativeWorkBuddyProcessSummary(),
      };
      throw error;
    }
  }
  await ensureDaemonNative(nodeBin);

  if (await isWorkBuddyCdp()) {
    await injectNowOrPending();
    log('WorkBuddy 已在 CDP 模式，组件注入已请求');
    return 0;
  }

  if (nativeWorkBuddyRunning()) {
    log('WorkBuddy 已运行但没有 CDP，按当前 profile 的唯一真实路径精确重启');
    stopNativeWorkBuddy();
    await sleep(1000);
  }

  const ok = await waitForWorkBuddyCdpNative(wb);
  if (!ok) {
    await captureMessage('等待 WorkBuddy CDP 端口超时', {
      stage: 'windows-native-launcher-cdp-timeout',
      extra: {
        cdpPort: CDP_PORT,
        timeoutMs: CDP_STARTUP_TIMEOUT_MS,
        cdp: await nativeCdpDiagnostics(),
        processes: nativeWorkBuddyProcessSummary(),
        discovery: nativeWorkBuddyDiscoverySummary(),
      },
    }).catch(() => {});
    return 3;
  }
  await sleep(1200);
  await injectNowOrPending();
  log('WorkBuddy 已由原生入口启动，组件注入已请求');
  return 0;
}

// ---------- legacy script entry ----------

// ---------- main ----------
if (require.main === module && process.env.WBSWITCH_NATIVE_LAUNCHER === '1') {
  nativeStartupMain().then((code) => process.exit(code)).catch((error) => {
    log('原生启动路径异常: ' + (error && error.stack || error));
    console.error(error && error.message || error);
    captureException(error, {
      stage: error && error.sentryStage || 'windows-native-launcher-uncaught',
      extra: error && error.sentryExtra || {},
    })
      .catch(() => {}).finally(() => process.exit(4));
  });
} else if (require.main === module) (async () => {
  // 入口级 breadcrumb 必须先于 Node/PowerShell/进程探测写出，避免管理员启动时
  // 探测耗时让 Windows Terminal 看起来像“空白无响应”；同一行也会落到 launcher.log。
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
  log('启动入口: scripts=' + SCRIPTS_DIR + ' data=' + DATA_DIR + ' pid=' + process.pid);
  const nodeBin = findNode();
  if (!nodeBin) {
    log('未找到 Node.js（需 .workbuddy\\binaries 托管 node 或 PATH 中的 node）');
    console.error('错误：未找到 Node.js。请先安装 Node.js 或安装 WorkBuddy（自带托管 node）。');
    await reportAndExit(1, '未找到 Node.js（WorkBuddy 托管运行时或 PATH）', 'windows-launcher-node');
    return;
  }
  if (process.platform === 'win32' && WINDOWS_PRIVILEGE === 'elevated') {
    if (!process.argv.includes(DESKTOP_RELAUNCH_ARG)) {
      relaunchWithDesktopShell(nodeBin);
      log('管理员入口已通过桌面 Shell 重新派发；当前 elevated launcher 退出');
      process.exit(0);
    }
    log('桌面 Shell 仍返回 elevated token（可能已关闭 UAC），拒绝继续启动管理员权限 WorkDaddy');
    showWindowsMessageBox(WBS_BRAND, '无法自动降回普通用户权限，已拒绝启动管理员权限 WorkDaddy。请开启 UAC 后双击快捷方式重试。');
    process.exit(5);
  }
  await configureCdpPort();
  await configureUiPort();

  await ensureDaemon(nodeBin);

  // 已在 CDP 模式 → 幂等注入
  if (await isWorkBuddyCdp()) {
    if (!(await injectNowOrPending())) process.exit(0);
    log('WorkBuddy 已在调试模式（端口 ' + CDP_PORT + '），组件已注入');
    console.log(WBS_BRAND + '：WorkBuddy 已在调试模式，组件已注入 ✓');
    process.exit(0);
  }

  // 未开 CDP → 需要重启 WorkBuddy 带调试端口
  const wb = findWorkBuddy();
  if (!wb) {
    console.error('未找到 WorkBuddy.exe。可用环境变量 WBSWITCH_WORKBUDDY_BIN 指定完整路径。');
    log('未找到 WorkBuddy.exe');
    await reportAndExit(2, '未找到 WorkBuddy.exe', 'windows-launcher-workbuddy-path');
    return;
  }

  log('重启 WorkBuddy（带 --remote-debugging-port=' + CDP_PORT + '，GUI 继承当前启动权限）: ' + wb);
  console.log('正在以调试模式重启 WorkBuddy（约几秒）...');
  showWindowsNotification('WorkBuddy', '正在打开 WorkBuddy，请稍等…');

  // 只在当前普通权限上下文中结束经过绝对路径验证的 PID。若目标以更高完整性
  // 运行或 CIM 无法证明路径，quitWorkBuddy 会 fail closed，不再执行用户可写的 UAC 脚本。
  await quitWorkBuddy(wb);
  await sleep(1000);
  const ok = await waitForWorkBuddyCdp(wb);
  if (ok) {
    await sleep(1500);
    if (!(await injectNowOrPending())) process.exit(0);
    log('WorkBuddy 已启动（调试模式），组件已注入');
    console.log(WBS_BRAND + '：WorkBuddy 已启动（调试模式），组件已注入 ✓');
  } else {
    log('等待 ' + (CDP_STARTUP_TIMEOUT_MS / 1000) + ' 秒未检测到调试端口 ' + CDP_PORT);
    console.log('等待超时：未检测到调试端口 ' + CDP_PORT + '。可手动执行：cd /d ' + path.dirname(wb) + ' && "' + wb + '" --remote-debugging-port=' + CDP_PORT);
    await captureMessage('等待 ' + (CDP_STARTUP_TIMEOUT_MS / 1000) + ' 秒未检测到 WorkBuddy CDP 端口', {
      stage: 'windows-launcher-cdp-timeout',
      extra: { cdpPort: CDP_PORT, workBuddy: wb, timeoutMs: CDP_STARTUP_TIMEOUT_MS, processes: processDiagnostics(wb) },
    }).catch(() => {});
  }
  process.exit(ok ? 0 : 3);
})().catch((e) => {
  log('launcher 异常: ' + (e && e.stack || e));
  console.error(WBS_BRAND + ' 启动异常: ' + (e && e.message || e));
  showWindowsMessageBox(WBS_BRAND, '启动失败：' + (e && e.message || e) + '\n\n详细信息已写入 launcher.log。');
  captureException(e, { stage: 'windows-launcher-uncaught' }).catch(() => {}).finally(() => process.exit(4));
});

module.exports = {
  nativeLaunchFailed,
  strictPowerShellLines,
  getWorkBuddyProcesses,
  workBuddyProcesses,
  requireWorkBuddyClosedBeforeLaunch,
  showWindowsMessageBox,
  showWindowsNotification,
  tasklistProcessIds,
  workBuddyRunning,
  cdpPortCandidates,
};
