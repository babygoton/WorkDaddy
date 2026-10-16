'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { replaceFileWithRetry } = require('./atomic-file-write');
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_PIXELS = 16 * 1024 * 1024;
const MAX_FILES = 5000;

// Inspect a bounded header before Chromium decodes an external image. Extension
// alone is insufficient: a tiny compressed image can allocate gigabytes.
function imageDimensions(b) {
  let width, height, mime;
  if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && b.toString('ascii', 12, 16) === 'IHDR') {
    width = b.readUInt32BE(16); height = b.readUInt32BE(20); mime = 'image/png';
  } else if (b.length >= 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const format = b.toString('ascii', 12, 16);
    if (format === 'VP8X') {
      if (b[20] & 2) throw new Error('不支持动态壁纸');
      width = b.readUIntLE(24, 3) + 1; height = b.readUIntLE(27, 3) + 1;
    } else if (format === 'VP8 ' && b[23] === 0x9d && b[24] === 1 && b[25] === 0x2a) {
      width = b.readUInt16LE(26) & 0x3fff; height = b.readUInt16LE(28) & 0x3fff;
    } else if (format === 'VP8L' && b[20] === 0x2f) {
      const bits = b.readUInt32LE(21); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
    }
    mime = 'image/webp';
  } else if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 < b.length) {
      if (b[offset++] !== 0xff) break;
      while (b[offset] === 0xff) offset++;
      const marker = b[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > b.length) break;
      const length = b.readUInt16BE(offset);
      if (length < 2 || offset + length > b.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) {
        height = b.readUInt16BE(offset + 3); width = b.readUInt16BE(offset + 5); mime = 'image/jpeg'; break;
      }
      offset += length;
    }
  }
  if (!width || !height || width > 8192 || height > 8192 || width * height > MAX_PIXELS) throw new Error('图片无效或超过 1600 万像素');
  return { width, height, mime };
}

async function scanDirectory(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0')) throw new Error('请选择有效的壁纸文件夹');
  let real, entries;
  try { real = await fs.promises.realpath(directory); entries = await fs.promises.opendir(real); }
  catch (_) { throw new Error('壁纸目录不可用，请重新选择文件夹'); }
  const files = []; let visited = 0; let limited = false;
  for await (const entry of entries) {
    if (entry.isFile() && /\.(png|jpe?g|webp)$/i.test(entry.name)) files.push(entry.name);
    if (++visited >= 20000 || files.length >= MAX_FILES) { limited = true; break; }
  }
  if (!files.length) throw new Error('文件夹中没有 PNG / JPG / WebP 图片');
  return { directory: real, files, limited };
}

