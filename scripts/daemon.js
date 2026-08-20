#!/usr/bin/env node
/**
 * WorkBuddy 多账号切换器 - CDP 守护进程
 *
 * 方案：通过 Chrome DevTools Protocol (CDP) 直接连接正在运行的 WorkBuddy 桌面应用
 *  （Electron），监听其登录/认证网络事件与页面加载事件，自动把登录信息文件按
 *  account.uid 备份到稳定目录；提供本地 Web 界面一键切换登录账号（把备份复制回
 *  登录信息文件），切换后可通过 CDP 刷新应用窗口。
 *
 * 前提：WorkBuddy 需以 --remote-debugging-port 启动（见 scripts/relaunch-with-cdp.sh）。
 * 若未开启 CDP，守护进程自动降级为文件监听模式，基础备份/切换功能不受影响。
 *
 * 环境变量：
 *   WBSWITCH_AUTH_FILE   登录信息文件路径（默认 CodeBuddyExtension 下 auth/workbuddy-desktop.info）
 *   WBSWITCH_DATA_DIR    备份数据目录（默认 ~/Library/Application Support/WorkDaddy）
 *   WBSWITCH_PORT        Web 界面端口（默认 47832，被占用则 +1 尝试）
 *   WBSWITCH_CDP_PORT    WorkBuddy CDP 端口（默认自动探测 9222/9223/9333）
 *
 * 用法: node scripts/daemon.js
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
// ws（WebSocketServer）用于 DevTools 代理：Electron 的 CDP server 拒绝带 Origin 的 WS 连接
// （浏览器必带 Origin → DevTools 前端 "websocket disconnected"），daemon 代理中转去掉 Origin
let wsLib = null;
try { wsLib = require('ws'); } catch (_) {
  // 打包到 WorkDaddy.app 内的相对路径（开箱即用）
  const cands = [
    path.join(__dirname, 'node_modules', 'ws'),
    path.join(__dirname, '..', '..', 'scripts', 'node_modules', 'ws'),
    '/Users/h/.workbuddy/binaries/node/workspace/node_modules/ws',
    path.join(os.homedir(), '.workbuddy-ai', 'binaries', 'node', 'workspace', 'node_modules', 'ws'),
    path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules', 'ws'),
  ];
  for (const c of cands) {
    try { wsLib = require(c); break; } catch (_) {}
  }
}
// Node 22 提供全局 WebSocket，但 macOS 用户常见的 Node 18/20 没有；app 内置 ws 作为统一兜底。
const WebSocketCtor = globalThis.WebSocket || (wsLib && (wsLib.WebSocket || wsLib));
const {
  AUTH_FILE,
  defaultDataDir,
  logFile,
  ensureDirs,
  readAuthFile,
  backupCurrent,
  listAccounts,
  switchTo,
  deleteAccount,
  backupPath,
  updateMeta,
} = require('./lib.js');

const DATA_DIR = defaultDataDir();
// 版本号：改动 daemon/inject/theme-patches/builtin 资产后递增，launcher 检测到运行中版本不一致会强制用 app 内置代码重启
// 0.6.6：品牌 HelloBuddy→WorkDaddy 期间版本号未递增，旧 HelloBuddy daemon 会被 launcher 误判为"同版本"而不重启，导致旧代码继续注入；递增后强制升级
// 0.6.7：新增「关于」tab（/api/about + __WBS_VERSION__ 注入）；必须递增，否则旧 daemon 不重启、面板看不到关于页
// 0.6.8：关于页精简（只留版本 + GitHub 链接），仓库改为 github.com/babygoton/WorkDaddy，去掉 logo/原理/平台/运行时
// 1.0.0：正式统一版本号（Info.plist / daemon / dmg 对齐 1.0.0），关于页改单行紧凑布局
// 1.0.1：自动更新（业界标准链路：GitHub Releases API 检查 → dmg 下载+SHA256 校验 → 辅助脚本替换 → relaunch）
// 1.0.2：代码块容器 /.cb-markdown-pre-container 毛玻璃 + chat widget 容器毛玻璃 + 表头半透明（theme-patches patch-77/78）
// 1.0.3：欢迎页隐藏暂存提示词按钮（inject isWelcomePage）；chat widget 预览 iframe 背景透明（patch-80 + inject 同源注入兜底）；
//       默认主题改为「WorkBuddy 默认主题」（首次初始化/面板回退不再指向 nebula）
// 1.0.4：macOS dmg 打包修复（launcher 可执行位）
// 1.0.5：修复自动更新「缺少解包后的新应用」——下载阶段只落 .dmg 从未解包，
//       applyUpdate 现改为在安装前调用 extractAppFromDmg 解出 WorkDaddy.app（幂等），
//       解包函数亦增强（清理残留挂载点、只读挂载、校验 dmg 内存在 WorkDaddy.app）
// 1.0.5 发布后已合入：daemon 单实例/诊断/日志滚动、Node 18/20 WebSocket 兼容等修复。
// 1.0.6：打包上述修复，并增加 WorkBuddyAI 5.3.x 路径兼容、Windows 静默可靠启动、
//        本地 API 令牌与按资产 SHA-256 更新校验。
const DAEMON_VERSION = '1.0.6';
const DAEMON_BUILD_ID = 'workbuddyai-windows-hardening-20260821';
const HOST = '127.0.0.1';
const IS_WIN = process.platform === 'win32'; // Windows 移植：平台分支开关（macOS 行为保持不变）
// Windows 安装目录（install.ps1 铺、launcher 用、更新替换目标），对应 macOS 的 /Applications/WorkDaddy.app
const WORKDADDY_DIR_WIN = process.env.WBSWITCH_APP_DIR ||
  path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'WorkDaddy');
const UI_PORT_BASE = parseInt(process.env.WBSWITCH_PORT || '47832', 10);
let ACTUAL_PORT = UI_PORT_BASE; // 实际监听端口（被占用时 +1）
const CDP_PORT_HINT = process.env.WBSWITCH_CDP_PORT
  ? parseInt(process.env.WBSWITCH_CDP_PORT, 10)
  : null;
const API_TOKEN_FILE = path.join(DATA_DIR, 'api-token');
const WATCH_INTERVAL = 3000; // 文件监听兜底
const BACKUP_DEBOUNCE = 1500; // CDP 事件触发的备份防抖
const CDP_RECONNECT_MS = 5000;

/* ================= 自动更新（GitHub Releases 检查 + 下载 + 辅助脚本替换） =================
 * 业界标准（Sparkle 同款链路）：daemon 定时请求 GitHub Releases API 取最新 tag/资产，
 * 面板红点提示 → 用户点更新 → daemon 下载 dmg + SHA-256 校验 → 挂载拷贝出新 app →
 * 写 apply-update.sh 由独立脚本接管替换（运行中的 app 无法自删，必须由外部脚本完成）→ relaunch。
 */
const UPDATE_REPO = process.env.WBSWITCH_UPDATE_REPO || 'babygoton/WorkDaddy';
const UPDATE_API = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;
const UPDATE_CHECK_INTERVAL = 6 * 3600 * 1000; // 每 6 小时检查一次（GitHub 未认证限流 60 次/h）
const UPDATE_REQ_TIMEOUT = 10000; // 网络超时，超时静默失败不阻塞面板
const UPDATE_DIR = path.join(DATA_DIR, 'update'); // 下载/解包目录
const UPDATE_CHECK_CACHE = path.join(DATA_DIR, 'update-check.json');
// 更新状态机（面板轮询用）：idle | checking | downloading | verifying | installing | done | error
const updateState = {
  status: 'idle',
  latest: null,
  hasUpdate: false,
  downloaded: false,
  progress: 0, // 0-100
  message: '',
  error: null,
  sha256: null,
  checkedAt: 0,
};
let updateTimer = null;

function ensureApiToken() {
  try {
    const existing = fs.readFileSync(API_TOKEN_FILE, 'utf8').trim();
    if (/^[a-f0-9]{64}$/i.test(existing)) return existing;
  } catch (_) {}
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(API_TOKEN_FILE, token, { mode: 0o600 });
  try { fs.chmodSync(API_TOKEN_FILE, 0o600); } catch (_) {}
  return token;
}

const API_TOKEN = ensureApiToken();

// 简单 semver 比较：a > b → 1，a < b → -1，相等 → 0（忽略预发布后缀）
function semverCompare(a, b) {
  const pa = String(a || '').replace(/^v/, '').split(/[-+]/)[0].split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').replace(/^v/, '').split(/[-+]/)[0].split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

// 带超时的 HTTPS GET（返回 statusCode + body + headers）
function httpsGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? require('https') : require('http');
    const req = mod.get(url, { headers: { 'User-Agent': 'WorkDaddy/' + DAEMON_VERSION, Accept: 'application/vnd.github+json' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs || UPDATE_REQ_TIMEOUT, () => { req.destroy(new Error('request timeout')); });
  });
}

// 从 Release body 解析某个资产的 SHA-256；多资产 Release 必须使用带文件名格式，
// 避免把 Windows zip 的摘要误用于 macOS dmg（或反过来）。
function parseSha256(body, assetName) {
  if (!body) return null;
  const text = String(body);
  if (assetName) {
    const escaped = String(assetName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const named = text.match(new RegExp('SHA-?256\\s*\\(\\s*' + escaped + '\\s*\\)\\s*[:：=]\\s*([a-fA-F0-9]{64})', 'i')) ||
      text.match(new RegExp('([a-fA-F0-9]{64})\\s+\\*?' + escaped + '(?:\\s|$)', 'i'));
    if (named) return named[1].toLowerCase();
  }
  const m = text.match(/SHA-?256[:：]\s*([a-fA-F0-9]{64})/i);
  return m ? m[1].toLowerCase() : null;
}

// 检查更新：请求 Releases API，比对版本，结果写缓存（内存 + 文件）
function checkUpdate(force) {
  if (!force && updateTimer) {
    // 有缓存且未过期且非强制 → 直接返回缓存（面板高频打开不重复请求）
    if (Date.now() - updateState.checkedAt < UPDATE_CHECK_INTERVAL && updateState.latest) {
      return Promise.resolve(updateState);
    }
  }
  updateState.status = 'checking';
  updateState.message = '正在检查更新…';
  return httpsGet(UPDATE_API)
    .then(({ status, body }) => {
      if (status !== 200) {
        throw new Error('Releases API ' + status + (status === 404 ? '（仓库暂无 Release）' : ''));
      }
      const rel = JSON.parse(body);
      const latest = String(rel.tag_name || '').replace(/^v/, '');
      updateState.latest = latest;
      updateState.hasUpdate = semverCompare(latest, DAEMON_VERSION) > 0;
      updateState.releaseUrl = rel.html_url || null;
      updateState.notes = (rel.body || '').slice(0, 2000);
      // 资产按平台选取：macOS 找 .dmg；Windows 优先官方便携包（-win64.zip），再回退任意 .zip，
      // 绝不选 Setup.exe（IExpress 自解压包，当 .zip 下载后 Expand-Archive 会失败 → 更新中断）
      const assets = rel.assets || [];
      const asset = IS_WIN
        ? (assets.find((a) => /-win64\.zip$/i.test(a.name || '')) ||
           assets.find((a) => /\.zip$/i.test(a.name || '')) || null)
        : (assets.find((a) => /\.dmg$/i.test(a.name || '')) || null);
      updateState.dmgUrl = asset ? asset.browser_download_url : null;
      updateState.dmgSize = asset ? asset.size : 0;
      updateState.sha256 = asset && /^sha256:[a-f0-9]{64}$/i.test(asset.digest || '')
        ? String(asset.digest).slice(7).toLowerCase()
        : (asset ? (parseSha256(updateState.notes, asset.name) || (assets.length === 1 ? parseSha256(updateState.notes) : null)) : null);
      updateState.checkedAt = Date.now();
      updateState.status = 'idle';
      updateState.message = updateState.hasUpdate ? '发现新版本 v' + latest : '已是最新版本';
      try { fs.writeFileSync(UPDATE_CHECK_CACHE, JSON.stringify({ latest, hasUpdate: updateState.hasUpdate, dmgUrl: updateState.dmgUrl, dmgSize: updateState.dmgSize, sha256: updateState.sha256, notes: updateState.notes, checkedAt: updateState.checkedAt })); } catch (_) {}
      log(`[update] 检查完成: latest=${latest} hasUpdate=${updateState.hasUpdate} (current=${DAEMON_VERSION})`);
      return updateState;
    })
    .catch((e) => {
      updateState.status = 'idle';
      updateState.error = e.message;
      updateState.message = '检查更新失败';
      log(`[update] 检查失败: ${e.message}`);
      // 尝试读缓存兜底（上次成功的结果）
      try {
        const c = JSON.parse(fs.readFileSync(UPDATE_CHECK_CACHE, 'utf8'));
        updateState.latest = c.latest;
        updateState.hasUpdate = !!c.hasUpdate;
        updateState.dmgUrl = c.dmgUrl;
        updateState.sha256 = c.sha256 || null;
        updateState.notes = c.notes;
        updateState.checkedAt = c.checkedAt || Date.now();
      } catch (_) {}
      return updateState;
    });
}

// 下载安装包（macOS .dmg / Windows .zip），流式写文件更新 progress，带 SHA-256 校验
function downloadUpdate() {
  if (!updateState.dmgUrl) return Promise.reject(new Error('无可用安装包'));
  fs.mkdirSync(UPDATE_DIR, { recursive: true });
  const ext = IS_WIN ? '.zip' : '.dmg';
  const target = path.join(UPDATE_DIR, 'WorkDaddy-' + updateState.latest + ext);
  if (fs.existsSync(target)) {
    // 已有同版本文件：直接校验后复用
    const digest = sha256File(target);
    const expect = updateState.sha256;
    if (!expect) return Promise.reject(new Error('Release 未提供 SHA-256，已拒绝安装未校验更新'));
    if (digest === expect) {
      updateState.downloaded = true;
      updateState.progress = 100;
      updateState.status = 'idle';
      updateState.message = '安装包已就绪';
      return Promise.resolve(target);
    }
    fs.unlinkSync(target); // 校验失败删掉重下
  }
  updateState.status = 'downloading';
  updateState.progress = 0;
  updateState.message = '正在下载安装包…';
  return new Promise((resolve, reject) => {
    const mod = require('https');
    mod.get(updateState.dmgUrl, { headers: { 'User-Agent': 'WorkDaddy/' + DAEMON_VERSION } }, (res) => {
      if (res.statusCode >= 400) return reject(new Error('下载失败 HTTP ' + res.statusCode));
      if ((res.statusCode >= 300) && res.headers.location) {
        // 跟随重定向（GitHub 资产会 302 到 objects.githubusercontent.com）
        updateState.dmgUrl = res.headers.location;
        resolve(downloadUpdate());
        res.resume();
        return;
      }
      const total = parseInt(res.headers['content-length'] || '0', 10) || updateState.dmgSize;
      let received = 0;
      const out = fs.createWriteStream(target);
      res.on('data', (c) => {
        received += c.length;
        if (total) {
          updateState.progress = Math.min(99, Math.round((received / total) * 100));
        }
      });
      res.pipe(out);
      out.on('finish', () => {
        updateState.progress = 100;
        updateState.status = 'verifying';
        updateState.message = '校验安装包…';
        const digest = sha256File(target);
        const expect = updateState.sha256;
        if (!expect) {
          fs.unlinkSync(target);
          updateState.status = 'error';
          updateState.error = 'Release 未提供 SHA-256';
          updateState.message = '缺少校验值，已拒绝安装';
          return reject(new Error('Release 未提供 SHA-256，已拒绝安装未校验更新'));
        }
        if (digest !== expect) {
          fs.unlinkSync(target);
          updateState.status = 'error';
          updateState.error = 'SHA-256 校验失败';
          updateState.message = '校验失败，已删除损坏包';
          return reject(new Error('SHA-256 mismatch: ' + digest + ' != ' + expect));
        }
        updateState.downloaded = true;
        updateState.status = 'idle';
        updateState.message = '安装包已就绪（SHA-256 校验通过）';
        log(`[update] 下载完成 ${target} sha256=${digest}`);
        resolve(target);
      });
      out.on('error', (e) => { try { fs.unlinkSync(target); } catch (_) {} reject(e); });
    }).on('error', (e) => { try { fs.unlinkSync(target); } catch (_) {} reject(e); });
  });
}

// 计算文件 SHA-256
function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// 从 dmg 中解出 WorkDaddy.app 到 UPDATE_DIR（挂载→拷贝→卸载），返回 app 目录
function extractAppFromDmg(dmgPath) {
  const mountPoint = '/Volumes/WorkDaddy-update';
  const appDest = path.join(UPDATE_DIR, 'WorkDaddy.app');
  return new Promise((resolve, reject) => {
    const exec = require('child_process').execFile;
    // 先清理可能残留的挂载点（上次更新失败/中断会遗留，direct attach -mountpoint 会报 Resource busy），
    // 再用只读 + 免校验挂载（只取包内容，不做写操作）
    exec('hdiutil', ['detach', mountPoint, '-force'], () => {
      exec('hdiutil', ['attach', '-nobrowse', '-readonly', '-noverify', '-mountpoint', mountPoint, dmgPath], (err) => {
        if (err) return reject(new Error('挂载 dmg 失败: ' + err.message));
        const src = path.join(mountPoint, 'WorkDaddy.app');
        if (!fs.existsSync(src)) {
          exec('hdiutil', ['detach', mountPoint, '-force'], () => reject(new Error('dmg 中未找到 WorkDaddy.app')));
          return;
        }
        fs.rmSync(appDest, { recursive: true, force: true });
        const cp = require('child_process').spawn('cp', ['-R', src, appDest], { stdio: 'ignore' });
        cp.on('close', (code) => {
          exec('hdiutil', ['detach', mountPoint, '-force'], () => {
            if (code !== 0 || !fs.existsSync(path.join(appDest, 'Contents', 'Info.plist'))) {
              return reject(new Error('解包应用失败'));
            }
            resolve(appDest);
          });
        });
        cp.on('error', (e) => { exec('hdiutil', ['detach', mountPoint, '-force'], () => reject(e)); });
      });
    });
  });
}

// 安装：macOS 调 apply-update.sh（launchctl 停服 → 备份 → 替换 → relaunch）；
// Windows 调 apply-update.ps1（杀 watchdog/daemon → 释放文件锁 → 替换目录 → 重启）
function applyUpdate() {
  if (!updateState.downloaded) return Promise.reject(new Error('尚未下载完成'));
  updateState.status = 'installing';
  updateState.message = '正在安装新版本…';
  const { execFile } = require('child_process');
  if (IS_WIN) {
    // Windows 安装位置由 install.ps1 铺好（%LOCALAPPDATA%\Programs\WorkDaddy）
    const scriptPath = path.join(__dirname, 'apply-update.ps1');
    const appDir = WORKDADDY_DIR_WIN;
    const srcZip = path.join(UPDATE_DIR, 'WorkDaddy-' + updateState.latest + '.zip');
    if (!fs.existsSync(scriptPath)) return Promise.reject(new Error('缺少 apply-update.ps1'));
    if (!fs.existsSync(srcZip)) return Promise.reject(new Error('缺少解压后的新版本包'));
    log('[update] 执行 apply-update.ps1，daemon 即将退出');
    const child = require('child_process').spawn(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, srcZip, appDir, String(ACTUAL_PORT)],
      { detached: true, stdio: 'ignore', windowsHide: true }
    );
    child.unref();
    return Promise.resolve({ ok: true, message: '更新已启动，WorkDaddy 即将重启' });
  }
  const scriptPath = path.join(__dirname, 'apply-update.sh');
  const appPath = '/Applications/WorkDaddy.app';
  const srcApp = path.join(UPDATE_DIR, 'WorkDaddy.app');
  if (!fs.existsSync(scriptPath)) return Promise.reject(new Error('缺少 apply-update.sh'));
  // 解出新应用：下载阶段只落了 .dmg，这里才把 WorkDaddy.app 从 dmg 解到 UPDATE_DIR（幂等：已解出则复用）
  const dmgPath = path.join(UPDATE_DIR, 'WorkDaddy-' + updateState.latest + '.dmg');
  const preUnpack = fs.existsSync(srcApp)
    ? Promise.resolve(srcApp)
    : (fs.existsSync(dmgPath)
        ? (updateState.message = '正在解包新应用…', extractAppFromDmg(dmgPath))
        : Promise.reject(new Error('缺少安装包（未找到已下载的 dmg）')));
  return preUnpack.then((p) => {
    if (!fs.existsSync(p)) return Promise.reject(new Error('缺少解包后的新应用'));
    // 停掉自身 launchd 服务（KeepAlive 会在新版本启动后接管）
    execFile('launchctl', ['bootout', 'gui/' + process.getuid(), 'com.workbuddy.workdaddy'], () => {
      execFile('launchctl', ['remove', 'com.workbuddy.workdaddy'], () => {});
    });
    log('[update] 执行 apply-update.sh，daemon 即将退出');
    const child = require('child_process').spawn('bash', [scriptPath, p, appPath, String(ACTUAL_PORT)], { detached: true, stdio: 'ignore' });
    child.unref();
    return { ok: true, message: '更新已启动，WorkDaddy 即将重启' };
  });
}


let logWriteCount = 0;
function rotateLogsIfNeeded() {
  if (++logWriteCount % 100 !== 0) return;
  const file = logFile(DATA_DIR);
  try {
    if (fs.statSync(file).size < 10 * 1024 * 1024) return;
    for (let i = 2; i >= 1; i--) {
      const older = file + '.' + i;
      const newer = file + '.' + (i + 1);
      try { fs.unlinkSync(newer); } catch (_) {}
      try { fs.renameSync(older, newer); } catch (_) {}
    }
    fs.renameSync(file, file + '.1');
  } catch (_) {}
}

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  // launchd/nohup 已把 stdout 重定向到同一个文件；只写一次，避免每条日志重复。
  try {
    rotateLogsIfNeeded();
    fs.appendFileSync(logFile(DATA_DIR), line);
  } catch (_) {
    /* 忽略日志错误 */
  }
}

// launchd 应只启动一个 daemon；启动器的 nohup 兜底和 launchd 异步拉起可能短暂重叠，
// 用原子创建锁文件把这类竞态变成可观测的单实例退出，而不是两个进程同时清理/注入页面。
function acquireDaemonLock() {
  const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), version: DAEMON_VERSION, buildId: DAEMON_BUILD_ID });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      daemonLockFd = fs.openSync(DAEMON_LOCK_FILE, 'wx', 0o600);
      fs.writeFileSync(daemonLockFd, payload, 'utf8');
      log(`[lock] daemon 单实例锁已获取 (pid=${process.pid})`);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let owner = null;
      try { owner = JSON.parse(fs.readFileSync(DAEMON_LOCK_FILE, 'utf8')); } catch (_) {}
      const ownerPid = Number(owner && owner.pid);
      let alive = false;
      if (ownerPid > 0 && ownerPid !== process.pid) {
        try { process.kill(ownerPid, 0); alive = true; } catch (_) {}
      }
      if (alive) {
        process.stdout.write(`[${new Date().toISOString()}] [lock] 已有 daemon 运行 (pid=${ownerPid})，当前进程退出\n`);
        return false;
      }
      try { fs.unlinkSync(DAEMON_LOCK_FILE); } catch (_) { return false; }
    }
  }
  return false;
}

function releaseDaemonLock() {
  if (daemonLockFd === null) return;
  try { fs.closeSync(daemonLockFd); } catch (_) {}
  daemonLockFd = null;
  try {
    const owner = JSON.parse(fs.readFileSync(DAEMON_LOCK_FILE, 'utf8'));
    if (Number(owner.pid) === process.pid) fs.unlinkSync(DAEMON_LOCK_FILE);
  } catch (_) {}
}

/* ================= 自动备份（双层触发：CDP 事件 + 文件监听兜底） ================= */

let backupTimer = null;
function scheduleBackup(reason) {
  if (backupTimer) clearTimeout(backupTimer);
  backupTimer = setTimeout(() => {
    backupTimer = null;
    try {
      backupCurrent(DATA_DIR, log);
    } catch (e) {
      log(`[sync] ${reason} 触发备份失败: ${e.message}`);
    }
  }, BACKUP_DEBOUNCE);
}

// 兜底：登录文件本身变化（每次打开/刷新 WorkBuddy 都会重写该文件）
fs.watchFile(AUTH_FILE, { interval: WATCH_INTERVAL }, (cur, prev) => {
  // 文件被移走（如"假退出登录"）时不应触发备份；仅当文件存在且 mtime 变化才备份
  if (!fs.existsSync(AUTH_FILE)) return;
  if (cur.mtimeMs !== prev.mtimeMs) scheduleBackup('file-change');
});

