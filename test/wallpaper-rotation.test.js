'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createWallpaperRotation, imageDimensions, updateWallpaperInRenderer } = require('../scripts/wallpaper-rotation');

function png(width = 100, height = 80) {
  const b = Buffer.alloc(33); Buffer.from('89504e470d0a1a0a', 'hex').copy(b);
  b.write('IHDR', 12); b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20); return b;
}
function setup(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbs-rotation-'));
  const folder = path.join(dir, 'pictures'); fs.mkdirSync(folder);
  for (const name of ['a.png', 'b.png', '中文 空格.png']) fs.writeFileSync(path.join(folder, name), png());
  const configFile = path.join(dir, 'rotation.json');
  const images = []; let active = true; let time = 1000000; let scheduled;
  const rotation = createWallpaperRotation({ configFile, isActive: () => active,
    apply: async image => { images.push(image); return true; }, invalidate: async () => {},
    random: () => 0.4, now: () => time,
    setTimeout: (fn, ms) => { scheduled = { fn, ms }; return { unref() {} }; }, clearTimeout() {}, ...overrides });
  t.after(async () => { rotation.destroy(); await fs.promises.rm(dir, { recursive: true, force: true }); });
  return { dir, folder, configFile, images, rotation, pause: () => { active = false; }, resume: () => { active = true; },
    advance: ms => { time += ms; }, timer: () => scheduled };
}

test('rotation shuffles without repeats, streams original files and only persists metadata', async t => {
  const s = setup(t); const original = fs.readdirSync(s.folder);
  await s.rotation.configure({ mode: 'random', directory: s.folder, intervalMinutes: 1 });
  for (let i = 0; i < 5; i++) await s.rotation.next();
  const names = s.images.map(i => i.name);
  assert.equal(new Set(names.slice(0, 3)).size, 3);
  assert.equal(new Set(names.slice(3, 6)).size, 3);
  assert.notEqual(names[2], names[3]);
  assert.deepEqual(fs.readdirSync(s.folder), original);
  assert.deepEqual(fs.readdirSync(s.dir).sort(), ['pictures', 'rotation.json']);
  const image = await s.rotation.openImage(s.images.at(-1).key);
  assert.equal(image.mime, 'image/png');
  assert.deepEqual(await image.handle.readFile(), png()); await image.handle.close();
  await assert.rejects(s.rotation.openImage(s.images[0].key));
  await assert.rejects(s.rotation.openImage('../pictures/a.png'));
});

test('manual mode cancels pending work and cannot be overwritten by an old completion', async t => {
  let finish; let invalidations = 0;
  const s = setup(t, { apply: () => new Promise(resolve => { finish = resolve; }), invalidate: async () => { invalidations++; } });
  const pending = s.rotation.configure({ mode: 'random', directory: s.folder, intervalMinutes: 1 });
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  await s.rotation.configure({ mode: 'manual' });
  finish(true); await pending;
  assert.equal(s.rotation.status().mode, 'manual');
  assert.equal(s.rotation.status().current, '');
  assert.ok(invalidations >= 2);
  assert.equal(JSON.parse(fs.readFileSync(s.configFile)).mode, 'manual');
});

test('restart restores current selection; inactive clients pause without catching up', async t => {
  const s = setup(t);
  await s.rotation.configure({ mode: 'random', directory: s.folder, intervalMinutes: 3 });
  const current = s.rotation.status().current;
  s.pause(); s.advance(3600000); await s.rotation.next();
  assert.equal(s.images.length, 1);
  s.resume(); await s.rotation.restore();
  assert.equal(s.images.at(-1).name, current);
  assert.equal(s.images.length, 2);
  const restored = createWallpaperRotation({ configFile: s.configFile, isActive: () => true,
    apply: async image => { assert.equal(image.name, current); return true; }, invalidate: async () => {},
    setTimeout: () => 1, clearTimeout() {} });
  t.after(() => restored.destroy()); await restored.restore();
  assert.equal(restored.status().mode, 'random');
  assert.equal(restored.status().intervalMinutes, 3);
});