function createWallpaperRotation(options) {
  const now = options.now || Date.now;
  const random = options.random || Math.random;
  const schedule = options.setTimeout || setTimeout;
  const cancel = options.clearTimeout || clearTimeout;
  let config = { mode: 'manual', directory: '', intervalMinutes: 10, current: '' };
  try {
    const saved = JSON.parse(fs.readFileSync(options.configFile, 'utf8'));
    if (['manual', 'random'].includes(saved.mode) && typeof saved.directory === 'string' &&
        Number.isInteger(saved.intervalMinutes) && saved.intervalMinutes >= 1 && saved.intervalMinutes <= 1440) {
      config = { mode: saved.mode, directory: saved.directory, intervalMinutes: saved.intervalMinutes,
        current: typeof saved.current === 'string' && path.basename(saved.current) === saved.current ? saved.current : '' };
    }
  } catch (_) {}
  let files = [], bag = [], limited = false, generation = 0, configRequest = 0, nextAt = 0;
  let error = '', timer, flight, flightGeneration, destroyed = false, wasActive = false;
  const tickets = new Map();
  function persist() { replaceFileWithRetry(options.configFile, JSON.stringify(config, null, 2), 0o600); }
  function status() {
    return { ...config, count: files.length, limited, error,
      paused: config.mode === 'random' && !options.isActive(), nextAt };
  }
  function arm() {
    cancel(timer);
    if (destroyed || config.mode !== 'random') return;
    const delay = options.isActive() && nextAt > now() ? Math.min(15000, nextAt - now()) : 15000;
    timer = schedule(() => tick().catch(() => {}), Math.max(1000, delay));
    if (timer && timer.unref) timer.unref();
  }
  async function openFile(name) {
    if (!name || path.basename(name) !== name || !files.includes(name)) throw new Error('壁纸不可用');
    const file = path.join(config.directory, name);
    const real = await fs.promises.realpath(file);
    if (path.dirname(real) !== config.directory || real !== file) throw new Error('壁纸路径已变化');
    const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES || stat.size < 24) throw new Error('图片无效或超过 20MB');
      const header = Buffer.alloc(Math.min(stat.size, 256 * 1024));
      await handle.read(header, 0, header.length, 0);
      const dimensions = imageDimensions(header);
      return { handle, size: stat.size, ...dimensions };
    } catch (e) { await handle.close(); throw e; }
  }
  function choose() {
    if (!bag.length) {
      bag = files.slice();
      for (let i = bag.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [bag[i], bag[j]] = [bag[j], bag[i]]; }
      if (bag.length > 1 && bag[bag.length - 1] === config.current) [bag[0], bag[bag.length - 1]] = [bag[bag.length - 1], bag[0]];
    }
    return bag.pop();
  }
  async function run(restore) {
    if (destroyed || config.mode !== 'random') return status();
    if (!options.isActive()) {
      if (wasActive && options.invalidate) await options.invalidate();
      wasActive = false; nextAt = 0; arm(); return status();
    }
    const version = generation;
    wasActive = true;
    try {
      const scanned = await scanDirectory(config.directory);
      if (version !== generation || destroyed) return status();
      if (scanned.directory !== config.directory) throw new Error('壁纸目录不可用，请重新选择文件夹');
      if (files.join('\0') !== scanned.files.join('\0')) bag = [];
      files = scanned.files; limited = scanned.limited;
      const attempts = Math.min(files.length, 32); // Bound work when a folder contains corrupt files.
      for (let attempt = 0; attempt < attempts; attempt++) {
        const name = restore && attempt === 0 && files.includes(config.current) ? config.current : choose();
        if (restore && attempt === 0 && name === config.current) bag = bag.filter(file => file !== name);
        let image;
        try { image = await openFile(name); await image.handle.close(); }
        catch (_) { continue; }
        if (version !== generation || destroyed || !options.isActive()) return status();
        const key = crypto.randomBytes(24).toString('hex');
        tickets.set(key, { name, generation: version });
        let applied = false;
        try { applied = await options.apply({ key, name }); }
        catch (_) { tickets.delete(key); throw new Error('等待客户端连接后恢复壁纸'); }
        if (version !== generation || destroyed) { tickets.delete(key); return status(); }
        if (!applied) { tickets.delete(key); continue; }
        // Keep only the currently displayed file and its short-lived successor.
        for (const ticket of tickets.keys()) if (ticket !== key) tickets.delete(ticket);
        config.current = name; error = ''; nextAt = now() + config.intervalMinutes * 60000;
        persist(); return status();
      }
      throw new Error('未找到可用壁纸，请检查图片格式、大小或更换文件夹');
    } catch (e) {
      if (version === generation) { error = e.message; nextAt = now() + config.intervalMinutes * 60000; }
      return status();
    } finally { arm(); }
  }
  function enqueue(restore) {
    if (flight) {
      if (flightGeneration === generation) return flight;
      const version = generation;
      return flight.then(() => version === generation ? enqueue(restore) : status());
    }
    flightGeneration = generation;
    flight = run(restore).finally(() => { flight = null; });
    return flight;
  }
  async function tick() {
    if (config.mode !== 'random' || destroyed) return;
    if (!options.isActive()) return enqueue(true);
    if (!wasActive) return enqueue(true);
    if (now() >= nextAt) return enqueue(false);
    arm();
  }
  async function configure(body) {
    const request = ++configRequest;
    if (!body || !['manual', 'random'].includes(body.mode)) throw new Error('请选择壁纸模式');
    let scanned;
    let intervalMinutes = config.intervalMinutes;
    if (body.mode === 'random') {
      intervalMinutes = Number(body.intervalMinutes);
      if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440) throw new Error('切换间隔须为 1–1440 分钟的整数');
      scanned = await scanDirectory(body.directory);
      if (request !== configRequest) return status();
    }
    generation++; cancel(timer); tickets.clear();
    const previous = config;
    config = { ...config, mode: body.mode, intervalMinutes,
      directory: scanned ? scanned.directory : config.directory,
      current: scanned && scanned.directory !== config.directory ? '' : config.current };
    try { persist(); } catch (_) { config = previous; arm(); throw new Error('壁纸设置保存失败'); }
    if (scanned) { files = scanned.files; limited = scanned.limited; }
    bag = []; error = ''; nextAt = 0; wasActive = false;
    if (options.invalidate) await options.invalidate();
    if (request === configRequest && config.mode === 'random') return enqueue(true);
    return status();
  }
  arm();
  return { status, configure, next: () => enqueue(false), restore: () => enqueue(true),
    async openImage(key) {
      const ticket = tickets.get(key);
      if (!ticket || ticket.generation !== generation || config.mode !== 'random') throw new Error('壁纸已失效');
      return openFile(ticket.name);
    },
    destroy() { destroyed = true; generation++; cancel(timer); tickets.clear(); },
  };
}