/* ================= CDP 客户端（Node 22 内置 WebSocket，零依赖） ================= */

const cdp = {
  ws: null,
  connected: false,
  port: null,
  targetUrl: null,
  error: null,
  id: 0,
  pending: new Map(),
  manualClose: false,
};

const DIAGNOSTICS_FILE = path.join(DATA_DIR, 'diagnostics-latest.json');
const DAEMON_LOCK_FILE = path.join(DATA_DIR, '.daemon.lock');
let daemonLockFd = null;
// 注入节流：仅避免 connect 与 loadEventFired 在同一瞬间（<1.5s）重复注入导致闪烁；
// 但每次页面刷新（含 Command+R）都应重新注入最新代码，因此不用“一次加载只注入一次”的布尔去重，
// 否则 Electron 重载未触发 loadEventFired 时会遗留旧版本组件。
let lastInjectTs = 0;
let injectRetryTimer = null; // 被节流跳过的自动注入的兜底补种定时器

async function findCdpEndpoint() {
  const ports = CDP_PORT_HINT ? [CDP_PORT_HINT] : [9222, 9223, 9333];
  for (const p of ports) {
    try {
      const [versionRes, listRes] = await Promise.all([
        fetch(`http://127.0.0.1:${p}/json/version`, { signal: AbortSignal.timeout(1500) }),
        fetch(`http://127.0.0.1:${p}/json/list`, { signal: AbortSignal.timeout(1500) }),
      ]);
      const version = await versionRes.json();
      const list = await listRes.json();
      const targets = Array.isArray(list) ? list : [];
      const belongsToWorkBuddy = /workbuddy|codebuddy/i.test([version.Browser, version['User-Agent']].filter(Boolean).join(' '));
      if (belongsToWorkBuddy && targets.some(isWorkBuddyCdpTarget)) return p;
      // 旧逻辑会把任意 Chromium（常见为 Antigravity）当成 WorkBuddy。
      // 扫描到历史误注入标记时仅做清理，不对该应用执行任何新注入。
      await cleanupForeignInjectedTargets(targets);
    } catch (_) {
      /* 端口未开放，跳过 */
    }
  }
  return null;
}

function isWorkBuddyCdpTarget(target) {
  if (!target || target.type !== 'page') return false;
  const url = String(target.url || '');
  const title = String(target.title || '');
  return /(?:^|\/)WorkBuddy(?:AI)?\.app(?:\/|$)/i.test(url) ||
    /https?:\/\/(?:[^/]+\.)?(?:workbuddy|codebuddy)\.cn(?:\/|$)/i.test(url) ||
    /^WorkBuddy(?:AI)?(?:\s|$)/i.test(title);
}

async function getPageTarget(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
  const list = await r.json();
  return (Array.isArray(list) ? list : []).find(isWorkBuddyCdpTarget) || null;
}

async function cleanupForeignInjectedTargets(targets) {
  if (!WebSocketCtor) return;
  for (const target of targets) {
    if (!target || target.type !== 'page' || !target.webSocketDebuggerUrl) continue;
    try { await cleanupForeignInjectedTarget(target); } catch (_) {}
  }
}

async function cleanupForeignInjectedTarget(target) {
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch (_) {}
      resolve();
    };
    const ws = new WebSocketCtor(target.webSocketDebuggerUrl);
    const timer = setTimeout(finish, 1800);
    ws.onopen = () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          returnByValue: true,
          expression: `(function(){
            var marked = !!(document.querySelector('.wbs-root,#wbs-style,#wbs-theme-style') || window.__wbsWidget);
            if (!marked) return { removed: false };
            try { if (window.__wbsWidget && typeof window.__wbsWidget.destroy === 'function') window.__wbsWidget.destroy(); } catch (_) {}
            try { delete window.__wbsWidget; } catch (_) { window.__wbsWidget = null; }
            document.querySelectorAll('.wbs-root,.wbs-stash-inline,.wbs-stash-btn,#wbs-style,#wbs-theme-style,#wbs-diag-badge,#wbs-debug-panel').forEach(function (n) { n.remove(); });
            return { removed: true };
          })()`,
        },
      }));
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.id === 1) {
          clearTimeout(timer);
          if (msg.error) log(`[cdp] 清理宿主页旧注入失败: ${msg.error.message || msg.error}`);
          else if (msg.result && msg.result.result && msg.result.result.value && msg.result.result.value.removed) {
            log(`[cdp] 已清理非 WorkBuddy 目标的旧注入: ${target.url || target.title || 'unknown'}`);
          }
          finish();
        }
      } catch (_) {}
    };
    ws.onerror = finish;
    ws.onclose = finish;
  });
}

function cdpSend(method, params = {}, _retry = 0) {
  if (!cdp.ws || cdp.ws.readyState !== 1) return Promise.reject(new Error('CDP 未连接'));
  const id = ++cdp.id;
  return new Promise((resolve, reject) => {
    cdp.pending.set(id, { resolve, reject });
    cdp.ws.send(JSON.stringify({ id, method, params }));
  }).catch((e) => {
    // "the tab is inactive"：Electron 窗口失焦/最小化/被遮挡时页面 lifecycle 变 inactive，
    // CDP 命令（尤其 Input.*、Page.captureScreenshot、Page.reload）会被拒绝。
    // 自动激活页面后重试一次，避免外部调用方暴露这个错误。
    if (_retry < 1 && /inactive/i.test(String((e && e.message) || e))) {
      return cdpActivatePage().then(() => cdpSend(method, params, _retry + 1));
    }
    throw e;
  });
}

// 激活页面（强制 lifecycle active + 置前），供 cdpSend 自动恢复与 devtools-proxy 保活复用
function cdpActivatePage() {
  const raw = () => {
    if (!cdp.ws || cdp.ws.readyState !== 1) return Promise.resolve();
    const id = ++cdp.id;
    return new Promise((resolve) => {
      const t = setTimeout(() => { cdp.pending.delete(id); resolve(); }, 800);
      cdp.pending.set(id, { resolve: () => { clearTimeout(t); resolve(); }, reject: () => { clearTimeout(t); resolve(); } });
      cdp.ws.send(JSON.stringify({ id, method: 'Page.setWebLifecycleState', params: { state: 'active' } }));
    });
  };
  return raw().then(() => new Promise((r) => setTimeout(r, 60)));
}

async function connectCdp() {
  if (!WebSocketCtor) throw new Error('当前 Node 运行时没有 WebSocket，且未找到内置 ws 模块');
  cdp.port = await findCdpEndpoint();
  if (!cdp.port) {
    cdp.connected = false;
    cdp.error = '未发现 CDP 端口（WorkBuddy 需以 --remote-debugging-port 启动）';
    return false;
  }
  const target = await getPageTarget(cdp.port).catch(() => null);
  if (!target) {
    cdp.connected = false;
    cdp.error = `端口 ${cdp.port} 上没有 WorkBuddy 页面目标`;
    return false;
  }
  return new Promise((resolve) => {
    const ws = new WebSocketCtor(target.webSocketDebuggerUrl);
    ws.onopen = () => {
      cdp.ws = ws;
      cdp.connected = true;
      cdp.error = null;
      cdp.targetUrl = target.url || '';
      log(`[cdp] 已连接 WorkBuddy (port=${cdp.port}, target=${cdp.targetUrl})`);
      // 打开感兴趣的能力域
      cdpSend('Page.enable').catch(() => {});
      cdpSend('Network.enable').catch(() => {});
      cdpSend('Runtime.enable').catch(() => {});
      // 刚连上说明应用刚启动/刚登录，立刻同步一次 + 注入右下角组件
      setTimeout(() => scheduleBackup('cdp-connect'), 800);
      setTimeout(() => {
        injectWidget('connect').catch((e) => log(`[cdp] 注入失败: ${e.message}`));
        // 恢复已保存的主题（页面刷新/WorkBuddy 重启后 WorkBuddy 回到官方浅色，
        // 这里重新应用，保证「WorkDaddy 主题=深色 / WorkBuddy 默认主题=浅色」在重启后仍生效）
        restoreSavedTheme().catch((e) => log(`[theme] 恢复主题失败: ${e.message}`));
      }, 1200);
      resolve(true);
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (_) {
        return;
      }
      if (msg.id !== undefined) {
        const p = cdp.pending.get(msg.id);
        if (p) {
          cdp.pending.delete(msg.id);
          msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
        }
        return;
      }
      onCdpEvent(msg.method, msg.params || {});
    };
    ws.onerror = () => {
      cdp.connected = false;
      cdp.error = `连接 ${cdp.port} WebSocket 失败`;
      log(`[cdp] 连接错误: ${cdp.error}`);
      resolve(false);
    };
    ws.onclose = () => {
      cdp.connected = false;
      cdp.ws = null;
      log('[cdp] 连接已断开，5 秒后重连');
    };
  });
}

function onCdpEvent(method, params) {
  switch (method) {
    case 'Network.requestWillBeSent': {
      const url = (params.request && params.request.url) || '';
      if (/auth|realms|login|token/i.test(url)) scheduleBackup('cdp-auth');
      break;
    }
    case 'Runtime.consoleAPICalled': {
      // 持久采集渲染进程 console（含注入脚本 breadcrumb/console.error），崩溃时也能留痕
      const type = params.type || 'log';
      let args;
      try {
        args = (params.args || []).map((a) => (a && a.value !== undefined ? String(a.value) : a && a.description !== undefined ? String(a.description) : String(a && a.type)));
      } catch (_) {
        args = [];
      }
      log(`[renderer:${type}] ${args.join(' ')}`);
      break;
    }
    case 'Runtime.exceptionThrown': {
      const d = params.exceptionDetails || {};
      const desc =
        d.exception && d.exception.description !== undefined
          ? d.exception.description
          : (d.exception && d.exception.value !== undefined ? String(d.exception.value) : '');
      log('[renderer:exception] ' + String(desc || d.text || '').slice(0, 2500));
      break;
    }
    case 'Page.loadEventFired':
      scheduleBackup('cdp-page-load');
      // 页面刷新/导航后重新注入组件（组件自带幂等清理，可安全重新注入最新代码）
      injectWidget('page-load').catch(() => {});
      // 页面刷新后 WorkBuddy 回到官方浅色，重新应用已保存主题（WorkDaddy=深色 / 默认=浅色）
      restoreSavedTheme().catch((e) => log(`[theme] 页面刷新恢复主题失败: ${e.message}`));
      break;
    case 'Page.frameNavigated':
      scheduleBackup('cdp-navigate');
      break;
    default:
      break;
  }
}

async function cdpLoop() {
  for (;;) {
    if (!cdp.connected) {
      try {
        await connectCdp();
      } catch (e) {
        log(`[cdp] 连接异常: ${e.message}`);
      }
    }
    await new Promise((r) => setTimeout(r, CDP_RECONNECT_MS));
  }
}

async function reloadWorkBuddyPage() {
  if (!cdp.connected) throw new Error('CDP 未连接，无法自动刷新窗口');
  await cdpSend('Page.reload', { ignoreCache: false });
}

const WORKBUDDY_APP = IS_WIN ? '' : '/Applications/WorkBuddy.app';
const WORKBUDDY_BINARY = IS_WIN ? '' : `${WORKBUDDY_APP}/Contents/MacOS/Electron`;

// Windows：解析 WorkBuddy/WorkBuddyAI 可执行文件真实路径（安装盘可自定义，必须动态查）
// 优先级：WBSWITCH_WORKBUDDY_BIN > 运行进程 Path > 注册表卸载项 > 常见路径
let wbBinaryCache = null;
function resolveWorkBuddyBinary() {
  if (!IS_WIN) return WORKBUDDY_BINARY;
  if (wbBinaryCache) return wbBinaryCache;
  const tryFile = (p) => { try { if (p && fs.existsSync(p)) return p; } catch (_) {} return null; };
  const { execFileSync } = require('child_process');
  const psCmd = (cmd) => execFileSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8', timeout: 8000, windowsHide: true });
  // 1) 显式指定（launcher/install 传入最可靠）
  const envBin = tryFile(process.env.WBSWITCH_WORKBUDDY_BIN);
  if (envBin) return (wbBinaryCache = envBin);
  // 2) 运行中的 WorkBuddy/WorkBuddyAI 进程 Path（最权威）
  try {
    const out = psCmd('Get-Process WorkBuddyAI,WorkBuddy -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path');
    const p = out.trim().split(/\r?\n/).filter(Boolean).pop();
    const hit = tryFile(p);
    if (hit) return (wbBinaryCache = hit);
  } catch (_) {}
  // 3) 注册表卸载项（DisplayIcon 优先；InstallLocation 兼容两种进程名）
  try {
    const out = psCmd("$k=@('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'); Get-ItemProperty $k -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'WorkBuddy|CodeBuddy' } | Select-Object -First 1 DisplayIcon,InstallLocation | ForEach-Object { if($_.DisplayIcon){ ($_.DisplayIcon -replace ',.*$','').Trim() } elseif($_.InstallLocation){ $ai=Join-Path $_.InstallLocation 'WorkBuddyAI.exe'; $legacy=Join-Path $_.InstallLocation 'WorkBuddy.exe'; if(Test-Path $ai){$ai}else{$legacy} } }");
    const p = out.trim().split(/\r?\n/).filter(Boolean).pop();
    const hit = tryFile(p);
    if (hit) return (wbBinaryCache = hit);
  } catch (_) {}
  // 4) 常见路径兜底（含探测机实际安装位）
  const cands = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'WorkBuddyAI', 'WorkBuddyAI.exe'),
    path.join(process.env.ProgramFiles || '', 'WorkBuddyAI', 'WorkBuddyAI.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'WorkBuddyAI', 'WorkBuddyAI.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'WorkBuddy', 'WorkBuddy.exe'),
    path.join(process.env.ProgramFiles || '', 'WorkBuddy', 'WorkBuddy.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'WorkBuddy', 'WorkBuddy.exe'),
    'D:\\workbody\\WorkBuddy\\WorkBuddy.exe',
  ];
  for (const c of cands) {
    const hit = tryFile(c);
    if (hit) return (wbBinaryCache = hit);
  }
  return null;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const timeoutMs = Number(options.timeoutMs) || 0;
    const spawnOptions = { ...options };
    delete spawnOptions.timeoutMs;
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    let child;
    try {
      child = spawn(command, args, { stdio: 'ignore', windowsHide: true, ...spawnOptions });
    } catch (e) {
      return finish({ code: null, error: e });
    }
    child.on('error', (error) => finish({ code: null, error }));
    child.on('exit', (code, signal) => finish({ code, signal, error: null }));
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try { child.kill(); } catch (_) {}
        finish({ code: null, error: new Error(command + ' 超时') });
      }, timeoutMs);
    }
  });
}

function workBuddyRunning() {
  try {
    if (IS_WIN) {
      const imageName = path.basename(resolveWorkBuddyBinary() || '') || 'WorkBuddy.exe';
      const r = spawnSync(
        'tasklist',
        ['/FI', 'IMAGENAME eq ' + imageName, '/FO', 'CSV', '/NH'],
        { encoding: 'utf8', timeout: 5000, windowsHide: true }
      );
      return r.status === 0 && (r.stdout || '').toLowerCase().includes('"' + imageName.toLowerCase() + '"');
    }
    const r = spawnSync('pgrep', ['-f', WORKBUDDY_APP], { stdio: 'ignore', timeout: 5000 });
    return r.status === 0;
  } catch (_) {
    // 探测失败时按仍在运行处理，避免误删身份文件后拉起旧实例。
    return true;
  }
}

async function waitForWorkBuddyExit(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!workBuddyRunning()) return true;
    await sleep(200);
  }
  return !workBuddyRunning();
}