test('folder validation rejects bad input and scans only regular top-level supported files', async t => {
  const s = setup(t);
  for (const intervalMinutes of [0, 0.5, NaN, 1441, 'oops']) {
    await assert.rejects(s.rotation.configure({ mode: 'random', directory: s.folder, intervalMinutes }));
  }
  await assert.rejects(s.rotation.configure({ mode: 'random', directory: 'relative', intervalMinutes: 1 }));
  await assert.rejects(s.rotation.configure({ mode: 'unknown' }));
  fs.mkdirSync(path.join(s.folder, 'sub')); fs.writeFileSync(path.join(s.folder, 'sub', 'hidden.png'), png());
  fs.writeFileSync(path.join(s.folder, 'ignore.svg'), '<svg/>');
  fs.symlinkSync(path.join(s.folder, 'a.png'), path.join(s.folder, 'link.png'));
  await s.rotation.configure({ mode: 'random', directory: s.folder, intervalMinutes: 1 });
  assert.equal(s.rotation.status().count, 3);
});

test('bad images are skipped and missing directories preserve the current state with an actionable error', async t => {
  const s = setup(t);
  fs.writeFileSync(path.join(s.folder, 'bad.png'), 'broken');
  fs.writeFileSync(path.join(s.folder, 'huge.png'), png(60000, 60000));
  await s.rotation.configure({ mode: 'random', directory: s.folder, intervalMinutes: 1 });
  for (let i = 0; i < 5; i++) await s.rotation.next();
  assert.ok(s.images.every(i => !['bad.png', 'huge.png'].includes(i.name)));
  const current = s.rotation.status().current;
  fs.renameSync(s.folder, s.folder + '-removed');
  await s.rotation.next();
  assert.equal(s.rotation.status().current, current);
  assert.match(s.rotation.status().error, /目录不可用/);
});

test('image endpoint revalidates real paths and dimensions after a file is replaced', async t => {
  const s = setup(t); await s.rotation.configure({ mode: 'random', directory: s.folder, intervalMinutes: 1 });
  const selected = s.images.at(-1); const file = path.join(s.folder, selected.name);
  fs.unlinkSync(file); fs.symlinkSync(s.configFile, file);
  await assert.rejects(s.rotation.openImage(selected.key));
});

test('header validation recognises PNG, JPEG and WebP and rejects oversized dimensions', () => {
  assert.deepEqual(imageDimensions(png()), { width: 100, height: 80, mime: 'image/png' });
  const jpeg = Buffer.from('ffd8ffc00011080050006403011100021100031100ffd9', 'hex');
  assert.equal(imageDimensions(jpeg).width, 100);
  const webp = Buffer.alloc(30); webp.write('RIFF'); webp.write('WEBP', 8); webp.write('VP8X', 12);
  webp.writeUIntLE(99, 24, 3); webp.writeUIntLE(79, 27, 3);
  assert.equal(imageDimensions(webp).height, 80);
  assert.throws(() => imageDimensions(png(60000, 60000)));
  assert.throws(() => imageDimensions(Buffer.from('not an image')));
});

function renderer() {
  const revoked = []; const props = new Map(); let resolveImage;
  const win = {};
  const env = { window: win, document: { hidden: false, documentElement: {
    getAttribute: () => 'nebula', style: { setProperty: (k, v) => props.set(k,v), removeProperty: k => props.delete(k) } } },
    fetch: async () => ({ ok: true, blob: async () => ({}) }),
    URL: { createObjectURL: () => 'blob:' + Math.random(), revokeObjectURL: url => revoked.push(url) },
    Image: function () { this.decode = () => new Promise(resolve => { resolveImage = resolve; }); },
    AbortController, setTimeout, clearTimeout };
  vm.createContext(env); vm.runInContext('var update = ' + updateWallpaperInRenderer.toString(), env);
  return { env, win, revoked, props, finish: () => resolveImage(), wait: async () => { while (!resolveImage) await new Promise(resolve => setImmediate(resolve)); } };
}