// Serialized through CDP. No theme reapplication, React access, persistent
// observer or renderer interval. A pending load cannot overwrite a later choice.
async function updateWallpaperInRenderer(options) {
  let runtime = window.__wbsWallpaperRuntime;
  if (!runtime) {
    runtime = { current: '', pending: null, dispose() {
      if (runtime.pending) { runtime.pending.controller.abort(); if (runtime.pending.url) { URL.revokeObjectURL(runtime.pending.url); runtime.pending.url = ''; } }
      if (runtime.current) URL.revokeObjectURL(runtime.current);
      runtime.current = ''; runtime.pending = null;
      document.documentElement.style.removeProperty('--wbs-wallpaper-image');
      if (window.__wbsWallpaperRuntime === runtime) delete window.__wbsWallpaperRuntime;
    } };
    window.__wbsWallpaperRuntime = runtime;
  }
  if (runtime.pending) runtime.pending.controller.abort();
  const pending = { controller: new AbortController(), url: '' };
  runtime.pending = pending;
  let timeout;
  try {
    const load = async () => {
      const response = await fetch(options.url, { headers: { 'X-WorkDaddy-Token': options.token }, cache: 'no-store', signal: pending.controller.signal });
      if (!response.ok) throw new Error('wallpaper unavailable');
      const blob = await response.blob();
      if (pending.controller.signal.aborted || window.__wbsWallpaperRuntime !== runtime) return false;
      pending.url = URL.createObjectURL(blob);
      const image = new Image(); image.src = pending.url;
      await image.decode(); image.src = '';
      if (pending.controller.signal.aborted || runtime.pending !== pending || window.__wbsWallpaperRuntime !== runtime ||
          document.documentElement.getAttribute('data-wbs-theme-id') !== 'nebula') return false;
      const old = runtime.current;
      runtime.current = pending.url; pending.url = '';
      document.documentElement.style.setProperty('--wbs-wallpaper-image', 'url("' + runtime.current + '")');
      if (old) URL.revokeObjectURL(old);
      return true;
    };
    return await Promise.race([load(), new Promise(resolve => { timeout = setTimeout(() => { pending.controller.abort(); resolve(false); }, 8000); })]);
  } catch (_) { return false; }
  finally {
    clearTimeout(timeout);
    if (pending.url) { URL.revokeObjectURL(pending.url); pending.url = ''; }
    if (runtime.pending === pending) runtime.pending = null;
  }
}

let pickerPending = false;
function pickWallpaperDirectory(platform = process.platform) {
  if (pickerPending) return Promise.reject(new Error('文件夹选择窗口已打开'));
  pickerPending = true;
  let executable, args;
  if (platform === 'darwin') {
    executable = '/usr/bin/osascript'; args = ['-e', 'POSIX path of (choose folder with prompt "选择壁纸文件夹")'];
  } else if (platform === 'win32') {
    executable = 'powershell.exe';
    const script = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; $picker = New-Object System.Windows.Forms.FolderBrowserDialog; $picker.Description = "选择壁纸文件夹"; $picker.ShowNewFolderButton = $false; if ($picker.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($picker.SelectedPath) }; $picker.Dispose()';
    args = ['-NoProfile', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
  } else {
    executable = 'zenity'; args = ['--file-selection', '--directory', '--title=选择壁纸文件夹'];
  }
  return new Promise((resolve, reject) => execFile(executable, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 16384, windowsHide: true }, (error, stdout) => {
    pickerPending = false;
    if (error && (platform === 'darwin' && /-128/.test(error.message) || platform === 'linux' && error.code === 1)) return resolve('');
    if (error) return reject(new Error('无法打开文件夹选择窗口，请填写目录路径'));
    resolve(String(stdout || '').replace(/^\uFEFF/, '').trim());
  }));
}

module.exports = { createWallpaperRotation, imageDimensions, updateWallpaperInRenderer, pickWallpaperDirectory };