async function elevatedWindowsKill() {
  const imageName = path.basename(resolveWorkBuddyBinary() || '') || 'WorkBuddy.exe';
  const command =
    "$p = Start-Process -FilePath 'taskkill.exe' -ArgumentList '/F','/T','/IM','" + imageName.replace(/'/g, "''") + "' -Verb RunAs -Wait -PassThru; exit $p.ExitCode";
  return runCommand('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], { timeoutMs: 30000 });
}

/** 退出 WorkBuddy，并确认进程已经消失；失败时拒绝继续登录切换。 */
async function quitWorkBuddy() {
  if (!workBuddyRunning()) return true;

  if (IS_WIN) {
    const imageName = path.basename(resolveWorkBuddyBinary() || '') || 'WorkBuddy.exe';
    await runCommand('taskkill', ['/IM', imageName]);
    if (await waitForWorkBuddyExit(1800)) return true;

    await runCommand('taskkill', ['/F', '/T', '/IM', imageName]);
    if (await waitForWorkBuddyExit(2500)) return true;

    // WorkBuddy 可能由管理员权限启动；普通 daemon 无法结束它时请求一次 UAC。
    await elevatedWindowsKill();
    if (await waitForWorkBuddyExit(5000)) return true;
    throw new Error('无法确认 WorkBuddy 已退出（可能未通过管理员授权）');
  }

  // 先尝试正常退出（给 Electron 一次处理机会），再强制 kill 并验证。
  await runCommand('osascript', ['-e', 'tell application "WorkBuddy" to quit']);
  if (await waitForWorkBuddyExit(2500)) return true;
  await runCommand('pkill', ['-f', WORKBUDDY_APP]);
  if (await waitForWorkBuddyExit(2500)) return true;
  await runCommand('pkill', ['-9', '-f', WORKBUDDY_APP]);
  if (await waitForWorkBuddyExit(3000)) return true;
  throw new Error('无法确认 WorkBuddy 已退出');
}

/** 探测 WorkDaddy.app 位置（macOS 专用：退出登录后打开它，由其 launcher 以 CDP 模式重启 WorkBuddy 并注入组件） */
function findWorkDaddyApp() {
  if (IS_WIN) return null;
  const cands = [
    '/Applications/WorkDaddy.app',
    path.join(os.homedir(), 'Applications', 'WorkDaddy.app'),
    path.join(os.homedir(), 'Desktop', 'WorkDaddy.app'),
    path.join(__dirname, '..', 'WorkDaddy.app'),
    path.join(__dirname, '..', '..', 'workbuddy-switch', 'WorkDaddy.app'),
  ];
  for (const c of cands) {
    try {
      if (fs.existsSync(path.join(c, 'Contents', 'MacOS', 'launcher'))) return c;
    } catch (_) {}
  }
  return null;
}

/** 重新启动 WorkBuddy：macOS 优先走 WorkDaddy.app launcher；Windows 直接带 CDP 参数重启 exe */
function relaunchWorkBuddy() {
  return new Promise((resolve, reject) => {
    if (IS_WIN) {
      const bin = resolveWorkBuddyBinary();
      if (!bin) return reject(new Error('未找到 WorkBuddy/WorkBuddyAI 可执行文件（可用环境变量 WBSWITCH_WORKBUDDY_BIN 指定）'));
      const port = CDP_PORT_HINT || cdp.port || 9222;
      log(`[logout] 以 --remote-debugging-port=${port} 重启 WorkBuddy: ${bin}`);
      const child = spawn(bin, ['--remote-debugging-port=' + port], { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', (e) => reject(e));
      child.unref();
      return resolve();
    }
    const workDaddy = findWorkDaddyApp();
    if (workDaddy) {
      log(`[logout] 正在打开 WorkDaddy (${workDaddy})，由其 launcher 重启 WorkBuddy`);
      const child = spawn('open', [workDaddy], { detached: true, stdio: 'ignore' });
      child.on('error', (e) => reject(e));
      child.unref();
      return resolve();
    }
    if (!fs.existsSync(WORKBUDDY_BINARY)) {
      return reject(new Error(`未找到 WorkBuddy 可执行文件: ${WORKBUDDY_BINARY}`));
    }
    log('[logout] 未找到 WorkDaddy.app，直接重新启动 WorkBuddy（带 CDP 端口 9222）');
    const child = spawn(WORKBUDDY_BINARY, ['--remote-debugging-port=9222'], {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', (e) => reject(e));
    child.unref();
    resolve();
  });
}

/**
 * 通过 CDP 在 WorkBuddy 渲染进程里查找/点击元素（trusted 事件，可靠触发应用业务）
 *
 * 策略：先 Runtime.evaluate 找元素 + 获取视口坐标（必要时 scrollIntoView），
 * 再用 Input.dispatchMouseEvent 发送真实鼠标事件，绕过业务代码对 event.isTrusted 的检查。
 */
async function clickByText(text, { tag = null, exact = false } = {}) {
  if (!cdp.connected) throw new Error('CDP 未连接');
  const escaped = String(text).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const tags = tag ? `self::${tag}` : "self::button or self::a or @role='button'";
  const contains = exact ? 'text()' : 'normalize-space(.)';
  const cmp = exact ? '=' : 'contains';
  // 精确匹配：限定为 button/a/role=button；尺寸合理（按钮不会全屏）；文字短
  const expr = `(function(){
    try {
      var xpath = "//*[" + ${JSON.stringify(tags)} + "][" + ${JSON.stringify(cmp)} + "(" + ${JSON.stringify(contains)} + ", '" + ${JSON.stringify(escaped)} + "')]";
      var r = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      for (var i = 0; i < r.snapshotLength; i++) {
        var el = r.snapshotItem(i);
        var cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        var b = el.getBoundingClientRect();
        if (b.width <= 0 || b.height <= 0) continue;
        if (b.width > 400 || b.height > 200) continue; // 全屏容器忽略
        var txt = (el.textContent || '').trim();
        if (txt.length > 40) continue; // 按钮文字一般 < 40 字
        try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch(_) {}
        var b2 = el.getBoundingClientRect();
        return {
          x: b2.x + b2.width / 2,
          y: b2.y + b2.height / 2,
          w: b2.width,
          h: b2.height,
          tag: el.tagName,
          text: txt,
          xpath: xpath,
        };
      }
      return null;
    } catch (e) { return { error: String(e) }; }
  })()`;
  const r = await cdpSend('Runtime.evaluate', { expression: expr, returnByValue: true });
  const found = r.result && r.result.value;
  if (!found) throw new Error('未找到元素');
  if (found.error) throw new Error('查找异常: ' + found.error);
  // 用 Input 事件模拟真实鼠标点击（trusted）
  await cdpSend('Input.dispatchMouseEvent', { type: 'mouseMoved', x: found.x, y: found.y });
  await cdpSend('Input.dispatchMouseEvent', { type: 'mousePressed', x: found.x, y: found.y, button: 'left', clickCount: 1 });
  await cdpSend('Input.dispatchMouseEvent', { type: 'mouseReleased', x: found.x, y: found.y, button: 'left', clickCount: 1 });
  return found;
}

async function findByText(text, { tag = null, exact = false } = {}) {
  if (!cdp.connected) throw new Error('CDP 未连接');
  const escaped = String(text).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const tags = tag ? `self::${tag}` : "self::button or self::a or @role='button'";
  const contains = exact ? 'text()' : 'normalize-space(.)';
  const cmp = exact ? '=' : 'contains';
  const expr = `(function(){
    try {
      var xpath = "//*[" + ${JSON.stringify(tags)} + "][" + ${JSON.stringify(cmp)} + "(" + ${JSON.stringify(contains)} + ", '" + ${JSON.stringify(escaped)} + "')]";
      var r = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      var out = [];
      for (var i = 0; i < r.snapshotLength; i++) {
        var el = r.snapshotItem(i);
        var cs = getComputedStyle(el);
        var b = el.getBoundingClientRect();
        if (b.width > 400 || b.height > 200) continue;
        var txt = (el.textContent || '').trim();
        if (txt.length > 40) continue;
        out.push({ tag: el.tagName, text: txt.slice(0,40), visible: cs.visibility!=='hidden'&&cs.display!=='none', w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.x), y: Math.round(b.y) });
      }
      return { xpath: xpath, count: out.length, items: out };
    } catch (e) { return { error: String(e) }; }
  })()`;
  const r = await cdpSend('Runtime.evaluate', { expression: expr, returnByValue: true });
  return r.result && r.result.value;
}

/* ================= 自动领取积分（轮询点击"立即领取"） ================= */

const CLAIM_TEXTS = (process.env.WBSWITCH_CLAIM_TEXT || '立即领取,今日可领').split(',').map((s) => s.trim()).filter(Boolean);
// 每次切换后轮询总时长（毫秒）。默认 1 秒：100ms 轮询一次，找到"立即领取"即结束。
const CLAIM_MAX_MS = parseInt(process.env.WBSWITCH_CLAIM_MAX_MS || '1000', 10);
const CLAIM_INTERVAL_MS = parseInt(process.env.WBSWITCH_CLAIM_INTERVAL_MS || '100', 10);

// 临时调试日志：把领取查找过程写到 /tmp，方便排查"明明有按钮却识别不到"
function claimDebugFile() {
  return path.join(os.tmpdir(), `wbswitch-claim-${Date.now()}-${process.pid}.log`);
}
function claimLog(file, line) {
  try {
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`);
  } catch (_) {}
}

let batchState = { running: false, total: 0, done: 0, startedAt: 0, last: null };

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 等待页面加载完成（reload 后调用），超时返回 false */
async function waitPageLoaded(timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await cdpSend('Runtime.evaluate', {
        expression: 'document.readyState',
        returnByValue: true,
      });
      if (r.result && r.result.value === 'complete') return true;
    } catch (_) {
      /* 页面正在导航，忽略 */
    }
    await sleep(200);
  }
  return false;
}

/** 找出页面上所有匹配文字、可见、尺寸合理的可点击元素中心坐标。
 *  兼容：shadow DOM、同域 iframe、aria-label/title、React/Vue 事件绑定。
 */
/* ================= 积分自动领取（直接调接口，带每日缓存） ================= */

const CHECKIN_ENDPOINTS = [
  'https://www.workbuddy.cn/billing/meter/daily-checkin',
  'https://www.workbuddy.cn/v2/billing/meter/daily-checkin',
  'https://www.codebuddy.cn/v2/billing/meter/daily-checkin',
];
const CHECKIN_CACHE_FILE = path.join(DATA_DIR, 'checkin-cache.json');
const CHECKIN_REQUEST_TIMEOUT_MS = 12000;
const CHECKIN_QUEUE_DELAY_MS = 250;
let claimInFlight = false;
let checkinState = { running: false, total: 0, done: 0, startedAt: 0, finishedAt: 0 };

function checkinSnapshot() {
  return Object.assign({}, checkinState, { running: !!claimInFlight });
}

function todayStr(d) {
  d = d || new Date();
  const z = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate());
}

function loadCheckinCache() {
  try {
    return JSON.parse(fs.readFileSync(CHECKIN_CACHE_FILE, 'utf8')) || {};
  } catch (_) {
    return {};
  }
}
function saveCheckinCache(cache) {
  try {
    fs.writeFileSync(CHECKIN_CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (e) {
    log('[checkin] 写入缓存失败: ' + e.message);
  }
}

/**
 * 用指定账号 accessToken 调用签到接口（多域名兜底）。
 * 成功 / 已签（code=10001）均视为当日已完成。
 */
async function dailyCheckin(accessToken) {
  let lastErr = null;
  for (const url of CHECKIN_ENDPOINTS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CHECKIN_REQUEST_TIMEOUT_MS);
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/plain, */*',
          'content-type': 'application/json',
          'x-client-platform': 'web',
          origin: 'https://www.workbuddy.cn',
          referer: 'https://www.workbuddy.cn/profile/plans-usage',
          authorization: 'Bearer ' + accessToken,
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
        },
        body: '{}',
        signal: controller.signal,
      });
      const text = await r.text();
      let o = {};
      try { o = JSON.parse(text); } catch (_) {}
      const code = o.code;
      const already = code === 10001;
      const ok = already || (r.ok && (code === 0 || code === undefined || code === null));
      // 401 = token 过期/未授权：直接给友好文案，避免面板显示裸 "HTTP 401"
      const failMsg = r.status === 401 ? '登录身份过期' : 'HTTP ' + r.status;
      const result = { ok, already, code, message: o.msg || o.message || (r.ok ? 'ok' : failMsg), url };
      // 网络异常或服务端错误才切换兜底域名；认证/参数错误直接返回，避免无意义地重复请求。
      if (ok || r.status === 401 || (r.status >= 400 && r.status < 500 && r.status !== 404)) return result;
      lastErr = result.message;
    } catch (e) {
      lastErr = e.name === 'AbortError' ? '请求超时（' + (CHECKIN_REQUEST_TIMEOUT_MS / 1000) + ' 秒）' : e.message;
    } finally {
      clearTimeout(timeout);
    }
  }
  return { ok: false, already: false, code: -1, message: lastErr || '未知错误', url: CHECKIN_ENDPOINTS[0] };
}

/** 对单个账号签到（带每日缓存，幂等：今日已成功过则跳过） */
async function claimDailyForUid(uid) {
  const cache = loadCheckinCache();
  const today = todayStr();
  const hit = cache[uid];
  if (hit && hit.date === today && hit.ok) {
    return { uid, skipped: true, ok: true, already: hit.already, code: hit.code, message: hit.message };
  }
  const file = path.join(DATA_DIR, 'accounts', uid + '.info');
  if (!fs.existsSync(file)) return { uid, ok: false, reason: 'no-backup' };
  let tk = null;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    tk = j.auth && j.auth.accessToken;
  } catch (e) {
    return { uid, ok: false, reason: 'read-token-failed: ' + e.message };
  }
  if (!tk) return { uid, ok: false, reason: 'no-accessToken' };
  const r = await dailyCheckin(tk);
  const rec = { date: today, ok: !!r.ok, already: !!r.already, code: r.code, message: r.message, at: Date.now() };
  cache[uid] = rec;
  saveCheckinCache(cache);
  return { uid, ...rec };
}

/** 对所有账号执行每日签到（自动跳过今日已成功过的，带并发保护） */
async function claimDailyForAll() {
  if (claimInFlight) return { skipped: true, reason: 'in-flight', checkin: checkinSnapshot() };
  claimInFlight = true;
  try {
    const list = listAccounts(DATA_DIR).map((a) => a.uid);
    checkinState = { running: true, total: list.length, done: 0, startedAt: Date.now(), finishedAt: 0 };
    const results = [];
    for (let i = 0; i < list.length; i++) {
      const uid = list[i];
      let result;
      try {
        result = await claimDailyForUid(uid);
      } catch (e) {
        result = { uid, ok: false, reason: e.message };
      }
      results.push(result);
      checkinState.done = i + 1;
      // 账号之间留一点间隔，避免多个账号同时触发服务端限流/连接排队。
      if (i < list.length - 1 && !result.skipped) await sleep(CHECKIN_QUEUE_DELAY_MS);
    }
    log('[checkin] 本轮回检 ' + results.length + ' 个账号');
    return { total: results.length, results };
  } finally {
    checkinState.running = false;
    checkinState.finishedAt = Date.now();
    claimInFlight = false;
  }
}

/** 通过 CDP 把右下角组件注入到 WorkBuddy 渲染进程（幂等，可反复调用） */
function injectWidget(reason) {
  if (!cdp.connected) {
    return Promise.reject(new Error('CDP 未连接，无法注入组件'));
  }
  // 节流：仅抑制 connect 与 page-load 在 <1s 内连发的重复注入（避免闪烁）。
  // 关键：manual（launcher/用户显式 /api/inject）恒不等候、必须无条件注入——
  // 否则 WorkBuddy 重启后仅有的注入机会会被节流吞掉（多台机器 FAB 缺失的根因：
  // launcher 检测到 CDP 就调用 manual，但被 1.5s 节流跳过，页面又不会再触发补种）。
  var now = Date.now();
  if (reason !== 'manual' && now - lastInjectTs < 1000) {
    log(`[cdp] 注入节流跳过 (${reason})`);
    // 兜底：被跳过的自动注入可能是页面刚就绪的唯一一次机会，1.5s 后补种一次（脚本幂等，安全）
    if (!injectRetryTimer) {
      injectRetryTimer = setTimeout(function () {
        injectRetryTimer = null;
        if (cdp.connected) injectWidget('retry').catch(function () {});
      }, 1500);
    }
    return Promise.resolve();
  }
  injectRetryTimer = null;
  lastInjectTs = now;
  let script;
  try {
    script = fs.readFileSync(path.join(__dirname, 'inject.js'), 'utf8');
  } catch (e) {
    return Promise.reject(new Error('读取注入脚本失败: ' + e.message));
  }
  // 组件内通过 fetch 调用本机 API，注入时写入实际端口
  script = script.replace(/__WBS_API__/g, `http://${HOST}:${ACTUAL_PORT}`);
  script = script.replace(/__WBS_TOKEN__/g, API_TOKEN);
  // 同步注入当前 daemon 版本号（inject.js 顶部的 __WBS_VERSION__ 占位符会在面板「关于」页直接展示，
  // 这样版本升级后不需要改 inject.js、面板永远显示 daemon 的真实版本）
  script = script.replace(/__WBS_VERSION__/g, DAEMON_VERSION);
  // 注入策略：不使用 addScriptToEvaluateOnNewDocument（它会在浏览器里持久化注册，
  // 多次重启会叠加旧版本；旧注册先执行并占住 window.__wbsWidget 守卫，导致新代码被拦截）。
  // 改为：先用 Runtime.evaluate 暴力清理任何历史残留（不依赖旧版本的 destroy，避免清不干净），
  // 再 Runtime.evaluate 跑最新文件。脚本顶部自带同样的暴力清理 + 幂等守卫，所以可安全反复注入。
  log(`[cdp] 注入右下角组件 (${reason})`);
  const cleanupExpr =
    'try{if(window.__wbsWidget&&typeof window.__wbsWidget.destroy==="function"){window.__wbsWidget.destroy();}}catch(e){}';
  return cdpSend('Runtime.evaluate', { expression: cleanupExpr, returnByValue: false })
    .catch(() => {})
    .then(() =>
      cdpSend('Runtime.evaluate', {
        expression: script,
        returnByValue: false,
      })
    )
    // 注入脚本若在页面抛错，CDP 协议不报错（无 protocol error），会被误判为"已注入"；
    // 显式检查 exceptionDetails 让失败可见、留痕，便于定位 WorkBuddy 版本差异导致的挂载失败。
    .then((r) => {
      if (r && r.exceptionDetails) {
        const ex = r.exceptionDetails.exception;
        const desc = (ex && (ex.description || ex.value)) || r.exceptionDetails.text || '注入脚本页面抛错';
        log(`[cdp] 注入脚本页面抛错(${reason}): ${String(desc).slice(0, 500)}`);
        return writeDiagnosticsSnapshot('inject-exception').then(() => r);
      }
      return r;
    })
    .then(async (r) => {
      // Runtime.evaluate 本身成功不代表脚本完成挂载；回读 DOM/全局守卫，区分“协议成功”与“用户可见”。
      await new Promise((resolve) => setTimeout(resolve, 120));
      let state = null;
      try {
        const check = await cdpSend('Runtime.evaluate', {
          expression: '({ url: location.href, readyState: document.readyState, body: !!document.body, root: !!document.querySelector(".wbs-root"), widget: !!window.__wbsWidget })',
          returnByValue: true,
        });
        state = check && check.result && check.result.value;
      } catch (e) {
        log(`[cdp] 注入结果校验失败(${reason}): ${e.message}`);
      }
      if (!state || !state.root || !state.widget) {
        log(`[cdp] 注入后未检测到组件(${reason}): ${JSON.stringify(state || {})}`);
        writeDiagnosticsSnapshot('inject-not-mounted').catch(() => {});
        // 页面首屏尚未完成时偶发 body 已存在但应用仍在替换根节点，延迟补试一次。
        if (!String(reason).endsWith('-retry')) {
          setTimeout(() => { if (cdp.connected) injectWidget(String(reason) + '-retry').catch(() => {}); }, 700);
        }
      } else {
        log(`[cdp] 注入结果确认(${reason}): root=true widget=true url=${state.url}`);
      }
      return r;
    })
    .catch((e) => log(`[cdp] 注入失败: ${e.message}`));
}

async function readCdpTargets() {
  if (!cdp.port) return [];
  try {
    const r = await fetch(`http://127.0.0.1:${cdp.port}/json/list`, { signal: AbortSignal.timeout(1500) });
    const list = await r.json();
    return (Array.isArray(list) ? list : []).map((t) => ({ id: t.id, type: t.type, title: t.title, url: t.url }));
  } catch (e) {
    return [{ error: e.message }];
  }
}

function readLogTail(maxLines = 120) {
  try {
    const text = fs.readFileSync(logFile(DATA_DIR), 'utf8');
    return text.split(/\r?\n/).filter(Boolean).slice(-maxLines).map((line) => line
      .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/ig, '$1<redacted>')
      .replace(/(["']?(?:accessToken|refreshToken|token)["']?\s*[:=]\s*["']?)[^"'\s,}]+/ig, '$1<redacted>'));
  } catch (_) {
    return [];
  }
}

async function collectDiagnostics(reason) {
  const result = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    reason: reason || 'manual',
    daemon: { version: DAEMON_VERSION, buildId: DAEMON_BUILD_ID, pid: process.pid, platform: process.platform, arch: process.arch, node: process.version },
    paths: { dataDir: DATA_DIR, logFile: logFile(DATA_DIR), diagnosticsFile: DIAGNOSTICS_FILE, authFile: AUTH_FILE },
    cdp: { connected: cdp.connected, port: cdp.port, targetUrl: cdp.targetUrl, error: cdp.error, targets: await readCdpTargets() },
    injection: null,
    logTail: readLogTail(),
  };
  if (cdp.connected) {
    try {
      const r = await cdpSend('Runtime.evaluate', {
        expression: '({ url: location.href, title: document.title, readyState: document.readyState, body: !!document.body, root: !!document.querySelector(".wbs-root"), widget: !!window.__wbsWidget, diag: !!window.__wbsDiag })',
        returnByValue: true,
      });
      result.injection = r && r.result && r.result.value;
    } catch (e) {
      result.injection = { error: e.message };
    }
  }
  return result;
}

async function writeDiagnosticsSnapshot(reason) {
  try {
    const snapshot = await collectDiagnostics(reason);
    const tmp = DIAGNOSTICS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, DIAGNOSTICS_FILE);
    log(`[diag] 已写入本地诊断快照 (${reason || 'manual'}): ${DIAGNOSTICS_FILE}`);
    return snapshot;
  } catch (e) {
    log(`[diag] 写入诊断快照失败: ${e.message}`);
    return null;
  }
}

/* ================= 本地 Web 服务 ================= */


// ===== SESSIONS_API_MARK：会话管理（读写 WorkBuddy workbuddy.db）=====
function resolveWorkBuddyHome() {
  if (process.env.WBSWITCH_WORKBUDDY_HOME) return process.env.WBSWITCH_WORKBUDDY_HOME;
  const ai = path.join(os.homedir(), '.workbuddy-ai');
  const legacy = path.join(os.homedir(), '.workbuddy');
  if (fs.existsSync(path.join(ai, 'workbuddy.db')) || fs.existsSync(path.join(ai, 'app'))) return ai;
  return legacy;
}
const WORKBUDDY_HOME = resolveWorkBuddyHome();
const SESSIONS_DB = path.join(WORKBUDDY_HOME, 'workbuddy.db');
// Windows：无系统 sqlite3 CLI，优先用 Node 内置 node:sqlite（需 --experimental-sqlite 启动，launcher/install 已统一加）
let NodeSqlite = null;
if (IS_WIN) { try { NodeSqlite = require('node:sqlite'); } catch (_) { NodeSqlite = null; } }
// 输出统一为 "header|header2\nval|val2" 格式，sqliteQuery 的解析两种后端通用
function sqliteIsWrite(sql) {
  // 复制/迁移/删除/恢复会执行写 SQL；其余当前调用均为查询。
  return /^\s*(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|VACUUM|REINDEX|ANALYZE|BEGIN|COMMIT|ROLLBACK|ATTACH|DETACH)\b/i.test(String(sql || ''));
}
function sqliteRun(sql) {
  if (IS_WIN && NodeSqlite) {
    return new Promise((resolve, reject) => {
      let db = null;
      try {
        if (!fs.existsSync(SESSIONS_DB)) throw new Error('数据库不存在: ' + SESSIONS_DB);
        const write = sqliteIsWrite(sql);
        db = new NodeSqlite.DatabaseSync(SESSIONS_DB, { readOnly: !write });
        if (write) {
          db.exec(sql);
          db.close(); db = null;
          return resolve('');
        }
        const rows = db.prepare(sql).all();
        db.close(); db = null;
        if (!rows.length) return resolve('');
        const header = Object.keys(rows[0]).join('|');
        const lines = rows.map((r) =>
          Object.values(r).map((v) => (v === null || v === undefined ? '' : String(v))).join('|')
        );
        resolve([header].concat(lines).join('\n'));
      } catch (e) {
        if (db) { try { db.close(); } catch (_) {} }
        reject(new Error('sqlite 查询失败: ' + e.message));
      }
    });
  }
  return new Promise((resolve, reject) => {
    const p = spawn('sqlite3', ['-header', SESSIONS_DB], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => reject(new Error('sqlite3 不可用: ' + e.message)));
    p.on('close', (code) => {
      if (code !== 0) reject(new Error('sqlite 失败(' + code + '): ' + err.slice(0, 200)));
      else resolve(out);
    });
    p.stdin.end(sql);
  });
}
async function sqliteQuery(sql) {
  const out = await sqliteRun(sql);
  if (!out.trim()) return [];
  const lines = out.trim().split('\n');
  const header = lines[0].split('|');
  return lines.slice(1).map((ln) => {
    const parts = ln.split('|');
    const o = {};
    header.forEach((h, i) => (o[h.trim()] = parts[i] === undefined ? null : parts[i].trim()));
    return o;
  });
}
function sessionRangeMs(range) {
  const now = Date.now();
  const day = 24 * 3600 * 1000;
  if (range === 'today') { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
  if (range === '7d') return now - 7 * day;
  if (range === '30d') return now - 30 * day;
  return 0;
}

// 复制会话的消息文件：projects/<项目>/<id>.jsonl + <id>/、workspace/sessions/<id>/、
// tasks/<id>/、file-history/<id>/、artifact-index/<id>.json（全部以新 id 命名复制）
function copySessionFiles(wbHome, oldId, newId) {
  const fsMod = fs;
  const copyOne = (from, to) => {
    try {
      if (!fsMod.existsSync(from)) return;
      fsMod.mkdirSync(path.dirname(to), { recursive: true });
      fsMod.cpSync(from, to, { recursive: true, force: true });
    } catch (e) { log('[sessions-copy] 复制文件失败 ' + from + ': ' + e.message); }
  };
  // 1) projects/<项目hash>/<id>.jsonl 与 <id>/ 目录（消息正文核心）
  const projDir = path.join(wbHome, 'projects');
  try {
    if (fsMod.existsSync(projDir)) {
      const projs = fsMod.readdirSync(projDir);
      for (const pj of projs) {
        const pjPath = path.join(projDir, pj);
        if (!fsMod.statSync(pjPath).isDirectory()) continue;
        copyOne(path.join(pjPath, oldId + '.jsonl'), path.join(pjPath, newId + '.jsonl'));
        copyOne(path.join(pjPath, oldId), path.join(pjPath, newId));
      }
    }
  } catch (_) {}
  // 2) workspace/sessions/<id>/
  copyOne(path.join(wbHome, 'workspace', 'sessions', oldId), path.join(wbHome, 'workspace', 'sessions', newId));
  // 3) tasks/<id>/
  copyOne(path.join(wbHome, 'tasks', oldId), path.join(wbHome, 'tasks', newId));
  // 4) file-history/<id>/
  copyOne(path.join(wbHome, 'file-history', oldId), path.join(wbHome, 'file-history', newId));
  // 5) artifact-index/<id>.json
  copyOne(path.join(wbHome, 'artifact-index', oldId + '.json'), path.join(wbHome, 'artifact-index', newId + '.json'));
  log('[sessions-copy] 已复制消息文件 ' + oldId + ' -> ' + newId);
}

// 真实删除会话的消息文件：projects/<项目>/<id>.jsonl + <id>/、workspace/sessions/<id>/、
// tasks/<id>/、file-history/<id>/、artifact-index/<id>.json（全部按会话 id 精确删除，不可恢复）
function deleteSessionFiles(wbHome, id) {
  const fsMod = fs;
  let removed = 0;
  const delOne = (p) => {
    try {
      if (fsMod.existsSync(p)) {
        fsMod.rmSync(p, { recursive: true, force: true });
        return true;
      }
    } catch (e) { log('[sessions-delete] 删除文件失败 ' + p + ': ' + e.message); }
    return false;
  };
  // 1) projects/<项目hash>/<id>.jsonl 与 <id>/ 目录（消息正文核心）
  const projDir = path.join(wbHome, 'projects');
  try {
    if (fsMod.existsSync(projDir)) {
      const projs = fsMod.readdirSync(projDir);
      for (const pj of projs) {
        const pjPath = path.join(projDir, pj);
        if (!fsMod.statSync(pjPath).isDirectory()) continue;
        if (delOne(path.join(pjPath, id + '.jsonl'))) removed++;
        if (delOne(path.join(pjPath, id))) removed++;
      }
    }
  } catch (_) {}
  // 2) workspace/sessions/<id>/
  if (delOne(path.join(wbHome, 'workspace', 'sessions', id))) removed++;
  // 3) tasks/<id>/
  if (delOne(path.join(wbHome, 'tasks', id))) removed++;
  // 4) file-history/<id>/
  if (delOne(path.join(wbHome, 'file-history', id))) removed++;
  // 5) artifact-index/<id>.json
  if (delOne(path.join(wbHome, 'artifact-index', id + '.json'))) removed++;
  if (removed) log('[sessions-delete] 已删除消息文件 ' + id + '（' + removed + ' 项）');
  return removed;
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let bytes = 0;
    let tooLarge = false;
    const maxBytes = 16 * 1024 * 1024;
    req.on('data', (c) => {
      if (tooLarge) return;
      bytes += c.length;
      if (bytes > maxBytes) {
        tooLarge = true;
        data = '';
        return;
      }
      data += c;
    });
    req.on('end', () => {
      if (tooLarge) {
        const error = new Error('请求体超过 16 MiB 限制');
        error.statusCode = 413;
        return reject(error);
      }
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        const error = new Error('请求体不是有效 JSON');
        error.statusCode = 400;
        reject(error);
      }
    });
  });
}

function validApiToken(value) {
  const supplied = Buffer.from(String(value || ''), 'utf8');
  const expected = Buffer.from(API_TOKEN, 'utf8');
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

/* ================= 决策弹窗开关（全局自定义指令注入） =================
 * WorkBuddy 官方「自定义指令」(settings.personalization.customPrompt) 会渲染进
 * user-context-identity.tpl 的 <user_custom_instructions> 区块（模板原文：
 * "The user has provided the following custom instructions. You MUST follow them
 * in all responses..."），对每个会话全局生效。
 * 插件在此写入一段「需要用户决策时必须调用 AskUserQuestion 弹窗提问」的规则，
 * 用标记包裹便于开关时精确增删；用户原有的自定义指令内容保留不动。
 */
const ASK_MODE_TAG_START = '<!-- wbs-ask-mode:start -->';
const ASK_MODE_TAG_END = '<!-- wbs-ask-mode:end -->';
const ASK_MODE_RULE = [
  'Always use the AskUserQuestion tool to ask the user for decisions at the conversation level instead of plain chat text.',
  '',
  '1. Use the AskUserQuestion tool when you need the user to make a decision, choose between options, or clarify ambiguous requirements about the DIRECTION of the work (what to build, which approach to take, what trade-offs to accept, etc.).',
  '2. Do NOT pop up a confirmation dialog for routine tool operations that have already been authorized by the user (e.g. file deletion, file modification, batch operations, running shell commands, switching accounts, etc.). Execute them directly. The system-level permission dialogs (such as "允许完全访问" / "Allow Full Access") are handled by WorkBuddy itself — once the user has granted full access, do NOT ask again for individual file operations.',
  '3. Do NOT ask the user for decisions or confirmation in plain chat text.',
  '4. Do NOT produce a final answer while a decision is pending; wait for the user answer to the AskUserQuestion tool.',
  '5. Use concise questions with 2-4 concrete options whenever possible.',
  'Exception: if the AskUserQuestion tool is unavailable in the current channel (e.g. IM), fall back to asking in text.'
].join('\n');

function workbuddySettingsPath() {
  return path.join(WORKBUDDY_HOME, 'settings.json');
}

function readWorkbuddySettings() {
  try {
    return JSON.parse(fs.readFileSync(workbuddySettingsPath(), 'utf8'));
  } catch (_) {
    return {};
  }
}

function writeWorkbuddySettings(settings) {
  const file = workbuddySettingsPath();
  const tmp = file + '.wbs-tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file); // 原子替换，避免写一半被 WorkBuddy 读到
}

function buildAskRuleBlock() {
  return ASK_MODE_TAG_START + '\n' + ASK_MODE_RULE + '\n' + ASK_MODE_TAG_END;
}

/** 从 customPrompt 中移除 wbs 规则段（保留用户其它内容） */
function stripAskRule(customPrompt) {
  if (typeof customPrompt !== 'string') return '';
  const start = customPrompt.indexOf(ASK_MODE_TAG_START);
  const end = customPrompt.indexOf(ASK_MODE_TAG_END);
  if (start === -1 || end === -1 || end < start) return customPrompt.trim();
  const before = customPrompt.slice(0, start);
  const after = customPrompt.slice(end + ASK_MODE_TAG_END.length);
  return (before + after).replace(/\n{3,}/g, '\n\n').trim();
}

function getAskModeState() {
  const settings = readWorkbuddySettings();
  const customPrompt = (settings && settings.personalization && typeof settings.personalization.customPrompt === 'string')
    ? settings.personalization.customPrompt
    : '';
  const enabled = customPrompt.includes(ASK_MODE_TAG_START) && customPrompt.includes(ASK_MODE_TAG_END);
  return {
    enabled,
    hasUserCustomPrompt: !!customPrompt.trim(),
    userCustomPromptPreview: customPrompt
      .replace(/<!-- wbs-ask-mode:start -->[\s\S]*?<!-- wbs-ask-mode:end -->/g, '[wbs 决策弹窗规则段]')
      .slice(0, 120),
  };
}

function setAskMode(enabled) {
  const settings = readWorkbuddySettings();
  if (!settings.personalization || typeof settings.personalization !== 'object') settings.personalization = {};
  const existing = typeof settings.personalization.customPrompt === 'string' ? settings.personalization.customPrompt : '';
  const stripped = stripAskRule(existing);
  if (enabled) {
    settings.personalization.customPrompt = [stripped, buildAskRuleBlock()].filter(Boolean).join('\n\n');
  } else {
    settings.personalization.customPrompt = stripped;
  }
  writeWorkbuddySettings(settings);
  return getAskModeState();
}

/** 启动时调用：如已启用决策弹窗，把旧的 ASK_MODE_RULE 替换为最新版本（用 ASK_MODE_TAG_START/END 精确识别） */
function refreshAskModeIfEnabled() {
  try {
    const state = getAskModeState();
    if (!state.enabled) return;
    setAskMode(true);
    log('[ask-mode] 启动时已刷新决策弹窗规则为最新版本');
  } catch (e) {
    log('[ask-mode] 刷新失败: ' + e.message);
  }
}

function currentAccount() {
  try {
    const c = readAuthFile();
    const a = (c.raw && c.raw.auth) || {};
    return {
      uid: c.uid,
      nickname: c.nickname,
      phone: c.phone,
      uin: c.uin,
      tokenExpiresAt: a.expiresAt || null,
      refreshExpiresAt: a.refreshExpiresAt || null,
      lastRefreshTime: a.lastRefreshTime || null,
    };
  } catch (_) {
    return null;
  }
}

/* ================= 暂存提示词（stash）辅助 ================= */

function stashDir() {
  return path.join(DATA_DIR, 'stash');
}

// 与 /api/stash 写入时相同的 key 生成规则：safe(uid) + '__' + safe(conversationId)
function safeKey(s) {
  return String(s || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
}

/** 扫描 stash 目录，返回全部暂存记录（按 savedAt 倒序）及 uid -> nickname 映射 */
function listStashRecords() {
  const dir = stashDir();
  const records = [];
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (!j || typeof j !== 'object' || !j.conversationId) continue;
        j._key = f.replace(/\.json$/, ''); // 文件名即 key
        records.push(j);
      } catch (_) {
        /* 损坏文件忽略 */
      }
    }
  } catch (_) {
    /* stash 目录不存在 */
  }
  records.sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')));
  const nick = {};
  try {
    for (const a of listAccounts(DATA_DIR)) nick[a.uid] = a.nickname || '';
  } catch (_) {}
  return { records, nick };
}

// key 文件名校验：替换非法字符但不截断（key 本身由 safe() 逐段限制长度，可能超过 80 字符）
function stashFilePath(key) {
  const fname = String(key || '').replace(/[^A-Za-z0-9_-]/g, '_');
  if (!fname || fname.length > 220) throw new Error('非法 key: ' + String(key).slice(0, 40));
  return path.join(stashDir(), fname + '.json');
}

function stashRecordByKey(key) {
  const file = stashFilePath(key);
  if (!fs.existsSync(file)) throw new Error('暂存记录不存在: ' + key);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** 通过 CDP 抓取侧边栏会话列表，返回 conversationId -> 会话名 映射（用于筛选下拉展示会话名而非 id） */
async function fetchConvNames() {
  if (!cdp.connected) return {};
  const expr = `(function(){
    try {
      var map = {};
      var els = document.querySelectorAll('.conversation-item[data-conversation-id],[data-conversation-id]');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        var id = el.getAttribute('data-conversation-id');
        if (!id || map[id]) continue;
        var txt = (el.innerText || el.textContent || '') || '';
        // 第一行是会话标题，后续行是时间等（如 "11小时前"）
        var line = (txt.split('\\n')[0] || '').trim().replace(/\s+/g, ' ').slice(0, 60);
        if (!line) continue;
        map[id] = line;
      }
      return map;
    } catch (e) { return {}; }
  })()`;
  try {
    const r = await cdpSend('Runtime.evaluate', { expression: expr, returnByValue: true });
    return (r.result && r.result.value) || {};
  } catch (_) {
    return {};
  }
}

/** 删除单条暂存记录（删文件 + 同步 stash-index.json） */
function deleteStashRecord(key) {
  const file = stashFilePath(key);
  let deleted = false;
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
    deleted = true;
  }
  const idxFile = path.join(DATA_DIR, 'stash-index.json');
  try {
    const idx = JSON.parse(fs.readFileSync(idxFile, 'utf8')) || [];
    const next = idx.filter((r) => r.key !== key);
    if (next.length !== idx.length) fs.writeFileSync(idxFile, JSON.stringify(next, null, 2));
  } catch (_) {
    /* index 不存在则忽略 */
  }
  return deleted;
}

/**
 * 检测 WorkBuddy 当前是否在回复中（AI 生成消息）。
 * 回复中输入框状态异常，回填图片/文字容易失败，且此时发送会进入 WorkBuddy 的消息队列等回复完成后自动发送——
 * 因此发送暂存提示词前必须先等 AI 空闲。
 */
function buildBusyExpr() {
  return `(function(){
    try {
      var sels = [
        '.assistant-message[class*="loading"]',
        '[class*="_loadingMessage_"]',
        '[class*="_loadingText_"]',
        '[class*="typing"]',
        '[class*="generating"]',
        '[title*="停止"],[aria-label*="停止"]'
      ];
      for (var i = 0; i < sels.length; i++) {
        var els = document.querySelectorAll(sels[i]);
        for (var j = 0; j < els.length; j++) {
          var r = els[j].getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return true;
        }
      }
      return false;
    } catch (e) { return false; }
  })()`;
}

/** 等待 AI 空闲；超时返回 false */
async function waitAiIdle(maxMs = 60000, pollMs = 500) {
  if (!cdp.connected) return true; // CDP 未连接时不等待（后续会报错）
  const expr = buildBusyExpr();
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    try {
      const r = await cdpSend('Runtime.evaluate', { expression: expr, returnByValue: true });
      const busy = (r.result && r.result.value) === true;
      if (!busy) return true;
    } catch (_) {
      return true; // evaluate 异常按空闲处理
    }
    await new Promise((res) => setTimeout(res, pollMs));
  }
  return false;
}

/* ================= 主题系统（WorkBuddy 换肤，VSCode theme 同构） =================
 * 原理：WorkBuddy 界面全部通过 CSS 变量（--wb-* / --wb-color-* / --dc-*）取色，
 * 主题 = 一组「变量 → 颜色」覆盖，注入为 :root 上的 <style> 即可全局换肤。
 * 每个主题一个 JSON 文件，字段：{ id, name, author, dark, colors: { '--wb-bg-primary': '#0d0d0f', ... } }
 */

const THEMES_DIR = path.join(DATA_DIR, 'themes');
// 官方背景图库：面板「主题」页的默认壁纸（wallpaper-01.webp ~ wallpaper-NN.webp）
const WALLPAPERS_DIR = path.join(THEMES_DIR, 'wallpapers');

/** 内置资产源目录（首次启动初始化的来源，WorkDaddy.app 自包含打包）：
 * 1) 脚本同目录 builtin/（app 内置模式：Contents/Resources/scripts/builtin）
 * 2) 项目模式：<项目>/WorkDaddy.app/Contents/Resources/scripts/builtin
 */
function builtinAssetsDir() {
  const cands = [
    path.join(__dirname, 'builtin'),
    path.join(__dirname, '..', 'WorkDaddy.app', 'Contents', 'Resources', 'scripts', 'builtin'),
  ];
  if (process.env.WBSWITCH_DIR) {
    cands.push(path.join(process.env.WBSWITCH_DIR, 'WorkDaddy.app', 'Contents', 'Resources', 'scripts', 'builtin'));
  }
  for (const c of cands) {
    try {
      if (fs.existsSync(path.join(c, 'nebula', 'theme.json')) && fs.existsSync(path.join(c, 'wallpapers'))) return c;
    } catch (_) {}
  }
  return null;
}

/** 内置资产补齐（新电脑 / 数据目录为空 / 资产缺失时）：内置壁纸 + WorkDaddy 主题 + 默认蒙版 10%
 * 幂等：逐项补齐——壁纸缺失才复制、nebula 主题缺失才安装、mask.json 缺失才写，
 * 不覆盖用户已有的自定义/删减内容（已存在的文件不动）。
 */
function initBuiltinAssets() {
  try {
    const src = builtinAssetsDir();
    if (!src) {
      log('[init] 未找到内置资产目录（builtin/），跳过初始化');
      return;
    }
    // 1) 内置壁纸 → themes/wallpapers/（缺哪张补哪张，已有不动）
    const wpSrc = path.join(src, 'wallpapers');
    if (fs.existsSync(wpSrc)) {
      const files = fs.readdirSync(wpSrc).filter((f) => /\.webp$/i.test(f)).sort();
      if (files.length) {
        fs.mkdirSync(WALLPAPERS_DIR, { recursive: true });
        let added = 0;
        for (const f of files) {
          const dest = path.join(WALLPAPERS_DIR, f);
          if (!fs.existsSync(dest)) {
            fs.copyFileSync(path.join(wpSrc, f), dest);
            added++;
          }
        }
        if (added) log(`[init] 补齐内置壁纸 ${added} 张 -> ${WALLPAPERS_DIR}（已有 ${files.length - added} 张保留）`);
      }
    }
    // 2) WorkDaddy 主题（nebula）→ themes/nebula/（缺失才安装，已有不动）
    const thSrc = path.join(src, 'nebula');
    const thDst = path.join(THEMES_DIR, 'nebula');
    if (fs.existsSync(path.join(thSrc, 'theme.json'))) {
      const themeJson = path.join(thDst, 'theme.json');
      if (!fs.existsSync(themeJson)) {
        fs.mkdirSync(thDst, { recursive: true });
        fs.copyFileSync(path.join(thSrc, 'theme.json'), themeJson);
        log('[init] 已安装 WorkDaddy 主题（nebula）');
      }
      const bgSrc = path.join(thSrc, 'background.webp');
      const bgDst = path.join(thDst, 'background.webp');
      if (fs.existsSync(bgSrc) && !fs.existsSync(bgDst)) {
        fs.copyFileSync(bgSrc, bgDst);
        log('[init] 已补齐 nebula 主题背景图');
      }
    }
    // 3) 默认蒙版 10%（仅当 mask.json 不存在，不覆盖用户设置）
    const maskFile = path.join(DATA_DIR, 'mask.json');
    if (!fs.existsSync(maskFile)) {
      fs.writeFileSync(maskFile, JSON.stringify({ opacity: 0.1 }, null, 2));
      log('[init] 首次初始化：背景蒙版默认 10% -> mask.json');
    }
    // 4) 默认主题 → WorkBuddy 默认主题（仅当未设置过；用户要求默认选中官方浅色，不再默认 nebula）
    const curFile = path.join(DATA_DIR, 'current-theme.json');
    if (!fs.existsSync(curFile)) {
      fs.writeFileSync(curFile, JSON.stringify({ id: 'default', at: new Date().toISOString() }, null, 2));
      log('[init] 首次初始化：默认主题 -> WorkBuddy 默认主题（default）');
    }
  } catch (e) {
    log('[init] 首次初始化失败: ' + e.message);
  }
}

/** 内置主题（默认 + 3 套示例） */
const BUILTIN_THEMES = {
  default: { id: 'default', name: '默认（浅色）', author: 'WorkBuddy', dark: false, colors: {} },
  'oled-dark': {
    id: 'oled-dark', name: 'OLED 纯黑', author: 'wbs', dark: true,
    colors: {
      // ---- vscode 主题变量（body 层，整体布局：编辑器/侧边栏/活动栏/tab/输入框/菜单/按钮/列表等）----
      '--vscode-editor-background': '#0a0a0c', '--vscode-editor-foreground': '#e6e6e9',
      '--vscode-sideBar-background': '#0d0d10', '--vscode-sideBar-foreground': '#c8c8cc', '--vscode-sideBar-border': '#1c1c22',
      '--vscode-activityBar-background': '#0d0d10', '--vscode-activityBar-foreground': '#e6e6e9',
      '--vscode-activityBar-inactiveForeground': 'rgba(230,230,233,0.45)',
      '--vscode-activityBarBadge-background': '#e6e6e9', '--vscode-activityBarBadge-foreground': '#0a0a0c',
      '--vscode-titleBar-activeBackground': '#0a0a0c', '--vscode-titleBar-activeForeground': '#e6e6e9',
      '--vscode-tab-activeBackground': '#0a0a0c', '--vscode-tab-activeForeground': '#e6e6e9',
      '--vscode-tab-inactiveBackground': '#101014', '--vscode-tab-inactiveForeground': 'rgba(230,230,233,0.5)',
      '--vscode-tab-border': '#1c1c22',
      '--vscode-input-background': '#131316', '--vscode-input-foreground': '#e6e6e9',
      '--vscode-input-border': '#2a2a30', '--vscode-input-placeholderForeground': 'rgba(230,230,233,0.4)',
      '--vscode-button-background': 'rgba(255,255,255,0.92)', '--vscode-button-foreground': '#0a0a0c',
      '--vscode-button-hoverBackground': 'rgba(255,255,255,0.8)',
      '--vscode-list-activeSelectionBackground': 'rgba(255,255,255,0.1)', '--vscode-list-activeSelectionForeground': '#ffffff',
      '--vscode-list-hoverBackground': 'rgba(255,255,255,0.06)', '--vscode-list-inactiveSelectionBackground': 'rgba(255,255,255,0.08)',
      '--vscode-menu-background': '#131316', '--vscode-menu-foreground': '#e6e6e9',
      '--vscode-dropdown-background': '#131316', '--vscode-dropdown-foreground': '#e6e6e9', '--vscode-dropdown-border': '#2a2a30',
      '--vscode-panel-background': '#0a0a0c', '--vscode-panel-border': '#1c1c22',
      '--vscode-badge-background': 'rgba(255,255,255,0.16)', '--vscode-badge-foreground': '#e6e6e9',
      '--vscode-foreground': '#e6e6e9', '--vscode-descriptionForeground': 'rgba(230,230,233,0.7)',
      '--vscode-focusBorder': 'rgba(255,255,255,0.4)',
      '--vscode-scrollbarSlider-background': 'rgba(255,255,255,0.2)', '--vscode-scrollbarSlider-hoverBackground': 'rgba(255,255,255,0.3)',
      '--vscode-editorGroupHeader-tabsBackground': '#0d0d10', '--vscode-editorGroupHeader-tabsBorder': '#1c1c22',
      '--vscode-editorGroup-border': '#1c1c22', '--vscode-statusBar-background': '#0d0d10', '--vscode-statusBar-foreground': '#e6e6e9',
      '--vscode-checkbox-background': '#131316', '--vscode-checkbox-border': '#2a2a30', '--vscode-checkbox-foreground': '#e6e6e9',
      '--vscode-editorWidget-background': '#131316', '--vscode-editorWidget-border': '#2a2a30',
      // ---- wb 组件 token（:root 层）----
      '--wb-bg-primary': '#0a0a0c', '--wb-bg-secondary': '#131316', '--wb-bg-tertiary': '#1b1b20',
      '--wb-bg-popover': '#131316', '--wb-bg-hover': 'color-mix(in srgb,#ffffff 7%,transparent)',
      '--wb-bg-active': 'color-mix(in srgb,#ffffff 10%,transparent)', '--wb-bg-overlay': 'rgba(0,0,0,0.7)',
      '--wb-text-strong': '#e6e6e9', '--wb-text-medium': 'rgba(230,230,233,0.72)',
      '--wb-text-muted': 'rgba(230,230,233,0.42)', '--wb-text-weak': 'rgba(230,230,233,0.55)',
      '--wb-color-text-primary': '#e6e6e9', '--wb-color-text-secondary': 'rgba(230,230,233,0.72)',
      '--wb-color-text-tertiary': 'rgba(230,230,233,0.55)', '--wb-color-text-disabled': 'rgba(230,230,233,0.42)',
      '--wb-border-default': 'color-mix(in srgb,#ffffff 13%,transparent)', '--wb-border-subtle': '#202025',
      '--wb-border-strong': '#2c2c33', '--wb-border-hover': 'color-mix(in srgb,#ffffff 22%,transparent)',
      '--wb-button-primary-bg': 'rgba(255,255,255,0.92)', '--wb-button-primary-fg': '#0a0a0c',
      '--wb-button-primary-bg-hover': 'rgba(255,255,255,0.8)',
      '--wb-status-success': '#2ee59d', '--wb-status-warning': '#ffb03a',
      '--wb-status-error': '#ff6b6b', '--wb-status-info': '#3fd6c0',
      '--wb-card-bg': '#131316', '--wb-kb-tabs-container-bg': '#101013', '--wb-kb-tabs-container-border': '#1e1e24',
      '--wb-kb-card-bg': '#131316', '--wb-kb-card-bg-soft': '#16161b', '--wb-kb-card-border': '#232329',
      '--dc-bg-primary': '#0a0a0c', '--dc-bg-secondary': '#131316', '--dc-bg-tertiary': '#1b1b20',
      '--dc-bg-hover': '#1d1d22', '--dc-text-primary': 'rgba(255,255,255,0.88)',
      '--dc-text-secondary': 'rgba(255,255,255,0.62)', '--dc-text-tertiary': 'rgba(255,255,255,0.42)',
      '--dc-border': 'rgba(255,255,255,0.12)', '--dc-border-light': 'rgba(255,255,255,0.07)',
      '--dc-card-bg': '#131316', '--dc-primary': '#ffffff', '--dc-primary-hover': '#e0e0e0',
      '--dc-primary-active': '#ffffff', '--dc-btn-text': '#0a0a0c',
    },
  },
  'eye-care': {
    id: 'eye-care', name: '护眼绿', author: 'wbs', dark: false,
    colors: {
      // ---- vscode 主题变量（body 层）----
      '--vscode-editor-background': '#f0f5ec', '--vscode-editor-foreground': '#2b3a26',
      '--vscode-sideBar-background': '#e7efe0', '--vscode-sideBar-foreground': '#3b4a36', '--vscode-sideBar-border': '#d9e3cf',
      '--vscode-activityBar-background': '#e7efe0', '--vscode-activityBar-foreground': '#2b3a26',
      '--vscode-activityBar-inactiveForeground': 'rgba(43,58,38,0.5)',
      '--vscode-activityBarBadge-background': '#3b6d11', '--vscode-activityBarBadge-foreground': '#ffffff',
      '--vscode-titleBar-activeBackground': '#f0f5ec', '--vscode-titleBar-activeForeground': '#2b3a26',
      '--vscode-tab-activeBackground': '#f0f5ec', '--vscode-tab-activeForeground': '#2b3a26',
      '--vscode-tab-inactiveBackground': '#e7efe0', '--vscode-tab-inactiveForeground': 'rgba(43,58,38,0.5)',
      '--vscode-tab-border': '#d9e3cf',
      '--vscode-input-background': '#ffffff', '--vscode-input-foreground': '#2b3a26',
      '--vscode-input-border': '#c3d2b5', '--vscode-input-placeholderForeground': 'rgba(43,58,38,0.45)',
      '--vscode-button-background': '#3b6d11', '--vscode-button-foreground': '#ffffff',
      '--vscode-button-hoverBackground': '#4a8517',
      '--vscode-list-activeSelectionBackground': 'rgba(59,109,17,0.12)', '--vscode-list-activeSelectionForeground': '#2b3a26',
      '--vscode-list-hoverBackground': 'rgba(59,109,17,0.07)', '--vscode-list-inactiveSelectionBackground': 'rgba(59,109,17,0.08)',
      '--vscode-menu-background': '#ffffff', '--vscode-menu-foreground': '#2b3a26',
      '--vscode-dropdown-background': '#ffffff', '--vscode-dropdown-foreground': '#2b3a26', '--vscode-dropdown-border': '#c3d2b5',
      '--vscode-panel-background': '#f0f5ec', '--vscode-panel-border': '#d9e3cf',
      '--vscode-badge-background': '#3b6d11', '--vscode-badge-foreground': '#ffffff',
      '--vscode-foreground': '#2b3a26', '--vscode-descriptionForeground': 'rgba(43,58,38,0.7)',
      '--vscode-focusBorder': 'rgba(59,109,17,0.5)',
      '--vscode-scrollbarSlider-background': 'rgba(43,58,38,0.2)', '--vscode-scrollbarSlider-hoverBackground': 'rgba(43,58,38,0.3)',
      '--vscode-editorGroupHeader-tabsBackground': '#e7efe0', '--vscode-editorGroupHeader-tabsBorder': '#d9e3cf',
      '--vscode-editorGroup-border': '#d9e3cf', '--vscode-statusBar-background': '#e7efe0', '--vscode-statusBar-foreground': '#2b3a26',
      '--vscode-checkbox-background': '#ffffff', '--vscode-checkbox-border': '#c3d2b5', '--vscode-checkbox-foreground': '#2b3a26',
      '--vscode-editorWidget-background': '#ffffff', '--vscode-editorWidget-border': '#c3d2b5',
      // ---- wb 组件 token（:root 层）----
      '--wb-bg-primary': '#f0f5ec', '--wb-bg-secondary': '#e7efe0', '--wb-bg-tertiary': '#dce7d3',
      '--wb-bg-popover': '#f5f9f1', '--wb-bg-hover': 'color-mix(in srgb,#3b6d11 6%,transparent)',
      '--wb-bg-active': 'color-mix(in srgb,#3b6d11 10%,transparent)',
      '--wb-text-strong': '#2b3a26', '--wb-text-medium': 'rgba(43,58,38,0.72)',
      '--wb-text-muted': 'rgba(43,58,38,0.42)', '--wb-text-weak': 'rgba(43,58,38,0.55)',
      '--wb-color-text-primary': '#2b3a26', '--wb-color-text-secondary': 'rgba(43,58,38,0.72)',
      '--wb-color-text-tertiary': 'rgba(43,58,38,0.55)', '--wb-color-text-disabled': 'rgba(43,58,38,0.42)',
      '--wb-border-default': 'color-mix(in srgb,#3b6d11 14%,transparent)', '--wb-border-subtle': '#d9e3cf',
      '--wb-border-strong': '#c3d2b5', '--wb-border-hover': 'color-mix(in srgb,#3b6d11 24%,transparent)',
      '--wb-button-primary-bg': '#3b6d11', '--wb-button-primary-fg': '#ffffff',
      '--wb-button-primary-bg-hover': '#4a8517',
      '--wb-status-success': '#3b8c2e', '--wb-status-warning': '#b8860b',
      '--wb-status-error': '#c0392b', '--wb-status-info': '#2e8b8b',
      '--wb-card-bg': '#f5f9f1', '--wb-kb-tabs-container-bg': '#e3ebda', '--wb-kb-tabs-container-border': '#d2dec6',
      '--dc-bg-primary': '#f0f5ec', '--dc-bg-secondary': '#e7efe0', '--dc-bg-tertiary': '#dce7d3',
      '--dc-bg-hover': '#dfe9d5', '--dc-text-primary': 'rgba(43,58,38,0.88)',
      '--dc-text-secondary': 'rgba(43,58,38,0.62)', '--dc-border': 'rgba(59,109,17,0.15)',
      '--dc-border-light': 'rgba(59,109,17,0.09)', '--dc-card-bg': '#f5f9f1',
      '--dc-primary': '#3b6d11', '--dc-primary-hover': '#4a8517', '--dc-btn-text': '#ffffff',
    },
  },
  'cyber-purple': {
    id: 'cyber-purple', name: '赛博紫', author: 'wbs', dark: true,
    colors: {
      // ---- vscode 主题变量（body 层）----
      '--vscode-editor-background': '#12101e', '--vscode-editor-foreground': '#e8e5ff',
      '--vscode-sideBar-background': '#151227', '--vscode-sideBar-foreground': '#c8c2ea', '--vscode-sideBar-border': '#2a2450',
      '--vscode-activityBar-background': '#151227', '--vscode-activityBar-foreground': '#e8e5ff',
      '--vscode-activityBar-inactiveForeground': 'rgba(232,229,255,0.45)',
      '--vscode-activityBarBadge-background': '#7f77dd', '--vscode-activityBarBadge-foreground': '#ffffff',
      '--vscode-titleBar-activeBackground': '#12101e', '--vscode-titleBar-activeForeground': '#e8e5ff',
      '--vscode-tab-activeBackground': '#12101e', '--vscode-tab-activeForeground': '#e8e5ff',
      '--vscode-tab-inactiveBackground': '#1a1729', '--vscode-tab-inactiveForeground': 'rgba(232,229,255,0.5)',
      '--vscode-tab-border': '#2a2450',
      '--vscode-input-background': '#1a1729', '--vscode-input-foreground': '#e8e5ff',
      '--vscode-input-border': '#3a3160', '--vscode-input-placeholderForeground': 'rgba(232,229,255,0.4)',
      '--vscode-button-background': '#7f77dd', '--vscode-button-foreground': '#ffffff',
      '--vscode-button-hoverBackground': '#938ce6',
      '--vscode-list-activeSelectionBackground': 'rgba(127,119,221,0.28)', '--vscode-list-activeSelectionForeground': '#ffffff',
      '--vscode-list-hoverBackground': 'rgba(127,119,221,0.14)', '--vscode-list-inactiveSelectionBackground': 'rgba(127,119,221,0.18)',
      '--vscode-menu-background': '#1a1729', '--vscode-menu-foreground': '#e8e5ff',
      '--vscode-dropdown-background': '#1a1729', '--vscode-dropdown-foreground': '#e8e5ff', '--vscode-dropdown-border': '#3a3160',
      '--vscode-panel-background': '#12101e', '--vscode-panel-border': '#2a2450',
      '--vscode-badge-background': '#7f77dd', '--vscode-badge-foreground': '#ffffff',
      '--vscode-foreground': '#e8e5ff', '--vscode-descriptionForeground': 'rgba(232,229,255,0.7)',
      '--vscode-focusBorder': 'rgba(159,148,235,0.5)',
      '--vscode-scrollbarSlider-background': 'rgba(159,148,235,0.25)', '--vscode-scrollbarSlider-hoverBackground': 'rgba(159,148,235,0.4)',
      '--vscode-editorGroupHeader-tabsBackground': '#151227', '--vscode-editorGroupHeader-tabsBorder': '#2a2450',
      '--vscode-editorGroup-border': '#2a2450', '--vscode-statusBar-background': '#151227', '--vscode-statusBar-foreground': '#e8e5ff',
      '--vscode-checkbox-background': '#1a1729', '--vscode-checkbox-border': '#3a3160', '--vscode-checkbox-foreground': '#e8e5ff',
      '--vscode-editorWidget-background': '#1a1729', '--vscode-editorWidget-border': '#3a3160',
      // ---- wb 组件 token（:root 层）----
      '--wb-bg-primary': '#12101e', '--wb-bg-secondary': '#1a1729', '--wb-bg-tertiary': '#221d35',
      '--wb-bg-popover': '#1a1729', '--wb-bg-hover': 'color-mix(in srgb,#7f77dd 10%,transparent)',
      '--wb-bg-active': 'color-mix(in srgb,#7f77dd 16%,transparent)',
      '--wb-text-strong': '#e8e5ff', '--wb-text-medium': 'rgba(232,229,255,0.75)',
      '--wb-text-muted': 'rgba(232,229,255,0.45)', '--wb-text-weak': 'rgba(232,229,255,0.58)',
      '--wb-color-text-primary': '#e8e5ff', '--wb-color-text-secondary': 'rgba(232,229,255,0.75)',
      '--wb-color-text-tertiary': 'rgba(232,229,255,0.58)', '--wb-color-text-disabled': 'rgba(232,229,255,0.45)',
      '--wb-border-default': 'color-mix(in srgb,#7f77dd 20%,transparent)', '--wb-border-subtle': '#262140',
      '--wb-border-strong': '#3a3160', '--wb-border-hover': 'color-mix(in srgb,#a99ff0 30%,transparent)',
      '--wb-button-primary-bg': '#7f77dd', '--wb-button-primary-fg': '#ffffff',
      '--wb-button-primary-bg-hover': '#938ce6',
      '--wb-status-success': '#5ddfb0', '--wb-status-warning': '#f2b94d',
      '--wb-status-error': '#f27e9b', '--wb-status-info': '#7fd0e8',
      '--wb-card-bg': '#1a1729', '--wb-kb-tabs-container-bg': '#151227', '--wb-kb-tabs-container-border': '#2a2450',
      '--dc-bg-primary': '#12101e', '--dc-bg-secondary': '#1a1729', '--dc-bg-tertiary': '#221d35',
      '--dc-bg-hover': '#241f3c', '--dc-text-primary': 'rgba(255,255,255,0.88)',
      '--dc-text-secondary': 'rgba(255,255,255,0.62)', '--dc-text-tertiary': 'rgba(255,255,255,0.42)',
      '--dc-border': 'rgba(127,119,221,0.28)', '--dc-border-light': 'rgba(127,119,221,0.16)',
      '--dc-card-bg': '#1a1729', '--dc-primary': '#7f77dd', '--dc-primary-hover': '#938ce6',
      '--dc-btn-text': '#ffffff',
    },
  },
};

/** 主题列表（内置 + 用户自定义；自定义文件与内置同名时以文件为准，不重复列出） */
function listThemes() {
  const themes = Object.values(BUILTIN_THEMES).map((t) => ({ id: t.id, name: t.name, author: t.author, dark: t.dark, builtin: true }));
  try {
    if (fs.existsSync(THEMES_DIR)) {
      for (const f of fs.readdirSync(THEMES_DIR)) {
        // 兼容两种布局：themes/<id>.json（扁平）与 themes/<id>/theme.json（目录）
        let t = null;
        const flatPath = path.join(THEMES_DIR, f);
        if (f.endsWith('.json')) {
          try { t = JSON.parse(fs.readFileSync(flatPath, 'utf8')); } catch (_) { continue; }
        } else {
          const subPath = path.join(flatPath, 'theme.json');
          if (!fs.statSync(flatPath).isDirectory() || !fs.existsSync(subPath)) continue;
          try { t = JSON.parse(fs.readFileSync(subPath, 'utf8')); } catch (_) { continue; }
        }
        if (!t || !t.id || !t.colors) continue;
        const existing = themes.findIndex((x) => x.id === t.id);
        const item = { id: t.id, name: t.name || t.id, author: t.author || 'unknown', dark: !!t.dark, builtin: false };
        if (existing >= 0) themes[existing] = item; // 覆盖内置
        else themes.push(item);
      }
    }
  } catch (_) {}
  return themes;
}

/** 取主题完整定义（含 colors）。优先读 themes/ 目录的自定义文件（可覆盖内置同名主题），否则回退内置 */
function getTheme(id) {
  // 先查文件（用户自定义或覆盖内置的完整版）——支持 themes/<id>.json 与 themes/<id>/theme.json 两种布局
  try {
    const safeId = id.replace(/[^A-Za-z0-9_-]/g, '_');
    let t = null;
    const flat = path.join(THEMES_DIR, safeId + '.json');
    if (fs.existsSync(flat)) {
      t = JSON.parse(fs.readFileSync(flat, 'utf8'));
    } else {
      const sub = path.join(THEMES_DIR, safeId, 'theme.json');
      if (fs.existsSync(sub)) t = JSON.parse(fs.readFileSync(sub, 'utf8'));
    }
    if (t && t.colors) return t;
  } catch (_) {}
  if (BUILTIN_THEMES[id]) return BUILTIN_THEMES[id];
  return null;
}

/** 恢复已保存的主题（CDP 连接/页面刷新后调用）：读取 current-theme.json 重新应用，保证深浅色在重启/刷新后仍生效 */
async function restoreSavedTheme() {
  if (!cdp.connected) return;
  let id = 'default';
  try {
    const f = path.join(DATA_DIR, 'current-theme.json');
    if (fs.existsSync(f)) id = String(JSON.parse(fs.readFileSync(f, 'utf8')).id || 'default');
  } catch (_) {}
  if (id === 'default') return; // 默认主题 = 官方浅色，无需处理
  await applyThemeByCdp(id);
}

/** 应用主题：通过 CDP 注入主题样式。
 * 原理（逆向 WorkBuddy 主题机制后确认）：
 * 1) 设计 token（--wb-*、--dc-*、--vscode-*）定义在 `:root, body[data-vscode-theme-name="IDE Light"]`
 *    联合选择器上，且部分组件（.teams-container 等）有**局部硬编码覆盖**（优先级更高）——
 *    只改 :root / body 无效，必须对这些局部容器追加同层覆盖。
 * 2) WorkBuddy 自带深色模式：`html[data-theme="dark"]`/`html.cb-dark`/`body[data-vscode-theme-name="IDE Night"]`
 *    分支下这些变量（含局部硬编码）都有官方深色值。
 * 因此正确做法：深色主题先切到官方深色模式（局部变量全部变深），再注入自定义色板
 * （body[data-vscode-theme-name] 同优先级后插入胜出 + 局部容器追加覆盖）；浅色主题只注入自定义色板。
 */
// 已知有局部变量硬编码覆盖的容器（选择器 -> 主题 colors 里对应的变量名）
const LOCAL_THEME_OVERRIDES = [
  { sel: '.teams-container.is-mac', vars: ['--wb-home-bg-primary', '--wb-home-bg-secondary'] },
  { sel: '.project-detail-view__chat-input', vars: ['--wb-bg-primary'] },
  { sel: '.project-detail-view__chat-input--task', vars: ['--wb-bg-primary', '--wb-color-border-secondary'] },
  { sel: '[class*="mainArea"]', vars: ['--wb-bg-hover'] },
  { sel: '.workbuddy-collab', vars: ['--wb-border-info', '--wb-bg-info', '--wb-bg-action'] },
];

/** 生成 markdown 表格 + 输入框渐变的主题跟随样式（追加到主题 CSS 末尾）。
 * - markdown 表格：WorkBuddy 用 --cb-markdown-table-* 变量，但浅色分支（.light 类）会继承白底值，
 *   需在 .cb-markdown 元素上直接定义（直接定义 > 继承），颜色引用主题变量实现跟随。
 * - 输入框上方渐变：.input-area-container::before 用 var(--cb-colleagues-dashboard-bg, #FAFAFA)，
 *   浅色下变量未定义回退白色，深色下需定义为主题背景色。
 */
// ===== 样式补丁热插拔 =====
// 所有针对 WorkBuddy 界面的样式补丁集中在 scripts/theme-patches.js（独立模块，按 {id, desc, css} 组织）。
// 热加载：修改 theme-patches.js 后重新 POST /api/theme-apply 即生效，无需重启 daemon。
// WorkBuddy 升级导致样式失效时：面板 🔍/DevTools 定位失效组件 → 改 theme-patches.js 对应补丁 → 重应用。
let _patchesCache = null;
let _patchesMtime = 0;
function loadThemePatches() {
  try {
    const f = path.join(__dirname, 'theme-patches.js');
    const st = fs.statSync(f);
    if (!_patchesCache || st.mtimeMs !== _patchesMtime) {
      delete require.cache[require.resolve(f)];
      _patchesCache = require(f);
      _patchesMtime = st.mtimeMs;
    }
    return _patchesCache || [];
  } catch (e) {
    log('[theme] 样式补丁加载失败: ' + e.message);
    return [];
  }
}
/** 主题附加样式：从 theme-patches.js 热加载，不硬编码在此 */
function themeExtrasCss() {
  return loadThemePatches().map((p) => (p && p.css ? p.css : '')).join('');
}

async function applyThemeByCdp(id) {
  if (!cdp.connected) throw new Error('CDP 未连接');
  const theme = getTheme(id);
  const colors = (theme && theme.colors) || {};
  const allCssStr = Object.keys(colors).map((k) => k + ':' + colors[k] + ';').join('');
  // 局部容器覆盖：对已知硬编码容器追加同层变量（body[data-vscode-theme-name] 提升优先级）
  let localCssStr = '';
  for (const loc of LOCAL_THEME_OVERRIDES) {
    const parts = [];
    for (const v of loc.vars) {
      if (colors[v]) parts.push(v + ':' + colors[v] + ';');
    }
    if (parts.length) localCssStr += 'body[data-vscode-theme-name] ' + loc.sel + '{' + parts.join('') + '}';
  }
  const extrasCss = themeExtrasCss();
  const isDark = !!(theme && theme.dark);
  // 背景图：主题 JSON 带 image 字段时，从 themes/<id>/<image> 读取转 data URL（WBSS 方案：#root 背景 + 容器透明化）
  let bgCssStr = '';
  if (theme && theme.image) {
    try {
      const safeId = String(theme.id || id).replace(/[^A-Za-z0-9_-]/g, '_');
      const candidates = [
        path.join(THEMES_DIR, safeId, String(theme.image).replace(/^\.\.?[/\\]/, '')),
        path.join(THEMES_DIR, safeId, 'background.' + String(theme.image).split('.').pop()),
        path.join(THEMES_DIR, String(theme.image).replace(/^\.\.?[/\\]/, '')),
      ];
      let imgPath = null;
      for (const c of candidates) {
        if (fs.existsSync(c)) { imgPath = c; break; }
      }
      // 兜底：按文件名在 themes 所有子目录里搜索（兼容旧 build 上传时目录 id 与主题 id 不一致的情况）
      if (!imgPath) {
        try {
          const wanted = String(theme.image).split('/').pop().split('\\').pop();
          for (const sub of fs.readdirSync(THEMES_DIR)) {
            const p = path.join(THEMES_DIR, sub, wanted);
            if (fs.existsSync(p)) { imgPath = p; break; }
          }
        } catch (_) {}
      }
      if (imgPath) {
        const buf = fs.readFileSync(imgPath);
        const ext = path.extname(imgPath).toLowerCase().replace('.jpeg', '.jpg');
        const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
        const dataUrl = 'data:' + mime + ';base64,' + buf.toString('base64');
        // WBSS 背景图方案：背景图铺 #root，容器透明 + 半透明毛玻璃让底图透出
        // 遮罩/半透明度调低（40%/34%/30%）：背景图偏暗时让图更透出，毛玻璃更可见
        // 全局黑色蒙版（默认 0.1，面板主题页可调）：rgba(0,0,0,α) 压在最上层，让背景图更沉、文字更可读
        const maskFile = path.join(DATA_DIR, 'mask.json');
        let mask = 0.3;
        try {
          if (fs.existsSync(maskFile)) mask = Math.min(1, Math.max(0, parseFloat(JSON.parse(fs.readFileSync(maskFile, 'utf8')).opacity) || 0.1));
        } catch (_) {}
        bgCssStr = [
          '#root{background:',
          'linear-gradient(rgba(0,0,0,' + mask + '),rgba(0,0,0,' + mask + ')),',
          'linear-gradient(90deg,color-mix(in srgb,var(--wb-bg-primary) 40%,transparent) 0 18%,transparent 42%),',
          'linear-gradient(180deg,transparent 0 58%,color-mix(in srgb,var(--wb-bg-primary) 50%,transparent) 100%),',
          'url(' + dataUrl + ') right center / cover no-repeat fixed !important;}',
          'body[data-vscode-theme-name] .teams-container,body[data-vscode-theme-name] .teams-container.is-mac{background:transparent !important}',
          'body[data-vscode-theme-name] [data-view-id]{background:transparent !important}',
          'body[data-vscode-theme-name] .main-content{background:transparent !important}',
          // 左侧菜单（会话列表）半透明毛玻璃：背景图透出 + 模糊
          'body[data-vscode-theme-name] .conversation-list,body[data-vscode-theme-name] [data-view-id=sidebar]{background:color-mix(in srgb,var(--wb-bg-primary) 34%,transparent) !important;backdrop-filter:blur(26px) saturate(1.2);-webkit-backdrop-filter:blur(26px) saturate(1.2)}',
          // 输入框区域：毛玻璃背景（用户要求加回：半透明 + 模糊，背景图透出）
          // 注意：聊天页 [class*="input-area-container"] 父容器改为透明（patch-40 处理），
          // 主页 .wb-home-composer 也改为透明（patch-37），毛玻璃只保留在输入框主体 _mainArea（patch-40）。
          'body[data-vscode-theme-name] [class*="chat-input"]{background:color-mix(in srgb,var(--wb-bg-primary) 40%,transparent) !important;backdrop-filter:blur(20px) saturate(1.15);-webkit-backdrop-filter:blur(20px) saturate(1.15)}',
          // 主内容区底部渐变保证可读
          'body[data-vscode-theme-name] [data-view-id=main-content]{background:linear-gradient(180deg,transparent 0 38%,color-mix(in srgb,var(--wb-bg-primary) 55%,transparent) 100%) !important}',
        ].join('');
      }
    } catch (e) {
      log('[theme] 背景图加载失败: ' + e.message);
    }
  }
  const expr = `(function(){
    var h = document.documentElement, b = document.body;
    var s = document.getElementById('wbs-theme-style');
    if (s) s.remove();
    if (${id === 'default' ? 'true' : 'false'}) {
      // 默认主题：完全恢复官方浅色（移除 dark 标记，body 恢复官方浅色主题名）
      h.removeAttribute('data-theme'); h.classList.remove('cb-dark');
      b.setAttribute('data-vscode-theme-name', 'IDE Light'); b.classList.remove('vscode-dark');
    } else {
      if (${isDark ? 'true' : 'false'}) {
        // 深色主题：切官方深色模式（局部硬编码变量随之变深）
        h.setAttribute('data-theme', 'dark');
        h.classList.add('cb-dark');
        b.setAttribute('data-vscode-theme-name', 'IDE Night');
        b.classList.add('vscode-dark');
      } else {
        // 浅色主题：保持官方浅色主题名（选择器 body[data-vscode-theme-name] 需匹配）
        h.removeAttribute('data-theme'); h.classList.remove('cb-dark');
        b.setAttribute('data-vscode-theme-name', 'IDE Light'); b.classList.remove('vscode-dark');
      }
      // 注入自定义色板（body 层覆盖，同优先级后插入胜出）
      var css = 'body[data-vscode-theme-name]{' + ${JSON.stringify(allCssStr)} + '}' + ${JSON.stringify(localCssStr)} + ${JSON.stringify(extrasCss)} + ${JSON.stringify(bgCssStr)};
      var st = document.createElement('style');
      st.id = 'wbs-theme-style';
      st.textContent = css;
      document.head.appendChild(st);
    }
    var cs = getComputedStyle(b);
    return { applied: ${id === 'default' ? 'false' : 'true'}, dark: ${isDark ? 'true' : 'false'}, bg: cs.getPropertyValue('--vscode-editor-background').trim(), text: cs.getPropertyValue('--vscode-editor-foreground').trim() };
  })()`;
  const r = await cdpSend('Runtime.evaluate', { expression: expr, returnByValue: true });
  const v = r.result && r.result.value;
  if (!v) throw new Error('应用主题失败');
  return { ok: true, applied: v.applied, dark: v.dark, bg: v.bg, text: v.text };
}

/**
 * 通过 CDP 清空 WorkBuddy 输入框（点暂存按钮入队成功后调用，让输入框内容随之清空）。
 * 实现：focus -> range 全选 -> execCommand('delete')。
 * 注意：不能用 CDP Input.dispatchKeyEvent 模拟 Cmd+A —— 在此环境会挂起（页面主线程无响应）。
 */
async function clearComposerByCdp() {
  if (!cdp.connected) throw new Error('CDP 未连接');
  const expr = `(function(){
    try {
      var mic = document.querySelector('.voice-mic-wrap');
      var ed = null;
      if (mic) {
        var p = mic.parentElement;
        for (var up = 0; up < 6 && p; up++) {
          var e = p.querySelector('[contenteditable="true"]');
          if (e) { ed = e; break; }
          p = p.parentElement;
        }
      }
      if (!ed) return { ok: false, error: 'no editor' };
      ed.focus();
      var sel = window.getSelection();
      var range = document.createRange();
      range.selectNodeContents(ed);
      sel.removeAllRanges(); sel.addRange(range);
      document.execCommand('delete');
      ed.dispatchEvent(new Event('input', { bubbles: true }));
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  })()`;
  const r = await cdpSend('Runtime.evaluate', { expression: expr, returnByValue: true });
  const v = r.result && r.result.value;
  if (!v || !v.ok) throw new Error((v && v.error) || '无法清空输入框');
  await new Promise((r2) => setTimeout(r2, 250));
  return { cleared: true };
}

/**
 * 通过 CDP 把暂存内容发送到 WorkBuddy 输入框：
 * 0) 等待 AI 空闲（避免回复中输入框状态异常导致还原失败、消息进队列自动发送）
 * 1) 聚焦输入框（与 inject.js findComposer 相同策略，独立实现，不依赖注入组件）
 * 2) Input.insertText 真实键入文本（触发 beforeinput，Slate/React 完全感知）
 * 3) 找到发送按钮（操作栏最右圆形可点击元素，与 inject.js findSendButton 相同算法）并真实鼠标点击
 */
async function sendStashToComposer(record) {
  if (!cdp.connected) throw new Error('CDP 未连接，无法发送');
  // 等待 AI 空闲：若正在回复，最多等 60 秒；期间前端会提示"等待空闲"
  const idle = await waitAiIdle();
  if (!idle) throw new Error('对话持续回复中（等待 60 秒仍未空闲），已取消发送，请稍后再试');
  const content = record.content || {};
  const allItems = (content.items || []).filter((it) => it && typeof it === 'object');
  const imageItems = allItems.filter((it) => it.type === 'image' && (it.imageBase64 || (typeof it.data === 'string' && it.data)));
  const blockItems = allItems.filter((it) => it.type !== 'image' && (it.name || it.uri || (it._meta && (it._meta.type || it._meta.mentionType))));
  // 文本：剔除所有 item 的文本占位符（name/title/displayText），避免还原块后文字重复
  let text = (content.text || '').toString();
  const placeholders = [];
  for (const it of allItems) {
    const cands = [it.name, it.title, it._meta && it._meta.displayText];
    for (const c of cands) {
      const s = (c || '').trim();
      if (s && placeholders.indexOf(s) < 0) placeholders.push(s);
    }
  }
  placeholders.sort((a, b) => b.length - a.length); // 先删长的，避免子串误删
  for (const ph of placeholders) {
    const esc = ph.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp('\\s*' + esc + '\\s*', 'g'), '\n');
  }
  // 规整：折叠连续空行（保留至多 2 行）、去掉零宽字符与首尾空白
  text = text.replace(/\n{3,}/g, '\n\n').replace(/[\uFEFF\u200B]+/g, '').replace(/\s+$/g, '').trimStart();
  if (!text && !allItems.length) throw new Error('暂存内容为空');

  const focusExpr = `(function(){
    try {
      var mic = document.querySelector('.voice-mic-wrap');
      var ed = null;
      if (mic) {
        var p = mic.parentElement;
        for (var up = 0; up < 6 && p; up++) {
          var e = p.querySelector('[contenteditable="true"]') || p.querySelector('[data-slate-editor="true"]');
          if (e) { ed = e; break; }
          p = p.parentElement;
        }
      }
      if (!ed) {
        var all = document.querySelectorAll('[contenteditable="true"]');
        if (mic && all.length) {
          var mr = mic.getBoundingClientRect(), best = null, bd = Infinity;
          for (var i = 0; i < all.length; i++) {
            var r = all[i].getBoundingClientRect();
            if (r.height > 0 && r.bottom > 0 && r.bottom <= mr.top + 40) {
              var d = mr.top - r.bottom;
              if (d >= 0 && d < bd) { bd = d; best = all[i]; }
            }
          }
          if (best) ed = best;
        }
        if (!ed && all.length) ed = all[0];
      }
      if (!ed) return { ok: false, error: '未找到输入框' };
      ed.focus();
      ed.scrollIntoView({ block: 'nearest' });
      try {
        var sel = window.getSelection();
        if (sel && sel.selectAllChildren) { sel.selectAllChildren(ed); sel.collapseToEnd(); }
      } catch (_) {}
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  })()`;
  const fr = await cdpSend('Runtime.evaluate', { expression: focusExpr, returnByValue: true });
  const fv = fr.result && fr.result.value;
  if (!fv || !fv.ok) throw new Error((fv && fv.error) || '无法聚焦输入框');

  // 1.5) 清空输入框已有内容（避免与暂存内容拼接）。
  // 关键：不能用 document.execCommand('delete') —— execCommand 绕过 Slate 的 model 同步，
  // 会破坏编辑器内部 selection 状态，导致之后「退格/全选失效、只能追加文字」。
  // 改用 CDP 真实键盘事件：Cmd+A 全选 + Backspace 删除，Slate 完全感知（onKeyDown -> beforeinput 链路）。
  const clearExpr = `(function(){
    try {
      var mic = document.querySelector('.voice-mic-wrap');
      var ed = null;
      var p = mic.parentElement;
      for (var up = 0; up < 6 && p; up++) { var e = p.querySelector('[contenteditable="true"]'); if (e) { ed = e; break; } p = p.parentElement; }
      if (!ed) return { ok: false, error: 'no editor' };
      ed.focus();
      return { ok: true, hasContent: ((ed.innerText || '').replace(/[\\uFEFF\\u200B\\u00A0]/g, '').trim().length > 0) || !!ed.querySelector('[data-contentblock]') };
    } catch (e) { return { ok: false, error: String(e) }; }
  })()`;
  const clr = await cdpSend('Runtime.evaluate', { expression: clearExpr, returnByValue: true });
  const clrV = clr.result && clr.result.value;
  if (!clrV || !clrV.ok) throw new Error((clrV && clrV.error) || '无法聚焦输入框');
  if (clrV.hasContent) {
    // Cmd+A 全选（macOS meta=4）→ Backspace 删除
    await cdpSend('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
    await cdpSend('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
    await new Promise((r) => setTimeout(r, 120));
    await cdpSend('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
    await cdpSend('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
    await new Promise((r) => setTimeout(r, 300));
  }

  // 真实键入文本：逐行 insertText，行间 Shift+Enter 换行（trusted 键盘事件，Slate 生成段落；
  // 不能一次 insertText 整个文本——其中的 \n 不会在 Slate 中变成段落）
  const lines = text.split('\n');
  for (let li = 0; li < lines.length; li++) {
    if (lines[li]) {
      const CHUNK = 4000;
      for (let i = 0; i < lines[li].length; i += CHUNK) {
        await cdpSend('Input.insertText', { text: lines[li].slice(i, i + CHUNK) });
        if (i + CHUNK < lines[li].length) await new Promise((r) => setTimeout(r, 40));
      }
    }
    if (li < lines.length - 1) {
      await cdpSend('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', modifiers: 8 }); // Shift+Enter
      await cdpSend('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', modifiers: 8 });
    }
  }

  // 图片还原：构造含 image File 的合成 paste 事件，触发 WorkBuddy 的 onPasteFiles 插入 contentblock。
  // 关键：
  //  - 必须先 focus（activeElement 需在粘贴容器内），否则 handlePaste 直接忽略
  //  - 必须先有真实文本输入重建有效 selection（execCommand 清空后 selection 可能无效，合成 paste 会被忽略）
  //  - 还原后轮询验证 contentblock 数量是否增加；未增加说明当前会话不支持图片附件（降级为仅文字）
  const countExpr = `(function(){
    var mic = document.querySelector('.voice-mic-wrap');
    var ed = null;
    if (mic) { var p = mic.parentElement;
      for (var up = 0; up < 6 && p; up++) { var e = p.querySelector('[contenteditable="true"]'); if (e) { ed = e; break; } p = p.parentElement; } }
    return ed ? ed.querySelectorAll('[data-contentblock]').length : 0;
  })()`;
  const countBlocks = async () => {
    const r = await cdpSend('Runtime.evaluate', { expression: countExpr, returnByValue: true });
    return (r.result && r.result.value) || 0;
  };
  let imagesRestored = 0;
  let imagesFailed = 0;
  let blocksRestored = 0;
  let blocksFailed = 0;

  // 通用「合成 paste 后轮询验证 contentblock 增加」
  const pasteAndVerify = async (dtScript) => {
    const before = await countBlocks();
    const pasteExpr = `(function(){
      try {
        var mic = document.querySelector('.voice-mic-wrap');
        var ed = null;
        if (mic) { var p = mic.parentElement;
          for (var up = 0; up < 6 && p; up++) { var e = p.querySelector('[contenteditable="true"]'); if (e) { ed = e; break; } p = p.parentElement; } }
        if (!ed) return { ok: false, error: 'no editor' };
        ed.focus();
        var sel = window.getSelection();
        if (sel && sel.selectAllChildren) { sel.selectAllChildren(ed); sel.collapseToEnd(); }
        var dt = new DataTransfer();
        ${dtScript}
        var ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
        ed.dispatchEvent(ev);
        return { ok: true };
      } catch (e) { return { ok: false, error: String(e) }; }
    })()`;
    const ir = await cdpSend('Runtime.evaluate', { expression: pasteExpr, returnByValue: true });
    const iv = ir.result && ir.result.value;
    if (!iv || !iv.ok) return false;
    // 轮询验证（最多 ~3 秒）contentblock 数量是否增加
    for (let t = 0; t < 10; t++) {
      await new Promise((r) => setTimeout(r, 300));
      const now = await countBlocks();
      if (now > before) return true;
    }
    return false;
  };

  // 1) 图片：合成 paste 携带 image File（走 WorkBuddy 的 onPasteFiles）
  for (const it of imageItems) {
    let b64 = it.imageBase64 || (typeof it.data === 'string' ? it.data : '');
    if (!b64) continue;
    let mime = 'image/png';
    if (b64.indexOf('data:') === 0) {
      const m = b64.match(/^data:([^;,]+)[;,]/);
      if (m && m[1]) mime = m[1];
      b64 = b64.slice(b64.indexOf(',') + 1);
    }
    const name = (it.name || 'image.png').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
    const dtScript =
      'var bin = atob(' + JSON.stringify(b64) + ');' +
      'var bytes = new Uint8Array(bin.length);' +
      'for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);' +
      'dt.items.add(new File([bytes], ' + JSON.stringify(name) + ', { type: ' + JSON.stringify(mime) + ' }));';
    const ok = await pasteAndVerify(dtScript);
    if (ok) imagesRestored++;
    else imagesFailed++;
  }

  // 2) 非图片块（skill / 文件 / 上下文等 resource_link）：
  //    WorkBuddy 的 Slate onPaste 走 React 合成事件，不响应脚本派发的合成 paste（实测静默失败），
  //    因此无法还原为块——回填为文字行（显示文本），保证内容不丢失。
  let blockText = '';
  for (const it of blockItems) {
    const disp = (it._meta && it._meta.displayText) || it.title || it.name || '';
    if (disp) blockText += (blockText ? '\n' : '') + disp;
  }
  if (blockText) text = text ? text + '\n' + blockText : blockText;
  blocksFailed = blockItems.length;

  // 等 React 重渲染使发送按钮可用
  await new Promise((r) => setTimeout(r, 250));

  const sendExpr = `(function(){
    try {
      var mic = document.querySelector('.voice-mic-wrap');
      var row = mic ? mic.parentElement : null;
      if (!row || !row.children) return { ok: false, error: '未找到操作栏' };
      var kids = row.children, matches = [];
      for (var i = 0; i < kids.length; i++) {
        var k = kids[i];
        var cs = getComputedStyle(k);
        var isClick = k.getAttribute && (k.getAttribute('role') === 'button' || k.tagName === 'BUTTON');
        var r = k.getBoundingClientRect();
        var w = r.width, h = r.height;
        if (!isClick || w < 16 || h < 16) continue;
        var circular = /%/.test(cs.borderRadius) || parseFloat(cs.borderRadius || '0') >= Math.min(w, h) / 2 - 3;
        if (circular) matches.push(k);
      }
      if (!matches.length) return { ok: false, error: '未找到发送按钮' };
      var btn = matches[matches.length - 1];
      var dis = btn.disabled === true || (btn.hasAttribute && btn.hasAttribute('disabled'));
      if (dis) return { ok: false, error: '发送按钮禁用（输入内容未被识别）' };
      btn.scrollIntoView({ block: 'center', inline: 'center' });
      var b = btn.getBoundingClientRect();
      return { ok: true, x: b.x + b.width / 2, y: b.y + b.height / 2 };
    } catch (e) { return { ok: false, error: String(e) }; }
  })()`;
  const sr = await cdpSend('Runtime.evaluate', { expression: sendExpr, returnByValue: true });
  const sv = sr.result && sr.result.value;
  if (!sv || !sv.ok) throw new Error((sv && sv.error) || '未找到发送按钮');
  await cdpSend('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sv.x, y: sv.y });
  await cdpSend('Input.dispatchMouseEvent', { type: 'mousePressed', x: sv.x, y: sv.y, button: 'left', clickCount: 1 });
  await cdpSend('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sv.x, y: sv.y, button: 'left', clickCount: 1 });
  return { sent: true, textLen: text.length, itemCount: allItems.length, imagesRestored, imagesFailed, blocksRestored, blocksFailed };
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatLocalDateTime(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 查询剩余积分余额（单套 PackageCodes）。
 * 接口返回 Account 数组，累加每个 Account 的 CapacityRemainPrecise。
 */
async function fetchResource(accessToken, body) {
  const r = await fetch('https://www.workbuddy.cn/billing/meter/get-user-resource', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      'x-client-platform': 'web',
      origin: 'https://www.workbuddy.cn',
      referer: 'https://www.workbuddy.cn/profile/plans-usage',
      authorization: `Bearer ${accessToken}`,
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12000),
  });
  const text = await r.text();
  let o;
  try {
    o = JSON.parse(text);
  } catch (e) {
    throw new Error(`解析积分响应失败: ${e.message}`);
  }
  if (!r.ok) throw new Error(`积分接口 HTTP ${r.status}: ${text.slice(0, 120)}`);
  if (o.code !== 0 && o.code !== undefined) throw new Error(o.msg || `积分接口返回 code=${o.code}`);
  const data = o.data && o.data.Response && o.data.Response.Data;
  const accounts = (data && data.Accounts) || [];
  let credits = 0;
  for (const a of accounts) {
    // 剩余字段优先「周期剩余」(CycleCapacityRemainPrecise)：月度包用完时 CapacityRemainPrecise
    // 仍是满额(如 500)，但 CycleCapacityRemainPrecise 已为 0，必须用周期剩余才算对。
    const cands = [a.CycleCapacityRemainPrecise, a.CycleCapacityRemain, a.CapacityRemainPrecise, a.CapacityRemain];
    let v = NaN;
    for (const c of cands) {
      if (c === undefined || c === null || c === '') continue;
      const n = parseFloat(c);
      if (!Number.isNaN(n)) { v = n; break; }
    }
    if (!Number.isNaN(v)) credits += v;
  }
  return {
    credits: parseFloat(credits.toFixed(2)),
    count: accounts.length,
    totalDosage: data && data.TotalDosage,
  };
}

/**
 * 用指定账号的 accessToken 查询 workbuddy 总剩余积分。
 * 余额由两部分相加：
 *  - meter：计量包（原查询的 PackageCodes，如 26.27）
 *  - package：体验/赠送包（用户提供的第二套 PackageCodes，如 CodeBuddy 个人体验版 500）
 * 两者 CapacityRemainPrecise 累加即为该账号总剩余积分。
 * 任一组查询失败不影响另一组的结果（但单组失败会先重试，避免余额被偏低计入）。
 */
const retryDelay = (ms) => new Promise((r) => setTimeout(r, ms));

// 单组查询带有限重试：接口/http 偶发失败或返回空 Accounts 时，若直接按 0 计入会让总余额
// 偏低（如数百积分的体验/赠送包被漏掉）。重试耗尽仍失败才抛出，由上层作为该组 0 处理。
async function robustFetchResource(accessToken, body, label) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetchResource(accessToken, body);
      // 偶发返回空 Accounts（count=0）也会把该组余额算成 0，同样再多试一次（bound 在 3 次内）
      if (r.count === 0 && attempt < 3) {
        log(`[credits] ${label} 返回空结果，第 ${attempt} 次重试`);
        await retryDelay(300 * attempt);
        continue;
      }
      return r;
    } catch (e) {
      lastErr = e;
      if (attempt < 3) {
        log(`[credits] ${label} 失败(第 ${attempt} 次): ${e.message}，重试`);
        await retryDelay(300 * attempt);
      }
    }
  }
  throw lastErr || new Error(label + ' 查询返回空结果');
}

async function fetchCredits(accessToken) {
  // 1) 计量包（meter）
  const meterBody = {
    PageNumber: 1,
    PageSize: 200,
    ProductCode: 'p_tcaca',
    Status: [0],
    PackageEndTimeRangeBegin: formatLocalDateTime(new Date()),
    PackageEndTimeRangeEnd: '2127-08-14 22:55:11',
    PackageCodes: ['TCACA_code_007_nzdH5h4Nl0', 'TCACA_code_029_6wCGEWquYy', 'TCACA_code_030_BjSt89qTvr'],
    OrderBy: 'endTime',
    SortBy: 'desc',
  };
  // 2) 体验/赠送包（package）：来自用户提供的 curl（含 CodeBuddy 个人体验版 500 分等）
  const pkgBody = {
    PageNumber: 1,
    PageSize: 200,
    ProductCode: 'p_tcaca',
    Status: [0, 3],
    OnlyValidPeriod: true,
    PackageCodes: [
      'TCACA_code_008_cfWoLwvjU4',
      'TCACA_code_002_AkiJS3ZHF5',
      'TCACA_code_023_4xbGhMrE6q',
      'TCACA_code_026_BaESVICNoi',
      'TCACA_code_027_0FCGVA6vSa',
    ],
  };
  const [m, p] = await Promise.allSettled([
    robustFetchResource(accessToken, meterBody, 'meter'),
    robustFetchResource(accessToken, pkgBody, 'package'),
  ]);
  const meter = m.status === 'fulfilled' ? m.value : { credits: 0, count: 0, totalDosage: 0 };
  const pkg = p.status === 'fulfilled' ? p.value : { credits: 0, count: 0, totalDosage: 0 };
  if (m.status === 'rejected' && p.status === 'rejected') {
    throw m.reason; // 两组都失败才真正报错
  }
  const totalDosage = (Number(meter.totalDosage) || 0) + (Number(pkg.totalDosage) || 0);
  return {
    credits: parseFloat((meter.credits + pkg.credits).toFixed(2)),
    count: meter.count + pkg.count,
    totalDosage,
    meterCredits: meter.credits,
    packageCredits: pkg.credits,
    meterError: m.status === 'rejected' ? String((m.reason && m.reason.message) || m.reason) : null,
    packageError: p.status === 'rejected' ? String((p.reason && p.reason.message) || m.reason) : null,
  };
}

/* ================= 账号导出 / 导入（加密密钥 = workdaddy） =================
 * 目的：跨电脑同步账号备份，避免重新登录导致身份过期。
 * 说明：用户口吻的「RSA 加密」在本场景用对称加密实现（密钥固定为 workdaddy，任何机器均可解开）：
 *   AES-256-GCM + scryptSync(workdaddy) 派生 32 字节密钥。导出文件的 envelope 仅含元信息，
 *   账号内容（含令牌）整体密文，未解密前无法读取。kdf 参数固定，跨机器可还原。
 */
const EXPORT_PASSPHRASE = 'workdaddy';
const EXPORT_KDF_SALT = 'WorkDaddy-account-export-v1';

function exportSecretKey() {
  return crypto.scryptSync(EXPORT_PASSPHRASE, EXPORT_KDF_SALT, 32);
}
// 密文布局：iv(12) + authTag(16) + ciphertext
function encryptExport(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', exportSecretKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}
function decryptExport(b64) {
  const buf = Buffer.from(String(b64 || ''), 'base64');
  if (buf.length <= 28) throw new Error('导出数据不完整或已损坏');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', exportSecretKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  const p = url.pathname;

  // CORS 预检（注入到 WorkBuddy 页面里的组件需要跨域调用本机 API）
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-WorkDaddy-Token',
      'Access-Control-Allow-Private-Network': 'true',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }

  if (!validApiToken(req.headers['x-workdaddy-token'])) {
    return json(res, 403, { ok: false, error: 'unauthorized' });
  }

  if (req.method === 'POST' && p === '/api/inject') {
    return injectWidget('manual').then(
      () => json(res, 200, { ok: true }),
      (e) => json(res, 500, { ok: false, error: e.message })
    );
  }

  if (req.method === 'GET' && p === '/api/ask-mode') {
    return json(res, 200, { ok: true, ...getAskModeState() });
  }

  if (req.method === 'POST' && p === '/api/ask-mode-set') {
    return readBody(req).then((body) => {
      try {
        const state = setAskMode(!!body.enabled);
        log(`[ask-mode] 决策弹窗开关已${state.enabled ? '开启' : '关闭'}（下次会话全局生效）`);
        return json(res, 200, { ok: true, ...state });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    });
  }

  if (req.method === 'POST' && p === '/api/click') {
    return readBody(req).then((body) =>
      clickByText(body.text || '', { tag: body.tag, exact: !!body.exact })
        .then((info) => json(res, 200, { ok: true, clicked: info }))
        .catch((e) => json(res, 404, { ok: false, error: e.message }))
    );
  }

  if (req.method === 'POST' && p === '/api/find') {
    return readBody(req).then((body) =>
      findByText(body.text || '', { tag: body.tag, exact: !!body.exact })
        .then((info) => json(res, 200, { ok: true, found: info }))
        .catch((e) => json(res, 500, { ok: false, error: e.message }))
    );
  }

  if (req.method === 'POST' && p === '/api/delete') {
    return readBody(req).then((body) => {
      const uid = (body.uid || '').trim();
      if (!uid) return json(res, 400, { ok: false, error: '缺少 uid' });
      try {
        const r = deleteAccount(DATA_DIR, uid);
        log(`[delete] 已永久删除账号备份 ${uid}`);
        return json(res, 200, { ok: true, deleted: r.deleted, uid });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    });
  }

  // 「假退出登录」：先退出 WorkBuddy，再删除当前登录文件（备份的 accounts/<uid>.info
  // 仍保留，token 未过期），最后重新打开，让应用回到登录页，方便登录新账号。
  if (req.method === 'POST' && p === '/api/logout') {
    return (async () => {
      let quit = false;
      let relaunched = false;
      try {
        // 必须先停宿主：优雅退出可能把内存中的旧身份重新写回登录文件。
        await quitWorkBuddy();
        quit = true;
        if (fs.existsSync(AUTH_FILE)) {
          fs.unlinkSync(AUTH_FILE); // token 仍保留在 accounts/ 备份里
          log('[logout] WorkBuddy 已退出，已删除登录文件（假退出，token 未过期，备份保留）');
        } else {
          log('[logout] WorkBuddy 已退出，当前无登录文件');
        }
        if (fs.existsSync(AUTH_FILE)) {
          throw new Error('删除登录文件后仍然存在');
        }
        await relaunchWorkBuddy();
        relaunched = true;
        return json(res, 200, { ok: true, quit, relaunched });
      } catch (e) {
        log(`[logout] 退出/删除/重启 WorkBuddy 失败: ${e.message}`);
        return json(res, 502, { ok: false, quit, relaunched, error: e.message });
      }
    })();
  }

  // /api/batch-claim 已移除：领取改为打开面板时自动调接口（见 /api/accounts）

  if (req.method === 'GET' && p === '/api/status') {
    return json(res, 200, {
      ok: true,
      version: DAEMON_VERSION,
      buildId: DAEMON_BUILD_ID,
      cdp: {
        connected: cdp.connected,
        port: cdp.port,
        targetUrl: cdp.targetUrl,
        error: cdp.error,
      },
      batch: {
        running: batchState.running,
        total: batchState.total,
        done: batchState.done,
        startedAt: batchState.startedAt,
        last: batchState.last,
      },
      current: currentAccount(),
      dataDir: DATA_DIR,
      authFile: AUTH_FILE,
    });
  }

  // 诊断：保存一份不含 token 的本地快照，便于用户在异常机器上直接提供文件排查。
  if (req.method === 'GET' && p === '/api/diagnostics') {
    return writeDiagnosticsSnapshot('api-get').then((snapshot) => json(res, 200, { ok: true, file: DIAGNOSTICS_FILE, diagnostics: snapshot }));
  }
  if (req.method === 'POST' && p === '/api/diagnostics') {
    return writeDiagnosticsSnapshot('api-post').then((snapshot) => json(res, 200, { ok: true, file: DIAGNOSTICS_FILE, diagnostics: snapshot }));
  }

  if (req.method === 'GET' && p === '/api/accounts') {
    // 面板打开即自动对全部账号签到（带每日缓存，幂等，不阻塞响应）
    // checkinStatus=1 仅回读缓存和队列状态，不重复触发一轮签到，供面板轮询使用。
    if (url.searchParams.get('checkinStatus') !== '1') {
      claimDailyForAll().catch((e) => log('[checkin] 自动签到失败: ' + e.message));
    }
    const accounts = listAccounts(DATA_DIR);
    const cache = loadCheckinCache();
    const today = todayStr();
    const enriched = accounts.map((a) => {
      const c = cache[a.uid];
      return Object.assign({}, a, {
        checkin: c && c.date === today ? { ok: c.ok, already: c.already, code: c.code, message: c.message } : null,
      });
    });
    return json(res, 200, { ok: true, current: currentAccount(), accounts: enriched, checkin: checkinSnapshot() });
  }

  // 查询指定账号的剩余积分（累加 Account 数组的 CapacityRemainPrecise）
  if (req.method === 'POST' && p === '/api/credits') {
    return readBody(req).then(async (body) => {
      const uid = (body.uid || '').trim();
      if (!uid) return json(res, 400, { ok: false, error: '缺少 uid' });
      try {
        const file = path.join(DATA_DIR, 'accounts', `${uid}.info`);
        if (!fs.existsSync(file)) return json(res, 404, { ok: false, error: '账号备份不存在' });
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        const tk = j.auth && j.auth.accessToken;
        if (!tk) return json(res, 400, { ok: false, error: '备份中无 accessToken' });
        const r = await fetchCredits(tk);
        return json(res, 200, {
          ok: true,
          uid,
          credits: r.credits,
          count: r.count,
          totalDosage: r.totalDosage,
          meterCredits: r.meterCredits,
          packageCredits: r.packageCredits,
          meterError: r.meterError,
          packageError: r.packageError,
        });
      } catch (e) {
        log(`[credits] 查询 ${uid} 积分失败: ${e.message}`);
        return json(res, 500, { ok: false, error: e.message });
      }
    });
  }

  // 导出账号：加密打包全部备份，返回可直接下载的文件内容（密钥 workdaddy）
  if (req.method === 'POST' && p === '/api/accounts/export') {
    try {
      const accounts = listAccounts(DATA_DIR);
      const items = [];
      for (const a of accounts) {
        const file = backupPath(DATA_DIR, a.uid);
        if (!fs.existsSync(file)) continue;
        try {
          const raw = fs.readFileSync(file, 'utf8');
          JSON.parse(raw); // 跳过损坏备份
          items.push({ uid: a.uid, info: raw });
        } catch (_) { /* 跳过 */ }
      }
      if (!items.length) return json(res, 200, { ok: false, error: '没有可导出的账号备份' });
      const payload = { exportType: 'WorkDaddy-accounts', version: 1, accounts: items };
      const envelope = JSON.stringify({
        wbsExport: 'WorkDaddy',
        version: 1,
        createdAt: new Date().toISOString(),
        kdf: 'aes-256-gcm+scrypt',
        data: encryptExport(JSON.stringify(payload)),
      });
      const filename = 'WorkDaddy-账号导出-' + new Date().toISOString().slice(0, 10) + '.json';
      log(`[export] 导出 ${items.length} 个账号 -> ${filename}`);
      return json(res, 200, { ok: true, filename, content: envelope, count: items.length });
    } catch (e) {
      log(`[export] 导出失败: ${e.message}`);
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  // 导入账号：从加密文件解密并恢复备份（密钥 workdaddy），按 uid 覆盖写入
  if (req.method === 'POST' && p === '/api/accounts/import') {
    return readBody(req).then((body) => {
      try {
        let text = '';
        if (typeof body === 'string') text = body;
        else if (body && typeof body.content === 'string') text = body.content;
        else if (body && typeof body.data === 'string') text = body.data;
        if (!text) throw new Error('未读取到有效内容，请选择导出文件');
        let envelope;
        try { envelope = JSON.parse(text); } catch (_) { throw new Error('文件不是有效的导出 JSON'); }
        if (!envelope || envelope.wbsExport !== 'WorkDaddy') throw new Error('不是 WorkDaddy 的账号导出文件');
        const payload = JSON.parse(decryptExport(envelope.data));
        const list = Array.isArray(payload && payload.accounts) ? payload.accounts : [];
        if (!list.length) throw new Error('导入文件中没有账号数据');
        ensureDirs(DATA_DIR);
        const imported = [];
        for (const item of list) {
          const uid = String(item && item.uid || '').trim();
          const info = item && item.info;
          if (!uid || typeof info !== 'string') continue;
          let j;
          try { j = JSON.parse(info); } catch (_) { continue; }
          const acct = j.account || (Array.isArray(j.accounts) && j.accounts[0]);
          if (!acct || !acct.uid || String(acct.uid) !== uid) continue; // 安全校验：uid 必须匹配
          const dest = backupPath(DATA_DIR, uid);
          const tmp = dest + '.tmp';
          fs.writeFileSync(tmp, info, { mode: 0o600 });
          fs.renameSync(tmp, dest);
          try { fs.chmodSync(dest, 0o600); } catch (_) {}
          updateMeta(DATA_DIR, {
            uid,
            nickname: acct.nickname || '',
            uin: acct.uin || '',
            phone: acct.phoneNumber || '',
          });
          imported.push(uid);
        }
        log(`[import] 成功导入 ${imported.length}/${list.length} 个账号`);
        return json(res, 200, { ok: true, imported, count: imported.length });
      } catch (e) {
        log(`[import] 导入失败: ${e.message}`);
        return json(res, 200, { ok: false, error: e.message });
      }
    });
  }

  // 调试：保存输入框抓取内容（临时）。请求体为注入脚本抓取到的结构化对象。
  if (req.method === 'POST' && p === '/api/save-composer') {
    return readBody(req).then((body) => {
      try {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const dir = path.join(DATA_DIR, 'composer-captures');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `composer-${ts}.json`);
        fs.writeFileSync(file, JSON.stringify(body, null, 2));
        fs.writeFileSync(path.join(DATA_DIR, 'composer-debug.json'), JSON.stringify(body, null, 2));
        log('[composer] 保存抓取内容 -> ' + file);
        return json(res, 200, { ok: true, file: file });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    });
  }

  // 清空输入框（点暂存按钮入队成功后调用）：CDP 真实键盘事件，安全清空 Slate 编辑器
  if (req.method === 'POST' && p === '/api/clear-composer') {
    return clearComposerByCdp()
      .then((info) => json(res, 200, { ok: true, ...info }))
      .catch((e) => json(res, 500, { ok: false, error: e.message }));
  }

  // 主题列表（内置 + 用户自定义）
  if (req.method === 'GET' && p === '/api/themes') {
    try {
      const current = fs.existsSync(path.join(DATA_DIR, 'current-theme.json'))
        ? JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'current-theme.json'), 'utf8')).id
        : 'default';
      return json(res, 200, { ok: true, themes: listThemes(), current });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  // 官方背景图库列表（themes/wallpapers/*.webp），供面板「主题」页预览切换。
  // 附带 currentWallpaper：当前主题 background.webp 内容哈希匹配到的图库文件名（供面板高亮当前壁纸）
  if (req.method === 'GET' && p === '/api/wallpapers') {
    try {
      const files = fs.existsSync(WALLPAPERS_DIR)
        ? fs.readdirSync(WALLPAPERS_DIR).filter((f) => /\.webp$/i.test(f)).sort()
        : [];
      // 当前背景 = 当前主题目录的 background.webp（哈希对比图库）
      let currentWallpaper = null;
      try {
        const cur = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'current-theme.json'), 'utf8')).id || '';
        const bg = path.join(THEMES_DIR, String(cur).replace(/[^A-Za-z0-9_-]/g, '_'), 'background.webp');
        if (fs.existsSync(bg)) {
          const crypto = require('crypto');
          const want = crypto.createHash('md5').update(fs.readFileSync(bg)).digest('hex');
          for (const f of files) {
            const p2 = path.join(WALLPAPERS_DIR, f);
            if (crypto.createHash('md5').update(fs.readFileSync(p2)).digest('hex') === want) { currentWallpaper = f; break; }
          }
        }
      } catch (_) {}
      return json(res, 200, { ok: true, wallpapers: files.map((f) => ({ name: f, title: '官方壁纸 ' + String(f.replace(/\.webp$/i, '')).replace(/^wallpaper-?0*/, '') })), currentWallpaper });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  // 背景图全局蒙版透明度（0~1，默认 0.1）：GET 读取、POST 保存并重应用当前主题
  if (req.method === 'GET' && p === '/api/mask') {
    try {
      const f = path.join(DATA_DIR, 'mask.json');
      const opacity = fs.existsSync(f) ? (parseFloat(JSON.parse(fs.readFileSync(f, 'utf8')).opacity) || 0.3) : 0.1;
      return json(res, 200, { ok: true, opacity: Math.min(1, Math.max(0, opacity)) });
    } catch (e) {
      return json(res, 200, { ok: true, opacity: 0.1 });
    }
  }
  if (req.method === 'POST' && p === '/api/mask') {
    return readBody(req).then((body) => {
      try {
        const opacity = Math.min(1, Math.max(0, parseFloat(body.opacity)));
        if (Number.isNaN(opacity)) return json(res, 400, { ok: false, error: 'opacity 必须是数字' });
        fs.writeFileSync(path.join(DATA_DIR, 'mask.json'), JSON.stringify({ opacity }, null, 2));
        log('[theme] 背景蒙版透明度 -> ' + opacity);
        // 重应用当前主题使蒙版生效
        const cur = fs.existsSync(path.join(DATA_DIR, 'current-theme.json'))
          ? JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'current-theme.json'), 'utf8')).id
          : 'default';
        if (cur === 'default') return json(res, 200, { ok: true, opacity });
        return applyThemeByCdp(cur)
          .then((info) => json(res, 200, { ok: true, opacity, applied: info.ok }))
          .catch((e) => json(res, 500, { ok: false, error: '蒙版已保存但应用失败: ' + e.message }));
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    });
  }

  // 电脑休眠控制：GET/POST /api/sleep-mode（三模式 allow/keep/until-done + 显示器开关）+ POST /api/sleep-now（立即休眠）
  if (req.method === 'GET' && p === '/api/sleep-mode') {
    let st = { mode: 'allow', displaySleep: false };
    try { st = Object.assign(st, JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'sleep-mode.json'), 'utf8'))); } catch (_) {}
    return json(res, 200, { ok: true, mode: st.mode, displaySleep: !!st.displaySleep, preventing: st.mode === 'keep' || st.mode === 'until-done', active: !!sleepCaffeinate, antiLock: !!sleepUserActivityTimer });
  }
  if (req.method === 'POST' && p === '/api/sleep-mode') {
    return readBody(req).then((body) => {
      try {
        const mode = body.mode === 'keep' || body.mode === 'until-done' ? body.mode : 'allow';
        const displaySleep = !!body.displaySleep;
        if (!applySleepMode(mode, displaySleep)) return json(res, 500, { ok: false, error: 'caffeinate 启动失败' });
        fs.writeFileSync(path.join(DATA_DIR, 'sleep-mode.json'), JSON.stringify({ mode, displaySleep }, null, 2));
        return json(res, 200, { ok: true, mode, displaySleep, preventing: mode === 'keep' || mode === 'until-done' });
      } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
    });
  }
  if (req.method === 'POST' && p === '/api/sleep-now') {
    return sleepNow() ? json(res, 200, { ok: true }) : json(res, 500, { ok: false, error: '立即休眠失败' });
  }

  // 会话列表：GET /api/sessions?uid=<账号uid>&range=today|7d|30d|all（uid 缺省=当前账号；uid=空=全部账号）
  if (req.method === 'GET' && p === '/api/sessions') {
    const uidParam = url.searchParams.get('uid');
    const uid = uidParam === null ? (((currentAccount() || {}).uid || '').trim()) : uidParam.trim();
    const range = url.searchParams.get('range') || '7d';
    const rangeMs = sessionRangeMs(range);
    const clauses = ["deleted_at IS NULL"];
    if (uid) clauses.push("user_id = '" + uid.replace(/'/g, "''") + "'");
    if (rangeMs) clauses.push('created_at >= ' + rangeMs);
    return sqliteQuery("SELECT id, cwd, user_id, title, custom_title, status, created_at, updated_at, last_activity_at, is_playground, project_id FROM sessions WHERE " + clauses.join(' AND ') + " ORDER BY created_at DESC;")
      .then((rows) => json(res, 200, { ok: true, sessions: rows, count: rows.length, uid, range }))
      .catch((e) => json(res, 500, { ok: false, error: e.message }));
  }
  // 会话空间列表：GET /api/sessions/workspaces
  if (req.method === 'GET' && p === '/api/sessions/workspaces') {
    return sqliteQuery("SELECT DISTINCT cwd FROM sessions WHERE deleted_at IS NULL AND cwd IS NOT NULL AND cwd != '' ORDER BY cwd;")
      .then((rows) => json(res, 200, { ok: true, workspaces: rows.map((r) => r.cwd) }))
      .catch((e) => json(res, 500, { ok: false, error: e.message }));
  }
  // 复制会话：POST /api/sessions/copy { ids, targetUid }（保留原会话，复制记录+消息文件到目标账号）
  if (req.method === 'POST' && p === '/api/sessions/copy') {
    return readBody(req).then(async (body) => {
      const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string') : [];
      const targetUid = (body.targetUid || '').trim();
      if (!ids.length) return json(res, 400, { ok: false, error: '未选择会话' });
      if (!targetUid) return json(res, 400, { ok: false, error: '未指定目标账号' });
      try {
        const esc = ids.map((i) => "'" + String(i).replace(/'/g, "''") + "'").join(',');
        const tU = targetUid.replace(/'/g, "''");
        // 1) 取出源会话（含 cwd 用于定位消息文件）
        const srcRows = await sqliteQuery("SELECT id, cwd, user_id, title, custom_title, status, created_at, updated_at, last_activity_at, is_playground, source_mode, is_background_automation, mode, model, expert_id, expert_locale, expert_runtime_identity, expert_marketplace, permission_mode, use_sandbox_cli, project_id FROM sessions WHERE id IN (" + esc + ") AND deleted_at IS NULL;");
        if (!srcRows.length) return json(res, 404, { ok: false, error: '源会话不存在' });
        const wbHome = WORKBUDDY_HOME;
        let copied = 0;
        for (const src of srcRows) {
          const newId = crypto.randomUUID();
          // 2) INSERT 新会话记录
          const cols = ['id', 'cwd', 'user_id', 'title', 'custom_title', 'status', 'created_at', 'updated_at', 'last_activity_at', 'is_playground', 'source_mode', 'is_background_automation', 'mode', 'model', 'expert_id', 'expert_locale', 'expert_runtime_identity', 'expert_marketplace', 'permission_mode', 'use_sandbox_cli', 'project_id'];
          const vals = [
            "'" + newId + "'",
            "'" + String(src.cwd || '').replace(/'/g, "''") + "'",
            "'" + tU + "'",
            "'" + String(src.title || '').replace(/'/g, "''") + "'",
            "'" + String(src.custom_title || '').replace(/'/g, "''") + "'",
            "'" + String(src.status || 'Pending').replace(/'/g, "''") + "'",
            String(src.created_at || Date.now()),
            String(Date.now()),
            String(src.last_activity_at || src.updated_at || Date.now()),
            String(src.is_playground || 0),
            src.source_mode ? "'" + String(src.source_mode).replace(/'/g, "''") + "'" : 'NULL',
            src.is_background_automation === null || src.is_background_automation === undefined || src.is_background_automation === '' ? 'NULL' : String(src.is_background_automation),
            src.mode ? "'" + String(src.mode).replace(/'/g, "''") + "'" : 'NULL',
            src.model ? "'" + String(src.model).replace(/'/g, "''") + "'" : 'NULL',
            src.expert_id ? "'" + String(src.expert_id).replace(/'/g, "''") + "'" : 'NULL',
            src.expert_locale ? "'" + String(src.expert_locale).replace(/'/g, "''") + "'" : 'NULL',
            src.expert_runtime_identity ? "'" + String(src.expert_runtime_identity).replace(/'/g, "''") + "'" : 'NULL',
            src.expert_marketplace ? "'" + String(src.expert_marketplace).replace(/'/g, "''") + "'" : 'NULL',
            src.permission_mode ? "'" + String(src.permission_mode).replace(/'/g, "''") + "'" : 'NULL',
            src.use_sandbox_cli === null || src.use_sandbox_cli === undefined || src.use_sandbox_cli === '' ? 'NULL' : String(src.use_sandbox_cli),
            src.project_id ? "'" + String(src.project_id).replace(/'/g, "''") + "'" : 'NULL',
          ];
          await sqliteRun("INSERT INTO sessions (" + cols.join(',') + ") VALUES (" + vals.join(',') + ");");
          // 3) 复制消息文件（jsonl + 目录 + 索引）
          copySessionFiles(wbHome, src.id, newId);
          copied++;
        }
        return json(res, 200, { ok: true, copied, targetUid });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    });
  }
  // 迁移会话：POST /api/sessions/migrate { ids, targetUid }
  if (req.method === 'POST' && p === '/api/sessions/migrate') {
    return readBody(req).then((body) => {
      const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string') : [];
      const targetUid = (body.targetUid || '').trim();
      if (!ids.length) return json(res, 400, { ok: false, error: '未选择会话' });
      if (!targetUid) return json(res, 400, { ok: false, error: '未指定目标账号' });
      const esc = ids.map((i) => "'" + String(i).replace(/'/g, "''") + "'").join(',');
      return sqliteRun("UPDATE sessions SET user_id = '" + targetUid.replace(/'/g, "''") + "', updated_at = " + Date.now() + " WHERE id IN (" + esc + ");")
        .then(() => json(res, 200, { ok: true, moved: ids.length, targetUid }))
        .catch((e) => json(res, 500, { ok: false, error: e.message }));
    });
  }
  // 删除会话（真实删除）：POST /api/sessions/delete { ids }——删除 DB 记录 + 该账号下全部会话文件（不可恢复）
  if (req.method === 'POST' && p === '/api/sessions/delete') {
    return readBody(req).then(async (body) => {
      const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string') : [];
      if (!ids.length) return json(res, 400, { ok: false, error: '未选择会话' });
      try {
        const esc = ids.map((i) => "'" + String(i).replace(/'/g, "''") + "'").join(',');
        // 1) 真实删除 DB 记录（非软删）
        await sqliteRun("DELETE FROM sessions WHERE id IN (" + esc + ");");
        // 2) 删除本地消息文件（jsonl/目录/workspace/tasks/file-history/artifact-index）
        const wbHome = WORKBUDDY_HOME;
        let filesRemoved = 0;
        for (const id of ids) filesRemoved += deleteSessionFiles(wbHome, id);
        log(`[sessions-delete] 已真实删除 ${ids.length} 个会话（DB + ${filesRemoved} 项文件）`);
        return json(res, 200, { ok: true, deleted: ids.length, filesRemoved });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    });
  }
  // 恢复会话：POST /api/sessions/restore { ids }
  if (req.method === 'POST' && p === '/api/sessions/restore') {
    return readBody(req).then((body) => {
      const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string') : [];
      if (!ids.length) return json(res, 400, { ok: false, error: '未选择会话' });
      const esc = ids.map((i) => "'" + String(i).replace(/'/g, "''") + "'").join(',');
      return sqliteRun("UPDATE sessions SET deleted_at = NULL, updated_at = " + Date.now() + " WHERE id IN (" + esc + ");")
        .then(() => json(res, 200, { ok: true, restored: ids.length }))
        .catch((e) => json(res, 500, { ok: false, error: e.message }));
    });
  }

  // 打开 WorkBuddy 的 Chrome DevTools（绕开 chrome://inspect 404 + Electron CDP 拒绝带 Origin 的 WS）
  // 前端页面从实际 CDP 端口加载，ws 通过带令牌的 daemon 代理中转。
  // 注意：必须 return Promise 立即返回，避免同步函数继续执行到 404 分支
  if (req.method === 'GET' && p === '/api/devtools-url') {
    return new Promise((resolve) => {
      const httpMod = require('http');
      const devtoolsPort = cdp.port || CDP_PORT_HINT || 9222;
      httpMod.get('http://127.0.0.1:' + devtoolsPort + '/json/list', (r) => {
        let d = '';
        r.on('data', (c) => (d += c));
        r.on('end', () => {
          try {
            const list = JSON.parse(d);
            const page = list.find(isWorkBuddyCdpTarget);
            const id = page && page.id;
            if (!id) return resolve(json(res, 500, { ok: false, error: '未找到 WorkBuddy 页面 target' }));
            if (!wsLib) return resolve(json(res, 500, { ok: false, error: 'ws 代理库未加载，无法打开 DevTools' }));
            const wsTarget = '127.0.0.1:' + ACTUAL_PORT + '/devtools-proxy/' + id + '?token=' + encodeURIComponent(API_TOKEN);
            const url = 'http://127.0.0.1:' + devtoolsPort + '/devtools/inspector.html?ws=' + encodeURIComponent(wsTarget);
            resolve(json(res, 200, { ok: true, url }));
          } catch (e) {
            resolve(json(res, 500, { ok: false, error: e.message }));
          }
        });
      }).on('error', (e) => resolve(json(res, 500, { ok: false, error: 'CDP 端口不可达: ' + e.message })));
    });
  }

  // 应用主题（CDP 注入 CSS 变量覆盖）
  if (req.method === 'POST' && p === '/api/theme-apply') {
    return readBody(req).then((body) => {
      const id = (body.id || 'default') + '';
      if (id !== 'default' && !getTheme(id)) return json(res, 404, { ok: false, error: '主题不存在: ' + id });
      try {
        fs.writeFileSync(path.join(DATA_DIR, 'current-theme.json'), JSON.stringify({ id, at: new Date().toISOString() }, null, 2));
      } catch (_) {}
      return applyThemeByCdp(id)
        .then((info) => json(res, 200, { ok: true, ...info, id }))
        .catch((e) => json(res, 500, { ok: false, error: e.message }));
    });
  }

  // 保存自定义主题（用户上传/导入）
  if (req.method === 'POST' && p === '/api/theme-save') {
    return readBody(req).then((body) => {
      try {
        const id = String(body.id || '').replace(/[^A-Za-z0-9_-]/g, '_') || ('custom-' + Date.now());
        const theme = {
          id,
          name: String(body.name || id),
          author: String(body.author || 'unknown'),
          dark: !!body.dark,
          colors: body.colors || {},
        };
        if (body.image) theme.image = String(body.image);
        if (body.appearance) theme.appearance = String(body.appearance);
        if (!theme.colors || typeof theme.colors !== 'object' || !Object.keys(theme.colors).length) {
          return json(res, 400, { ok: false, error: 'colors 不能为空' });
        }
        fs.mkdirSync(THEMES_DIR, { recursive: true });
        fs.writeFileSync(path.join(THEMES_DIR, id + '.json'), JSON.stringify(theme, null, 2));
        log('[theme] 保存自定义主题 -> ' + id);
        return json(res, 200, { ok: true, id });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    });
  }

  // 上传主题背景图：multipart 或 JSON base64（dataURL），保存到 themes/<id>/<image>
  if (req.method === 'POST' && p === '/api/theme-image') {
    return readBody(req).then((body) => {
      try {
        const id = String(body.id || '').replace(/[^A-Za-z0-9_-]/g, '_');
        if (!id) return json(res, 400, { ok: false, error: '缺少 id' });
        const dataUrl = String(body.dataUrl || '');
        const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/i.exec(dataUrl);
        if (!m) return json(res, 400, { ok: false, error: '图片必须是 PNG/JPEG/WebP base64' });
        const ext = m[1].toLowerCase().replace('jpeg', 'jpg');
        const buf = Buffer.from(m[2], 'base64');
        if (buf.length > 10 * 1024 * 1024) return json(res, 400, { ok: false, error: '图片不能超过 10MB' });
        const dir = path.join(THEMES_DIR, id);
        fs.mkdirSync(dir, { recursive: true });
        const imageName = 'background.' + ext;
        fs.writeFileSync(path.join(dir, imageName), buf);
        log('[theme] 保存背景图 -> ' + id + '/' + imageName + ' (' + buf.length + 'B)');
        return json(res, 200, { ok: true, image: imageName });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    });
  }

  // 替换主题背景图（保持主题配色不变）：存 background.webp + 更新 theme.json image 字段 +
  // 设 current 并立即应用。用于面板「图片」按钮——用户换背景图不生成新主题，reload 后恢复的就是新图。
  // 支持两种来源：body.dataUrl（用户上传 base64）/ body.wallpaper（官方图库文件名，从 wallpapers 目录复制）
  if (req.method === 'POST' && p === '/api/theme-bg') {
    return readBody(req).then((body) => {
      try {
        const id = String(body.id || '').replace(/[^A-Za-z0-9_-]/g, '_');
        if (!id) return json(res, 400, { ok: false, error: '缺少 id' });
        let buf = null;
        const wpName = String(body.wallpaper || '');
        if (wpName) {
          // 官方图库：从 wallpapers 目录读取（防路径穿越：只允许纯文件名）
          const safeName = path.basename(wpName).replace(/[^A-Za-z0-9._-]/g, '_');
          const src = path.join(WALLPAPERS_DIR, safeName);
          if (!fs.existsSync(src)) return json(res, 400, { ok: false, error: '壁纸不存在: ' + safeName });
          buf = fs.readFileSync(src);
        } else {
          const dataUrl = String(body.dataUrl || '');
          const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/i.exec(dataUrl);
          if (!m) return json(res, 400, { ok: false, error: '图片必须是 PNG/JPEG/WebP base64' });
          buf = Buffer.from(m[2], 'base64');
        }
        if (buf.length > 10 * 1024 * 1024) return json(res, 400, { ok: false, error: '图片不能超过 10MB' });
        const dir = path.join(THEMES_DIR, id);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'background.webp'), buf);
        // 更新 theme.json 的 image 字段（保证 getTheme 能找到新图）
        const tf = path.join(dir, 'theme.json');
        if (fs.existsSync(tf)) {
          try {
            const t = JSON.parse(fs.readFileSync(tf, 'utf8'));
            t.image = 'background.webp';
            fs.writeFileSync(tf, JSON.stringify(t, null, 2));
          } catch (_) {}
        }
        // 记录当前主题并应用（reload 后 1.5s 恢复的就是这张新图，不再"切回最早背景图"）
        try {
          fs.writeFileSync(path.join(DATA_DIR, 'current-theme.json'), JSON.stringify({ id, at: new Date().toISOString() }, null, 2));
        } catch (_) {}
        log('[theme] 替换背景图 -> ' + id + '/background.webp (' + buf.length + 'B)');
        return applyThemeByCdp(id)
          .then((info) => json(res, 200, { ok: true, image: 'background.webp', applied: info.ok, id }))
          .catch((e) => json(res, 500, { ok: false, error: '背景图已保存但应用失败: ' + e.message }));
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    });
  }

  // 当前账号 uid（轻量，不触发签到），供暂存等功能取用户标识
  if (req.method === 'GET' && (p === '/api/current' || p === '/api/current/')) {
    try {
      const c = currentAccount();
      return json(res, 200, { ok: true, uid: c ? c.uid : null });
    } catch (e) {
      return json(res, 200, { ok: true, uid: null });
    }
  }

  // 关于页：版本/许可/平台/原理/构建信息，面板「关于」tab 直接渲染
  if (req.method === 'GET' && (p === '/api/about' || p === '/api/about/')) {
    let build = { version: DAEMON_VERSION, commit: null, buildAt: null };
    try {
      const pjson = require('./package.json');
      build.version = pjson.version || DAEMON_VERSION;
      build.commit = process.env.WBSWITCH_GIT_COMMIT || null;
      build.buildAt = process.env.WBSWITCH_BUILD_AT || null;
    } catch (_) { /* 没有 package.json 时退回到 DAEMON_VERSION */ }
    let platform = { os: process.platform, arch: process.arch };
    let appVersion = null;
    try {
      const plist = require('./plist-reader.js') || null;
    } catch (_) { /* 可选依赖，缺失不影响 */ }
    try {
      const fsMod = require('fs');
      const plistPath = path.join(__dirname, '..', '..', 'Info.plist');
      if (fsMod.existsSync(plistPath)) {
        const buf = fsMod.readFileSync(plistPath, 'utf8');
        const m = buf.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
        if (m) appVersion = m[1];
      }
    } catch (_) { /* 解析失败忽略 */ }
    return json(res, 200, {
      ok: true,
      name: 'WorkDaddy',
      tagline: 'WorkBuddy 的多账号 · 主题 · 增强工具集',
      version: build.version,
      appVersion: appVersion,
      license: 'AGPL-3.0',
      repository: 'https://github.com/babygoton/WorkDaddy',
      principle: '本机回环 CDP 注入 · 不改官方安装包',
      platform: IS_WIN ? 'Windows 10+（x64）' : 'macOS 11+',
      author: 'WorkDaddy',
      nodeVersion: process.version,
      ...platform,
      ...build,
    });
  }

  // 自动更新：检查（GET /api/update-check，force=1 强制刷新）→ 下载（POST /api/update-download）→ 状态（GET /api/update-status）→ 安装（POST /api/update-apply）
  if (req.method === 'GET' && p === '/api/update-check') {
    const force = url.searchParams.get('force') === '1';
    return Promise.resolve(checkUpdate(force)).then((st) =>
      json(res, 200, {
        ok: true,
        current: DAEMON_VERSION,
        latest: st.latest,
        hasUpdate: st.hasUpdate,
        dmgUrl: st.dmgUrl,
        dmgSize: st.dmgSize,
        notes: st.notes,
        message: st.message,
        error: st.error || null,
        checkedAt: st.checkedAt,
      })
    );
  }
  if (req.method === 'GET' && p === '/api/update-status') {
    return json(res, 200, {
      ok: true,
      status: updateState.status,
      progress: updateState.progress,
      message: updateState.message,
      error: updateState.error || null,
      latest: updateState.latest,
      hasUpdate: updateState.hasUpdate,
      downloaded: updateState.downloaded,
    });
  }
  if (req.method === 'POST' && p === '/api/update-download') {
    updateState.error = null;
    return downloadUpdate()
      .then((file) => json(res, 200, { ok: true, file, size: fs.existsSync(file) ? fs.statSync(file).size : 0 }))
      .catch((e) => {
        updateState.error = e.message;
        updateState.message = '下载失败';
        return json(res, 200, { ok: false, error: e.message });
      });
  }
  if (req.method === 'POST' && p === '/api/update-apply') {
    return applyUpdate()
      .then((r) => json(res, 200, r))
      .catch((e) => json(res, 200, { ok: false, error: e.message }));
  }

  // 暂存卡死诊断：注入脚本上报的面包屑/错误栈，仅写 daemon 日志（崩溃排查用）
  if (req.method === 'POST' && p === '/api/breadcrumb') {
    return readBody(req).then((body) => {
      try {
        log('[breadcrumb] ' + String(body.msg || '?') + (body.extra ? ' ' + JSON.stringify(body.extra) : ''));
        return json(res, 200, { ok: true });
      } catch (e) {
        return json(res, 200, { ok: true });
      }
    });
  }

  // 暂存提示词：绑定到 用户(uid) + 会话(conversationId)。
  // 同一 uid+conv 可多次暂存——每次生成新 key（追加时间戳），旧记录保留不覆盖。
  if (req.method === 'POST' && p === '/api/stash') {
    return readBody(req).then((body) => {
      try {
        const uid = (body.uid || 'unknown') + '';
        const conv = (body.conversationId || 'unknown') + '';
        const safe = (s) => (s || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
        const now = Date.now();
        const key = safe(uid) + '__' + safe(conv) + '__' + now;
        const dir = path.join(DATA_DIR, 'stash');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, key + '.json');
        const items = (body.content && body.content.items) || [];
        const record = {
          uid: body.uid || null,
          conversationId: body.conversationId || null,
          savedAt: new Date().toISOString(),
          content: body.content || null,
          summary: {
            textLen: body.content && body.content.textLen,
            itemCount: items.length,
            itemTypes: Array.from(new Set(items.map((x) => x.type))),
          },
        };
        fs.writeFileSync(file, JSON.stringify(record, null, 2));
        // 主索引：便于后续按 uid/会话 检索
        const idxFile = path.join(DATA_DIR, 'stash-index.json');
        let idx = [];
        try { idx = JSON.parse(fs.readFileSync(idxFile, 'utf8')) || []; } catch (_) {}
        idx.unshift({
          key,
          uid: record.uid,
          conversationId: record.conversationId,
          savedAt: record.savedAt,
          file,
          summary: record.summary,
        });
        fs.writeFileSync(idxFile, JSON.stringify(idx, null, 2));
        log('[stash] 暂存 -> ' + file + ' (uid=' + uid + ' conv=' + conv + ', items=' + items.length + ')');
        return json(res, 200, { ok: true, key: key, file: file });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    });
  }

  // 暂存提示词列表：全部记录 + uid->nickname 映射 + 会话名映射 + 当前账号 uid（供前端默认筛选）
  if (req.method === 'GET' && p === '/api/stash-list') {
    return (async () => {
      try {
        const { records, nick } = listStashRecords();
        const cur = currentAccount();
        const convNames = await fetchConvNames();
        const list = records.map((r) => {
          const text = (r.content && r.content.text) || '';
          return {
            key: r._key,
            uid: r.uid,
            conversationId: r.conversationId,
            savedAt: r.savedAt,
            preview: text.slice(0, 140),
            textLen: text.length,
            summary: r.summary || null,
          };
        });
        return json(res, 200, { ok: true, current: cur ? cur.uid : null, nick, convNames, records: list });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    })();
  }

  // 暂存提示词详情（含完整 content，供弹窗预览与发送）
  if (req.method === 'GET' && p === '/api/stash-get') {
    try {
      const key = (url.searchParams.get('key') || '').trim();
      if (!key) return json(res, 400, { ok: false, error: '缺少 key' });
      const rec = stashRecordByKey(key);
      return json(res, 200, { ok: true, key, record: rec });
    } catch (e) {
      return json(res, 404, { ok: false, error: e.message });
    }
  }

  // 删除单条暂存记录
  if (req.method === 'POST' && p === '/api/stash-delete') {
    return readBody(req).then((body) => {
      try {
        const key = (body.key || '').trim();
        if (!key) return json(res, 400, { ok: false, error: '缺少 key' });
        const deleted = deleteStashRecord(key);
        log('[stash] 删除 -> ' + key + ' (deleted=' + deleted + ')');
        return json(res, 200, { ok: true, key, deleted });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    });
  }

  // 发送暂存提示词：CDP 回填输入框并点击发送；mode=delete 时发送成功后删除该记录
  if (req.method === 'POST' && p === '/api/stash-send') {
    return readBody(req).then(async (body) => {
      try {
        const key = (body.key || '').trim();
        const mode = body.mode === 'delete' ? 'delete' : 'keep';
        if (!key) return json(res, 400, { ok: false, error: '缺少 key' });
        const rec = stashRecordByKey(key);
        const sent = await sendStashToComposer(rec);
        let deleted = false;
        if (mode === 'delete') deleted = deleteStashRecord(key);
        log(`[stash] 发送 -> ${key} (mode=${mode}, deleted=${deleted}, textLen=${sent.textLen}, img=${sent.imagesRestored}/${sent.imagesFailed}, block=${sent.blocksRestored}/${sent.blocksFailed})`);
        return json(res, 200, {
          ok: true,
          key,
          mode,
          sent: true,
          deleted,
          textLen: sent.textLen,
          itemCount: sent.itemCount,
          imagesRestored: sent.imagesRestored,
          imagesFailed: sent.imagesFailed,
          blocksRestored: sent.blocksRestored,
          blocksFailed: sent.blocksFailed,
        });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    });
  }

  if (req.method === 'GET' && p === '/api/open-dir') {
    try {
      if (IS_WIN) {
        require('child_process').execFile('explorer.exe', [DATA_DIR]);
      } else {
        require('child_process').execFile('/usr/bin/open', [DATA_DIR]);
      }
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  if (req.method === 'POST' && p === '/api/backup') {
    try {
      const info = backupCurrent(DATA_DIR, log);
      return json(res, 200, {
        ok: true,
        uid: info.uid,
        nickname: info.nickname,
      });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  if (req.method === 'POST' && p === '/api/switch') {
    return readBody(req).then(async (body) => {
      const uid = (body.uid || '').trim();
      if (!uid) return json(res, 400, { ok: false, error: '缺少 uid' });
      try {
        const acct = switchTo(DATA_DIR, uid, log);
        const hint = '登录文件已切换，请重启 WorkBuddy 使新账号生效';
        let reloaded = false;
        if (body.reload) {
          try {
            await reloadWorkBuddyPage();
            reloaded = true;
            log('[switch] 已通过 CDP 刷新 WorkBuddy 窗口');
            // 切换后通过接口自动签到（带每日缓存，幂等）
            claimDailyForUid(uid)
              .then((r) => log('[checkin] 切换后自动签到 ' + uid + ': ' + (r.ok ? '已领取' : '失败 ' + (r.reason || r.message))))
              .catch((e) => log('[checkin] 切换后签到异常: ' + e.message));
          } catch (e) {
            log(`[switch] CDP 刷新失败: ${e.message}`);
          }
        }
        return json(res, 200, {
          ok: true,
          uid: acct.uid,
          nickname: acct.nickname,
          reloaded,
          hint: reloaded ? '已切换并触发窗口刷新' : hint,
        });
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    });
  }

  return json(res, 404, { ok: false, error: 'not found' });
}


// ===== 电脑休眠控制（三模式：allow/keep/until-done + 显示器开关 + 立即休眠 pmset sleepnow）=====
// mode: 'allow' 允许电脑休眠（默认）| 'keep' 持续禁止休眠 | 'until-done' 所有任务结束后允许休眠
// displaySleep: 禁止休眠时是否允许显示器休眠（默认 false = 显示器也保持唤醒）
let sleepCaffeinate = null;
let sleepUserActivity = null; // 防锁屏：caffeinate -u -t 300（UserIsActive 断言，阻止屏保启动/空闲锁屏）
let sleepUserActivityTimer = null; // -u 断言每 240s 续期一次（-t 300 超时前续期，保持无间隙）
let sleepPowershell = null; // Windows: 常驻 powershell 进程持有 SetThreadExecutionState
function stopCaffeinate() {
  if (IS_WIN) {
    const c = sleepPowershell;
    sleepPowershell = null; // 先置 null 再 kill，避免 exit 回调把旧引用覆盖
    if (c) { try { c.kill(); } catch (_) {} }
    return;
  }
  const c = sleepCaffeinate;
  sleepCaffeinate = null; // 先置 null 再 kill，避免旧进程 exit 回调把新引用覆盖
  if (c) { try { c.kill(); } catch (_) {} }
  stopUserActivity(); // 同步停止防锁屏循环
}
// 停止防锁屏：清除续期定时器并杀掉 -u 进程（UserIsActive 断言随之释放）
function stopUserActivity() {
  if (sleepUserActivityTimer) { clearInterval(sleepUserActivityTimer); sleepUserActivityTimer = null; }
  const c = sleepUserActivity; sleepUserActivity = null;
  if (c) { try { c.kill(); } catch (_) {} }
}
// 防锁屏循环：持续声明「用户活跃」（caffeinate -u），等价 Amphetamine 的模拟用户活动机制，
// 系统认为用户一直在操作，屏保与空闲锁屏便不会触发；每 240s 重启一个 -t 300 的断言实现无间隙续期。
// 无需辅助功能权限（-u 走系统 IOKit 用户活动断言）。
function startUserActivityLoop() {
  if (IS_WIN) return; // Windows 无 caffeinate -u 等价；防锁屏由系统电源策略控制
  stopUserActivity();
  const tick = () => {
    if (!sleepCaffeinate) return; // 防休眠已停止（allow 模式），不再续期
    if (sleepUserActivity) { try { sleepUserActivity.kill(); } catch (_) {} }
    const child = spawn('caffeinate', ['-u', '-t', '300'], { stdio: 'ignore' });
    child.on('error', (e) => log('[sleep] 防锁屏 caffeinate(-u) 启动失败: ' + e.message));
    child.on('exit', () => { if (sleepUserActivity === child) sleepUserActivity = null; });
    sleepUserActivity = child;
  };
  tick();
  sleepUserActivityTimer = setInterval(tick, 240 * 1000);
  if (sleepUserActivityTimer.unref) sleepUserActivityTimer.unref();
}
function startCaffeinate(displaySleep) {
  if (IS_WIN) {
    // Windows：常驻 powershell 循环调用 SetThreadExecutionState。
    // 0x80000000 ES_CONTINUOUS | 0x1 ES_SYSTEM_REQUIRED | 0x2 ES_DISPLAY_REQUIRED
    const flags = displaySleep ? '0x80000001' : '0x80000003';
    const ps = "Add-Type -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint e);' -Name WSleep -Namespace WB -PassThru | Out-Null; while($true){ [WB.WSleep]::SetThreadExecutionState(" + flags + "); Start-Sleep -Seconds 90 }";
    const child = spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], { stdio: 'ignore', windowsHide: true });
    child.on('error', (e) => { log('[sleep] 防休眠进程启动失败: ' + e.message); if (sleepPowershell === child) sleepPowershell = null; });
    child.on('exit', () => { if (sleepPowershell === child) sleepPowershell = null; });
    sleepPowershell = child;
    return child;
  }
  const child = spawn('caffeinate', displaySleep ? ['-i', '-s', '-m'] : ['-d', '-i', '-s', '-m'], { stdio: 'ignore' });
  child.on('error', (e) => { log('[sleep] caffeinate 启动失败: ' + e.message); if (sleepCaffeinate === child) sleepCaffeinate = null; });
  child.on('exit', () => { if (sleepCaffeinate === child) sleepCaffeinate = null; });
  sleepCaffeinate = child;
  // 显示器保持唤醒时启用防锁屏（-u 用户活动断言）；允许显示器休眠时屏幕黑屏后由系统锁屏策略决定，无法防锁屏
  if (!displaySleep) startUserActivityLoop(); else stopUserActivity();
  return child;
}
function applySleepMode(mode, displaySleep) {
  const preventing = mode === 'keep' || mode === 'until-done';
  if (preventing) {
    if (IS_WIN) {
      // Windows：powershell 持有进程参数固定，无法比较 spawnargs，直接重启（低频操作，代价可接受）
      stopCaffeinate();
      try {
        startCaffeinate(!!displaySleep);
        log('[sleep] 禁止休眠已开启（Windows，模式=' + mode + (displaySleep ? '，允许显示器休眠' : '，显示器保持唤醒') + '）');
      } catch (e) { log('[sleep] 开启失败: ' + e.message); return false; }
      return true;
    }
    const wantArgs = displaySleep ? '-i-s-m' : '-d-i-s-m';
    const curArgs = sleepCaffeinate ? sleepCaffeinate.spawnargs.slice(1).join('-') : null;
    const wantLock = !displaySleep; // 防锁屏仅在显示器保持唤醒时有效
    const curLock = !!sleepUserActivityTimer;
    if (curArgs === wantArgs && curLock === wantLock) return true; // 已按同样参数在防休眠（含防锁屏状态），无需重启
    stopCaffeinate();
    try {
      startCaffeinate(!!displaySleep);
      log('[sleep] 禁止休眠已开启（模式=' + mode + (displaySleep ? '，允许显示器休眠，防锁屏关闭' : '，显示器保持唤醒，防锁屏开启') + '）');
    } catch (e) { log('[sleep] 开启失败: ' + e.message); return false; }
  } else {
    if (!sleepCaffeinate && !sleepUserActivityTimer) return true;
    stopCaffeinate();
    log('[sleep] 禁止休眠已解除（允许电脑休眠）');
  }
  return true;
}
function sleepNow() {
  try {
    if (IS_WIN) {
      // Windows：SetSuspendState(Hibernate=0, ForceCritical=0, DisableWakeEvent=0) → 睡眠
      const c = spawn('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0'], { stdio: 'ignore', windowsHide: true });
      c.on('error', (e) => log('[sleep] 立即休眠失败: ' + e.message));
      c.on('exit', () => log('[sleep] 已请求立即休眠（Windows SetSuspendState）'));
      return true;
    }
    const c = spawn('pmset', ['sleepnow'], { stdio: 'ignore' });
    c.on('error', (e) => log('[sleep] 立即休眠失败: ' + e.message));
    c.on('exit', () => log('[sleep] 已请求立即休眠'));
    return true;
  } catch (e) { log('[sleep] 立即休眠失败: ' + e.message); return false; }
}
function restoreSleepMode() {
  try {
    const f2 = path.join(DATA_DIR, 'sleep-mode.json');
    if (fs.existsSync(f2)) {
      const c = JSON.parse(fs.readFileSync(f2, 'utf8'));
      const mode = c.mode === 'keep' || c.mode === 'until-done' ? c.mode : 'allow';
      applySleepMode(mode, !!c.displaySleep);
    }
  } catch (_) {}
}

function startServer() {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.split('?')[0] === '/healthz') {
      return json(res, 200, {
        ok: true,
        service: 'workdaddy',
        version: DAEMON_VERSION,
        buildId: DAEMON_BUILD_ID,
        port: ACTUAL_PORT,
      });
    }
    if (req.url.startsWith('/api/')) {
      Promise.resolve(handleApi(req, res)).catch((e) => {
        if (res.headersSent) {
          try { res.end(); } catch (_) {}
          return;
        }
        const code = e && (e.statusCode === 400 || e.statusCode === 413) ? e.statusCode : 500;
        json(res, code, { ok: false, error: e && e.message ? e.message : 'internal error' });
      });
      return;
    }
    // 官方背景图静态服务：/wallpapers/<name>（供面板「主题」页缩略图预览）
    if (req.method === 'GET' && /^\/wallpapers\//.test(req.url)) {
      try {
        const name = path.basename(decodeURIComponent(req.url.split('?')[0].split('/').pop()));
        if (!/\.webp$/i.test(name)) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('not found');
        }
        const file = path.join(WALLPAPERS_DIR, name);
        if (!fs.existsSync(file)) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('not found');
        }
        res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
        return res.end(fs.readFileSync(file));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('error: ' + e.message);
      }
    }
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      // web/ 调试界面已移除（web 目录不再打包），根路径返回自包含的状态提示页
      const c = currentAccount();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(
        '<!doctype html><html lang="zh"><meta charset="utf-8"><title>WorkDaddy</title>' +
        '<body style="font-family:-apple-system,sans-serif;background:#0f1115;color:#e6e6e8;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">' +
        '<div style="text-align:center"><h1 style="margin:0 0 8px">WorkDaddy v' + DAEMON_VERSION + '</h1>' +
        '<p style="color:#9a9aa0;margin:0">面板入口：WorkBuddy 右下角机器人按钮</p>' +
        '<p style="color:#555;font-size:12px;margin-top:16px">守护进程运行中 · CDP ' + (cdp.connected ? '已连接' : '未连接') +
        (c && c.nickname ? ' · 当前账号：' + String(c.nickname).replace(/</g, '&lt;') : '') + '</p></div></body></html>'
      );
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  // DevTools WebSocket 代理：浏览器前端连 daemon，daemon 再用无 Origin
  // 的 WebSocket 连接实际 WorkBuddy CDP 端口。
  if (wsLib) {
    const { WebSocketServer } = wsLib;
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      let parsed;
      try { parsed = new URL(req.url, 'http://x'); } catch (_) { socket.destroy(); return; }
      if (!validApiToken(parsed.searchParams.get('token'))) { socket.destroy(); return; }
      const m = /^\/devtools-proxy\/([A-Za-z0-9_-]+)$/.exec(parsed.pathname);
      if (!m) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (front) => {
        if (!WebSocketCtor) { try { front.close(); } catch (_) {} return; }
        const devtoolsPort = cdp.port || CDP_PORT_HINT || 9222;
        const back = new WebSocketCtor('ws://127.0.0.1:' + devtoolsPort + '/devtools/page/' + m[1]);
        let backReady = false;
        let keepAlive = null;
        const queue = [];
        back.onopen = () => {
          backReady = true;
          while (queue.length) back.send(queue.shift());
          // 双层保活，消除 DevTools 前端的 "The tab is inactive"：
          // 1) Page.setWebLifecycleState active —— 维持 CDP lifecycle 状态；
          // 2) 注入 Page.screencastVisibilityChanged{visible:true} —— DevTools 的 ScreencastView
          const poke = () => {
            try {
              back.send(JSON.stringify({ id: 999001, method: 'Page.setWebLifecycleState', params: { state: 'active' } }));
            } catch (_) {}
          };
          // 注入 screencastVisibilityChanged{visible:true}：DevTools 前端的 ScreencastView
          // 通过 startScreencast 的回调监听该事件判断 "The tab is inactive"
          // （screencastVisibilityChanged 回调里 targetInactive = !visible）。实测 Electron
          // 在 startScreencast 后主动推送 visible:false（窗口无焦点/遮挡），导致前端进入
          // inactive 状态。注入 true 覆盖初始态。
          const injectVisible = () => {
            try {
              front.send(JSON.stringify({ method: 'Page.screencastVisibilityChanged', params: { visible: true } }));
            } catch (_) {}
          };
          poke();
          injectVisible();
          keepAlive = setInterval(() => { poke(); injectVisible(); }, 2000);
        };
        front.on('message', (data) => {
          const msg = data.toString();
          // 前端有交互时顺带戳一下保活
          if (backReady) { try { back.send(msg); } catch (_) {} } else queue.push(msg);
        });
        back.onmessage = (ev) => {
          // 拦截真实 screencastVisibilityChanged：visible 一律改写为 true 再转发，
          // 防止窗口失焦/遮挡后 DevTools 前端再次切入 "The tab is inactive"
          let msg = ev.data.toString();
          try {
            const j = JSON.parse(msg);
            if (j.method === 'Page.screencastVisibilityChanged' && j.params && j.params.visible === false) {
              j.params.visible = true;
              msg = JSON.stringify(j);
            }
          } catch (_) {}
          try { front.send(msg); } catch (_) {}
        };
        back.onerror = () => { try { front.close(); } catch (_) {} };
        const cleanup = () => {
          if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
          try { back.close(); } catch (_) {}
        };
        back.onclose = () => { cleanup(); try { front.close(); } catch (_) {} };
        front.on('close', cleanup);
        front.on('error', cleanup);
      });
    });
    log('[ws] DevTools 代理就绪 (/devtools-proxy/<targetId>)');
  }

  // 端口被占用则 +1 递增
  let port = UI_PORT_BASE;
  const tryListen = (attempt) => {
    server.once('error', (e) => {
      if (e.code === 'EADDRINUSE' && attempt < 7) {
        port += 1;
        log(`[http] 端口占用，改用 ${port}`);
        tryListen(attempt + 1);
      } else {
        log(`[http] 启动失败: ${e.message}`);
        process.exit(1);
      }
    });
    server.listen(port, HOST, () => {
      ACTUAL_PORT = port;
      log(`[http] Web 界面: http://${HOST}:${port}  (数据目录: ${DATA_DIR})`);
    });
  };
  tryListen(0);
}

/* ================= 启动 ================= */

ensureDirs(DATA_DIR, log);
if (!acquireDaemonLock()) process.exit(0);
// 首次启动初始化（新电脑 / 数据目录为空时）：内置壁纸 + WorkDaddy 主题 + 默认蒙版 10%
initBuiltinAssets();
// 启动时刷新决策弹窗规则到最新版本（已启用时替换旧规则段）
refreshAskModeIfEnabled();
log('WorkBuddy 多账号切换器启动 (CDP 模式)');
log(`登录信息文件: ${AUTH_FILE}`);
log(`备份目录: ${DATA_DIR}`);

restoreSleepMode();
startServer();
cdpLoop();
// 每天多次兜底自动签到（面板打开也会触发），带每日缓存不会重复领
setInterval(() => { claimDailyForAll().catch((e) => log('[checkin] 定时签到失败: ' + e.message)); }, 3 * 60 * 60 * 1000);
// 自动更新：启动时检查一次（延迟 8s 等网络就绪），之后每 6 小时一次
setTimeout(() => { checkUpdate(true).catch(() => {}); }, 8000);
updateTimer = setInterval(() => { checkUpdate(false).catch(() => {}); }, UPDATE_CHECK_INTERVAL);
updateTimer.unref && updateTimer.unref();

process.on('SIGTERM', () => {
  log('收到 SIGTERM，退出');
  releaseDaemonLock();
  try { stopCaffeinate(); } catch (_) {}
  try {
    fs.unwatchFile(AUTH_FILE);
  } catch (_) {}
  process.exit(0);
});
process.on('SIGINT', () => {
  releaseDaemonLock();
  process.exit(0);
});
process.on('exit', releaseDaemonLock);