test('renderer swaps only after decode, releases old URLs and cancels late completions', async () => {
  const r = renderer(); const first = r.env.update({ url: '/image', token: 'synthetic' });
  await r.wait(); assert.equal(r.props.size, 0); r.finish(); assert.equal(await first, true);
  assert.equal(r.props.size, 1);
  const second = r.env.update({ url: '/next', token: 'synthetic' });
  await new Promise(resolve => setImmediate(resolve));
  r.win.__wbsWallpaperRuntime.dispose(); r.finish();
  assert.equal(await second, false); assert.equal(r.props.size, 0);
  assert.equal(new Set(r.revoked).size, 2);
  assert.equal(r.revoked.length, 2, 'each URL is released exactly once');
  const third = r.env.update({ url: '/restart', token: 'synthetic' });
  await new Promise(resolve => setImmediate(resolve)); r.finish();
  assert.equal(await third, true);
  r.win.__wbsWallpaperRuntime.dispose();
});


test('concurrent next requests share one load instead of queueing repeated changes', async t => {
  let finish; let blocked = false;
  const s = setup(t, { apply: async image => {
    s.images.push(image);
    if (blocked) await new Promise(resolve => { finish = resolve; });
    return true;
  } });
  await s.rotation.configure({ mode: 'random', directory: s.folder, intervalMinutes: 1 });
  blocked = true;
  const pending = Array.from({ length: 20 }, () => s.rotation.next());
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  finish(); await Promise.all(pending);
  assert.equal(s.images.length, 2);
});

test('scheduler waits for the interval and resumes once after an inactive period', async t => {
  const s = setup(t);
  await s.rotation.configure({ mode: 'random', directory: s.folder, intervalMinutes: 3 });
  s.advance(60000); await s.timer().fn();
  assert.equal(s.images.length, 1);
  s.advance(120000); await s.timer().fn();
  assert.equal(s.images.length, 2);
  s.pause(); s.advance(3600000); await s.timer().fn();
  assert.equal(s.images.length, 2);
  s.resume(); await s.timer().fn();
  assert.equal(s.images.length, 3);
  await s.timer().fn();
  assert.equal(s.images.length, 3, 'no catch-up burst after resume');
});

test('daemon routes stream authenticated original bytes and reject stale image tickets', async t => {
  const http = require('node:http');
  const s = setup(t);
  const source = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');
  const start = source.indexOf('function handleApi(req, res)');
  const end = source.indexOf('\n/*', start + 10);
  const context = {
    URL, HOST: '127.0.0.1', PROFILE: { capabilities: { theme: true } }, wallpaperRotation: s.rotation,
    isAllowedApiOrigin: origin => origin === 'file://',
    isApiRequestAuthorized: req => req.headers['x-workdaddy-token'] === 'synthetic-test-token',
    json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); },
    readBody: async req => { let body = ''; for await (const c of req) body += c; return JSON.parse(body); },
  };
  // Compile the actual handler without starting the daemon or touching account files.
  vm.runInNewContext(source.slice(start, end), context);
  const server = http.createServer(context.handleApi);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const headers = { 'X-WorkDaddy-Token': 'synthetic-test-token', Origin: 'file://' };
  assert.equal((await fetch(base + '/api/wallpaper-rotation')).status, 401);
  let response = await fetch(base + '/api/wallpaper-rotation', { method: 'POST', headers,
    body: JSON.stringify({ mode: 'random', directory: s.folder, intervalMinutes: 5 }) });
  assert.equal(response.status, 200);
  const saved = await response.json(); assert.equal(saved.mode, 'random');
  const url = base + '/api/wallpaper-rotation/image?key=' + s.images.at(-1).key;
  assert.equal((await fetch(url)).status, 401);
  response = await fetch(url, { headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), 'file://');
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png());
  await fetch(base + '/api/wallpaper-rotation', { method: 'POST', headers, body: '{"mode":"manual"}' });
  assert.equal((await fetch(url, { headers })).status, 404);
  response = await fetch(base + '/api/wallpaper-rotation', { method: 'POST', headers, body: '{"mode":"bogus"}' });
  assert.equal(response.status, 400);
});

