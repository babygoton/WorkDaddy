#!/usr/bin/env node
/**
 * WorkDaddy Windows 启动器（macOS launcher 的 Windows 对应物，node 实现）
 *
 * 幂等三步：
 *   1) 确保 daemon 运行 —— watchdog 常驻（崩溃自动拉起）；daemon 版本与内置不一致时强制重启
 *   2) WorkBuddy 已在 CDP 模式（优先 9222，端口被占用时自动发现）→ 直接注入组件即完成
 *   3) 否则退出 WorkBuddy 并以自动选择的 CDP 端口重启 → 等端口 → 注入
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
const { captureMessage, captureException } = require('./sentry-report.js');

const SCRIPTS_DIR = __dirname;
const DATA_DIR =
  process.env.WBSWITCH_DATA_DIR ||
  path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'WorkDaddy');
const UI_PORT = parseInt(process.env.WBSWITCH_PORT || '47832', 10);
const cliCdpPort = process.argv.find((arg) => /^--cdp-port=\d+$/i.test(arg));
let CDP_PORT = parseInt(process.env.WBSWITCH_CDP_PORT || (cliCdpPort ? cliCdpPort.split('=')[1] : '') || '0', 10);
const CDP_PORT_FILE = path.join(DATA_DIR, 'cdp-port.json');
const ELEVATED_HELPER_MODE = process.argv.includes('--inject-helper');
// 便携版/低速磁盘上的 WorkBuddy 首次启动可能超过 20 秒；超时只应在足够长的窗口后报告。
const CDP_STARTUP_TIMEOUT_MS = 60000;

function log(...args) {
  const line = `[launcher] ${new Date().toISOString()} ${args.join(' ')}\n`;
  try { process.stdout.write(line); } catch (_) {}
  try { fs.appendFileSync(path.join(DATA_DIR, 'launcher.log'), line); } catch (_) {}
}

// ---------- 小工具 ----------
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

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
  const add = (port) => { if (validCdpPort(port) && !result.includes(port)) result.push(port); };
  add(CDP_PORT);
  add(readCdpPortFile());
  for (let port = 9222; port <= 9232; port++) add(port);
  add(9333);
  return result;
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

function isLocalPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port }, () => {
      server.close(() => resolve(true));
    });
  });
}

function httpGet(port, p) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 1500 }, (res) => {
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
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', timeout: 1500 }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

async function findRunningCdpPort() {
  for (const port of cdpPortCandidates()) {
    if (await isWorkBuddyCdpAt(port)) return port;
  }
  return null;
}

async function isWorkBuddyCdp() {
  const port = await findRunningCdpPort();
  if (port) {
    if (CDP_PORT !== port) {
      CDP_PORT = port;
      writeCdpPortFile(port);
      log('已切换至活跃 CDP 端口: ' + port);
    }
    return true;
  }
  return false;
}

async function isWorkBuddyCdpAt(port) {
  const version = await httpGet(port, '/json/version');
  if (!version || version.status !== 200) return false;
  try {
    const info = JSON.parse(version.body || '{}');
    return /workbuddy|codebuddy/i.test([info.Browser, info['User-Agent']].filter(Boolean).join(' '));
  } catch (_) { return false; }
}

async function configureCdpPort() {
  for (const port of cdpPortCandidates()) {
    if (await isWorkBuddyCdpAt(port)) {
      CDP_PORT = port;
      writeCdpPortFile(port);
      log('发现 WorkBuddy CDP 端口: ' + port);
      return port;
    }
  }
  for (const port of cdpPortCandidates()) {
    if (await isLocalPortAvailable(port)) {
      CDP_PORT = port;
      writeCdpPortFile(port);
      log('选择空闲 CDP 端口: ' + port);
      return port;
    }
  }
  throw new Error('9222-9232、9333 均被占用，无法启动 WorkBuddy CDP');
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

// ---------- 定位 node（托管优先：.workbuddy\binaries\node\versions\<v>\node.exe，其次 PATH） ----------
function findNode() {
  const base = path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'versions');
  let verDirs = [];
  try {
    verDirs = fs.readdirSync(base)
      .map((d) => path.join(base, d, 'node.exe'))
      .filter((p) => fs.existsSync(p))
      .sort();
  } catch (_) {}
  if (verDirs.length) return verDirs[verDirs.length - 1];
  try {
    const r = spawnSync('node', ['-v'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
    if (r.status === 0) return 'node';
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
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch (_) {}
    return null;
  };
  const envBin = tryFile(process.env.WBSWITCH_WORKBUDDY_BIN);
  if (envBin) return (wbBinaryCache = envBin);
  try {
    const p = psOut('Get-Process WorkBuddy -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path').split(/\r?\n/).filter(Boolean).pop();
    const hit = tryFile(p);
    if (hit) return (wbBinaryCache = hit);
  } catch (_) {}
  try {
    const p = psOut("Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^(WorkBuddy|CodeBuddy|WorkBuddyAI)\\.exe$' -and $_.ExecutablePath } | Select-Object -First 1 -ExpandProperty ExecutablePath").split(/\r?\n/).filter(Boolean).pop();
    const hit = tryFile(p);
    if (hit) return (wbBinaryCache = hit);
  } catch (_) {}
  // 2.5) 桌面快捷方式（最准确直接：用户桌面上已有的 WorkBuddy/WorkBuddy AI 快捷方式指向的真实路径）
  try {
    const cmd = "$s = New-Object -ComObject WScript.Shell; $d = @($([Environment]::GetFolderPath('Desktop')), $([Environment]::GetFolderPath('CommonDesktopDirectory'))); (Get-ChildItem -Path $d -Filter '*WorkBuddy*.lnk' -ErrorAction SilentlyContinue | ForEach-Object { $s.CreateShortcut($_.FullName).TargetPath } | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1)";
    const p = psOut(cmd).split(/\r?\n/).filter(Boolean).pop();
    const hit = tryFile(p);
    if (hit) return (wbBinaryCache = hit);
  } catch (_) {}
  // 便携版通常没有卸载项，但可能注册了 App Paths；优先读取其真实可执行路径。
  try {
    const p = psOut("$k=@('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\WorkBuddy.exe','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\WorkBuddy.exe','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\WorkBuddyAI.exe','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\WorkBuddyAI.exe','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\CodeBuddy.exe','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\CodeBuddy.exe'); Get-ItemProperty $k -ErrorAction SilentlyContinue | ForEach-Object { if ($_.'(default)') { $_.'(default)' } elseif ($_.Path) { $_.Path } } | Select-Object -First 1").split(/\r?\n/).filter(Boolean).pop();
    const hit = tryFile(p);
    if (hit) return (wbBinaryCache = hit);
  } catch (_) {}
  try {
    const p = psOut("$k=@('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'); Get-ItemProperty $k -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'WorkBuddy|CodeBuddy' } | Select-Object -First 1 DisplayIcon,InstallLocation | ForEach-Object { if($_.DisplayIcon){ ($_.DisplayIcon -replace ',.*$','').Trim() } elseif($_.InstallLocation){ Join-Path $_.InstallLocation 'WorkBuddy.exe' } }").split(/\r?\n/).filter(Boolean).pop();
    const hit = tryFile(p);
    if (hit) return (wbBinaryCache = hit);
  } catch (_) {}
  const roots = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'WorkBuddy', 'WorkBuddy.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'WorkBuddyAI', 'WorkBuddyAI.exe'),
    path.join(process.env.ProgramFiles || '', 'WorkBuddy', 'WorkBuddy.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'WorkBuddy', 'WorkBuddy.exe'),
    path.join(process.env.USERPROFILE || '', 'scoop', 'apps', 'workbuddy', 'current', 'WorkBuddy.exe'),
    'D:\\software\\common\\WorkBuddyAI\\WorkBuddyAI.exe',
    'D:\\workbuddy\\WorkBuddy.exe',
  ];
  if (process.env.WBSWITCH_WORKBUDDY_DIR) {
    roots.push(path.join(process.env.WBSWITCH_WORKBUDDY_DIR, 'WorkBuddy.exe'));
    roots.push(path.join(process.env.WBSWITCH_WORKBUDDY_DIR, 'WorkBuddyAI.exe'));
  }
  // 兼容类似 D:\Software\workbuddy\WorkBuddy.exe 的便携目录，不递归扫描整盘。
  try {
    const driveRoots = psOut('(Get-PSDrive -PSProvider FileSystem).Root').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    for (const root of driveRoots) {
      roots.push(path.join(root, 'software', 'common', 'WorkBuddyAI', 'WorkBuddyAI.exe'));
      roots.push(path.join(root, 'Software', 'workbuddy', 'WorkBuddy.exe'));
      roots.push(path.join(root, 'Software', 'WorkBuddyAI', 'WorkBuddyAI.exe'));
      roots.push(path.join(root, 'workbuddy', 'WorkBuddy.exe'));
      roots.push(path.join(root, 'WorkBuddy', 'WorkBuddy.exe'));
      roots.push(path.join(root, 'WorkBuddyAI', 'WorkBuddyAI.exe'));
    }
  } catch (_) {}
  for (const c of roots) {
    const hit = tryFile(c);
    if (hit) return (wbBinaryCache = hit);
  }
  return null;
}

// ---------- 1. 确保 daemon 运行 ----------
function watchdogAlive() {
  try {
    const pid = parseInt(fs.readFileSync(path.join(DATA_DIR, 'watchdog.pid'), 'utf8').trim(), 10);
    if (!pid) return false;
    const r = spawnSync('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    return r.status === 0 && /node/i.test(r.stdout);
  } catch (_) { return false; }
}

async function daemonRunning() {
  const st = await httpGet(UI_PORT, '/api/status');
  return !!(st && st.status === 200);
}

async function ensureDaemon(nodeBin) {
  fs.mkdirSync(path.join(DATA_DIR, 'accounts'), { recursive: true });
  // 已有 daemon：检查版本一致性（旧版本代码继续注入会出兼容问题）
  const st = await httpGet(UI_PORT, '/api/status');
  if (st && st.status === 200) {
    let runningVer = '';
    try { runningVer = (JSON.parse(st.body).version || ''); } catch (_) {}
    const want = readDaemonVersion();
    if (runningVer === want) {
      log('daemon 已在运行且版本一致 (' + runningVer + ')，跳过启动');
      return true;
    }
    log('检测到旧版 daemon (' + runningVer + ' != ' + want + ')，强制重启');
    stopDaemonByPort();
  } else if (watchdogAlive()) {
    log('watchdog 在运行但 daemon 未就绪，等待其拉起...');
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      if (await daemonRunning()) { log('daemon 已就绪'); return true; }
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
    if (await daemonRunning()) { log('daemon 已就绪'); return true; }
  }
  log('等待 daemon 就绪超时');
  return await daemonRunning();
}

function stopDaemonByPort() {
  // 杀 watchdog（会连带杀 daemon）→ 兜底按端口杀
  try {
    const pid = parseInt(fs.readFileSync(path.join(DATA_DIR, 'watchdog.pid'), 'utf8').trim(), 10);
    if (pid) spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    try { fs.unlinkSync(path.join(DATA_DIR, 'watchdog.pid')); } catch (_) {}
  } catch (_) {}
  // 兜底：杀监听 UI 端口的进程
  const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8', timeout: 8000, windowsHide: true }).stdout || '';
  const lines = out.split(/\r?\n/).filter((l) => l.includes(':' + UI_PORT) && /LISTENING/i.test(l));
  const pids = new Set();
  for (const l of lines) {
    const m = l.trim().split(/\s+/);
    const pid = m[m.length - 1];
    if (pid && /^\d+$/.test(pid)) pids.add(pid);
  }
  for (const pid of pids) {
    spawnSync('taskkill', ['/F', '/T', '/PID', pid], { stdio: 'ignore', windowsHide: true });
  }
  return pids.size > 0;
}

// ---------- 2/3. WorkBuddy CDP 处理 ----------
// 国内版与 AI 国际版主进程镜像名不同（WorkBuddy.exe / WorkBuddyAI.exe，真机确认）。
// 安装/更新生命周期可能遇到任意一个版本，两个精确镜像名都探测，不做宽泛匹配。
const WORKBUDDY_IMAGE_NAMES = ['WorkBuddy.exe', 'WorkBuddyAI.exe'];

function workBuddyImageRunning(name) {
  const r = spawnSync(
    'tasklist',
    ['/FI', 'IMAGENAME eq ' + name, '/FO', 'CSV', '/NH'],
    { encoding: 'utf8', timeout: 5000, windowsHide: true }
  );
  return r.status === 0 && new RegExp('"' + name.replace('.', '\\.') + '"', 'i').test(r.stdout || '');
}

function workBuddyRunning() {
  try {
    return WORKBUDDY_IMAGE_NAMES.some(workBuddyImageRunning);
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

async function waitForWorkBuddyExit(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!workBuddyRunning()) return true;
    await sleep(200);
  }
  return !workBuddyRunning();
}

function restoreWorkBuddyWindow() {
  const source = [
    'using System;',
    'using System.Text;',
    'using System.Runtime.InteropServices;',
    'public static class WorkDaddyWindowBridge {',
    '  delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);',
    '  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);',
    '  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);',
    '  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);',
    '  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);',
    '  [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr hWnd, int command);',
    '  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);',
    '  public static void RestoreMainWindow() {',
    '    EnumWindows((hWnd, lParam) => {',
    '      uint owner;',
    '      GetWindowThreadProcessId(hWnd, out owner);',
    '      try {',
    '        var p = System.Diagnostics.Process.GetProcessById((int)owner);',
    '        if (p != null && (p.ProcessName.IndexOf("WorkBuddy", StringComparison.OrdinalIgnoreCase) >= 0 || p.ProcessName.IndexOf("CodeBuddy", StringComparison.OrdinalIgnoreCase) >= 0)) {',
    '          StringBuilder sb = new StringBuilder(256);',
    '          GetWindowText(hWnd, sb, 256);',
    '          string title = sb.ToString();',
    '          if (!string.IsNullOrEmpty(title) && (title.IndexOf("WorkBuddy", StringComparison.OrdinalIgnoreCase) >= 0 || title.IndexOf("CodeBuddy", StringComparison.OrdinalIgnoreCase) >= 0)) {',
    // SW_RESTORE(9) 对最大化窗口会取消最大化；仅最小化时才还原，否则 SW_SHOW(5) 仅置前
    '            ShowWindowAsync(hWnd, IsIconic(hWnd) ? 9 : 5);',
    '            SetForegroundWindow(hWnd);',
    '            return false;',
    '          }',
    '        }',
    '      } catch {}',
    '      return true;',
    '    }, IntPtr.Zero);',
    '  }',
    '}',
  ].join('\n');
  const command = `Add-Type -TypeDefinition @'\n${source}\n'@; [WorkDaddyWindowBridge]::RestoreMainWindow()`;
  const encoded = Buffer.from(command, 'utf16le').toString('base64');
  try {
    spawnSync('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 8000,
    });
  } catch (_) {}
}

async function quitWorkBuddy() {
  if (!workBuddyRunning()) return true;
  for (const image of WORKBUDDY_IMAGE_NAMES) {
    await runTaskkill(['/F', '/T', '/IM', image]);
  }
  if (await waitForWorkBuddyExit(3000)) return true;
  return true;
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
      const shell = spawn('explorer.exe', [wb, args], { detached: true, stdio: 'ignore' });
      shell.unref();
      return true;
    } catch (e) {
      log('explorer.exe 启动 WorkBuddy 失败: ' + e.message);
    }
  }

  const child = spawn(wb, [args], { detached: true, stdio: 'ignore' });
  child.on('error', (e) => { log('启动 WorkBuddy 失败: ' + e.message); });
  child.unref();
  return true;
}

async function injectNow() {
  // daemon 的 /api/inject 是 POST
  try { await httpPost(UI_PORT, '/api/inject'); } catch (_) {}
}

// ---------- main ----------
(async () => {
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
  await configureCdpPort();

  // 提权助手接管时，先停掉普通权限启动的 watchdog/daemon，避免两个权限级别的
  // daemon 同时占用端口；WorkBuddy GUI 后续仍由 ShellExecute 以用户权限启动。
  if (ELEVATED_HELPER_MODE) {
    log('提权流程：接管普通权限 daemon');
    stopDaemonByPort();
    await sleep(800);
  }
  await ensureDaemon(nodeBin);

  // 已在 CDP 模式 → 幂等注入并置前窗口
  if (await isWorkBuddyCdp()) {
    restoreWorkBuddyWindow();
    await injectNow();
    log('WorkBuddy 已在调试模式（端口 ' + CDP_PORT + '），已置前窗口并注入组件');
    console.log('WorkDaddy：WorkBuddy 已在调试模式，已置前窗口并注入组件 ✓');
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

  if (workBuddyRunning()) {
    await quitWorkBuddy();
    await sleep(500);
  }

  // 仅当 WorkBuddy 仍在运行且无法被普通权限结束时（例如管理员残留进程），才请求 UAC 提权助手
  if (workBuddyRunning() && !isElevated()) {
    log('非管理员权限且存在特权残留进程：派发提权助手重启 WorkBuddy（唤醒 UAC）');
    console.log('需要管理员权限以重启 WorkBuddy 进入调试模式，正在请求授权...');
    if (spawnElevatedHelper()) {
      console.log('已发起提权请求，点击 UAC「是」后将自动完成重启与注入。');
      process.exit(0);
    }
    // 派发失败则仍退回当前进程尝试（容错）
    log('提权派发失败，退回当前进程直接重启');
  }

  log('启动 WorkBuddy（带 --remote-debugging-port=' + CDP_PORT + '）: ' + wb);
  console.log('正在以调试模式启动 WorkBuddy（约几秒）...');

  launchWorkBuddy(wb);

  let ok = false;
  for (let elapsedMs = 0; elapsedMs < CDP_STARTUP_TIMEOUT_MS; elapsedMs += 1000) {
    await sleep(1000);
    if (await isWorkBuddyCdp()) { ok = true; break; }
    if ((elapsedMs + 1000) % 5000 === 0) log('等待 WorkBuddy CDP: ' + (elapsedMs + 1000) + 'ms/' + CDP_STARTUP_TIMEOUT_MS + 'ms');
  }
  if (ok) {
    await sleep(1500);
    restoreWorkBuddyWindow();
    await injectNow();
    log('WorkBuddy 已启动（调试模式），已置前窗口并注入组件');
    console.log('WorkDaddy：WorkBuddy 已启动（调试模式），已置前窗口并注入组件 ✓');
  } else {
    log('等待 ' + (CDP_STARTUP_TIMEOUT_MS / 1000) + ' 秒未检测到调试端口 ' + CDP_PORT);
    console.log('等待超时：未检测到调试端口 ' + CDP_PORT + '。可手动执行：cd /d ' + path.dirname(wb) + ' && "' + wb + '" --remote-debugging-port=' + CDP_PORT);
    await captureMessage('等待 ' + (CDP_STARTUP_TIMEOUT_MS / 1000) + ' 秒未检测到 WorkBuddy CDP 端口', { stage: 'windows-launcher-cdp-timeout', extra: { cdpPort: CDP_PORT, workBuddy: wb, timeoutMs: CDP_STARTUP_TIMEOUT_MS } }).catch(() => {});
  }
  process.exit(ok ? 0 : 3);
})().catch((e) => {
  log('launcher 异常: ' + (e && e.stack || e));
  console.error('WorkDaddy 启动异常: ' + (e && e.message || e));
  captureException(e, { stage: 'windows-launcher-uncaught' }).catch(() => {}).finally(() => process.exit(4));
});