test('panel permits pasting the first directory, keeps modes exclusive and saves a custom interval', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/inject.js'), 'utf8');
  const start = source.indexOf('    var wallpaperRotationState = null;');
  const end = source.indexOf('    // 官方壁纸网格：', start);
  const node = extra => ({ value: '', hidden: false, dataset: {}, listeners: {},
    addEventListener(event, fn) { this.listeners[event] = fn; }, focus() {}, select() {}, ...extra });
  const radios = ['manual', 'random'].map(value => node({ value, checked: value === 'manual' }));
  const ids = {};
  for (const id of ['random', 'manual', 'directory', 'interval', 'minutes', 'pick', 'next', 'custom-wrap', 'status']) ids['#wbs-wallpaper-' + id] = node();
  ids['#wbs-wallpaper-interval'].value = '10'; ids['#wbs-wallpaper-minutes'].value = '10';
  const requests = [];
  let persisted = { mode: 'manual', directory: '', intervalMinutes: 10, current: '', paused: false };
  const env = { alive: true, state: { open: false }, root: {}, document: { activeElement: null }, setBuildInterval() {},
    themePane: { querySelector: id => ids[id], querySelectorAll: selector => selector.startsWith('input[name=') ? radios : [] },
    toast: message => assert.fail(message), api: async (route, options) => {
      requests.push({ route, options });
      if (route.endsWith('/pick')) return { cancelled: true };
      if (options?.body) persisted = { ...persisted, ...JSON.parse(options.body) };
      return { ...persisted };
    } };
  vm.createContext(env); vm.runInContext(source.slice(start, end), env);
  const flush = () => new Promise(resolve => setImmediate(resolve));
  env.wireWallpaperRotation(); await flush();
  radios[1].checked = true; radios[1].listeners.change();
  assert.equal(ids['#wbs-wallpaper-random'].hidden, false);
  assert.equal(ids['#wbs-wallpaper-manual'].hidden, true);
  assert.equal(ids['#wbs-wallpaper-next'].disabled, true);
  assert.equal(requests.some(r => r.route.endsWith('/pick')), false, 'first selection allows typing instead of forcing a native picker');
  await env.loadWallpaperRotation();
  assert.equal(ids['#wbs-wallpaper-random'].hidden, false, 'polling preserves the unsaved folder entry');
  ids['#wbs-wallpaper-directory'].value = '/pictures';
  ids['#wbs-wallpaper-directory'].listeners.change(); await flush();
  assert.equal(persisted.mode, 'random'); assert.equal(persisted.directory, '/pictures');
  ids['#wbs-wallpaper-interval'].value = 'custom'; ids['#wbs-wallpaper-interval'].listeners.change();
  assert.equal(ids['#wbs-wallpaper-custom-wrap'].hidden, false);
  ids['#wbs-wallpaper-minutes'].value = '17'; ids['#wbs-wallpaper-minutes'].listeners.change(); await flush();
  assert.equal(persisted.intervalMinutes, 17);
  ids['#wbs-wallpaper-pick'].listeners.click(); await flush();
  assert.equal(persisted.directory, '/pictures', 'cancel leaves the chosen directory intact');
  radios[0].checked = true; radios[0].listeners.change(); await flush();
  assert.equal(persisted.mode, 'manual');
  assert.equal(ids['#wbs-wallpaper-random'].hidden, true);
  assert.equal(ids['#wbs-wallpaper-manual'].hidden, false);
});
