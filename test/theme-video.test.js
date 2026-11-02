'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {
  VIDEO_MAX_BYTES, VIDEO_LAYER_CSS,
  sniffVideo, resolveVideoFile, videoRootBackground,
  updateVideoInRenderer, disposeVideoInRenderer,
} = require('../scripts/wallpaper-video');

function mp4(brand = 'isom') {
  const b = Buffer.alloc(32);
  b.writeUInt32BE(32, 0); b.write('ftyp', 4, 'ascii'); b.write(brand, 8, 'ascii');
  return b;
}
function webm(docType = 'webm') {
  const b = Buffer.alloc(64);
  b.writeUInt32BE(0x1a45dfa3, 0); b.write(docType, 24, 'latin1');
  return b;
}

test('sniffVideo accepts only browser-playable containers and trusts magic bytes', () => {
  assert.deepEqual([sniffVideo(mp4()).ext, sniffVideo(mp4()).mime], ['mp4', 'video/mp4']);
  assert.deepEqual([sniffVideo(webm()).ext, sniffVideo(webm()).mime], ['webm', 'video/webm']);
  // 同结构但不是视频的图片容器
  assert.equal(sniffVideo(mp4('heic')), null);
  assert.equal(sniffVideo(mp4('avif')), null);
  // mkv 是 EBML 但不是 webm，Chromium 播不了
  assert.equal(sniffVideo(webm('matroska')), null);
  assert.equal(sniffVideo(Buffer.from('\x00\x00\x00\x18ftypmp4')), null);
  assert.equal(sniffVideo(Buffer.alloc(0)), null);
  assert.equal(sniffVideo(Buffer.from('not a video at all, just text')), null);
});

test('resolveVideoFile stays inside themes/ and falls back to the file name layout', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbs-video-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'nebula'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'nebula', 'background.mp4'), mp4());
  assert.equal(resolveVideoFile(dir, 'nebula', 'background.mp4'), path.join(dir, 'nebula', 'background.mp4'));
  // 主题 id 里的路径分隔符会被压成下划线，不可能逃出 themes/
  assert.equal(resolveVideoFile(dir, '../nebula', 'background.mp4'), null);
  // video 字段写成分散路径时只取文件名，仍落在该主题目录内
  assert.equal(resolveVideoFile(dir, 'nebula', '../background.mp4'), path.join(dir, 'nebula', 'background.mp4'));
  fs.writeFileSync(path.join(dir, 'outside.mp4'), mp4());
  assert.equal(resolveVideoFile(dir, 'nebula', '../../../outside.mp4'), null, 'multi-level traversal cannot leave themes/');
  try {
    fs.symlinkSync(path.join(dir, 'outside.mp4'), path.join(dir, 'nebula', 'linked.mp4'));
    assert.equal(resolveVideoFile(dir, 'nebula', 'linked.mp4'), null, 'symlinks cannot expose files outside themes/');
  } catch (_) {}
  assert.equal(resolveVideoFile(dir, 'nebula', 'missing.mp4'), null);
  assert.equal(resolveVideoFile(dir, '', 'background.mp4'), null);
});

test('video background keeps the shared mask but drops the image layer', () => {
  const css = videoRootBackground(0.45);
  assert.match(css, /rgba\(0,0,0,0\.45\)/);
  assert.doesNotMatch(css, /url\(/);
  // 蒙版可关：0 不能被兜底成默认值
  assert.match(videoRootBackground(0), /rgba\(0,0,0,0\)/);
  assert.match(videoRootBackground(-1), /rgba\(0,0,0,0\)/);
  assert.match(videoRootBackground(9), /rgba\(0,0,0,1\)/);
  // 视频层停在第 0 层、#root 提到第 1 层：body 的不透明底色画在负层级之上，
  // 视频一旦沉到 z-index:-1 就会被整块盖住
  assert.match(VIDEO_LAYER_CSS, /#wbs-video-wallpaper\{position:fixed;inset:0;z-index:0;/);
  assert.match(VIDEO_LAYER_CSS, /#root\{position:relative;z-index:1\}/);
  assert.match(VIDEO_LAYER_CSS, /pointer-events:none/);
});

/** 极简 DOM：只实现 updateVideoInRenderer 真正用到的接口。 */
function fakeWallpaperDom() {
  const fetched = [];
  const revoked = [];
  let hostCount = 0;
  function element(tag) {
    const listeners = new Map();
    const el = {
      tagName: tag, id: '', parentNode: null, isConnected: false, readyState: 0, style: {},
      attrs: {}, children: [], classList: {
        set: new Set(),
        add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, contains(c) { return this.set.has(c); },
      },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
      removeAttribute(k) { delete this.attrs[k]; },
      appendChild(child) { return el.insertBefore(child, null); },
      insertBefore(child, ref) {
        if (child.parentNode) child.parentNode.removeChild(child);
        child.parentNode = el;
        const at = ref ? el.children.indexOf(ref) : -1;
        if (at < 0) el.children.push(child); else el.children.splice(at, 0, child);
        child.isConnected = true;
        return child;
      },
      removeChild(child) {
        const at = el.children.indexOf(child);
        if (at >= 0) el.children.splice(at, 1);
        child.parentNode = null; child.isConnected = false;
        return child;
      },
      querySelector(sel) {
        const want = sel.replace(/^[#.]/, '');
        return el.children.find(c => (sel[0] === '#' ? c.id : c.tagName) === want) || null;
      },
      querySelectorAll() { return []; },
      addEventListener(type, fn) { listeners.set(type, fn); },
      removeEventListener(type) { listeners.delete(type); },
      dispatch(type) { const fn = listeners.get(type); if (fn) { listeners.delete(type); fn(); } },
      play() { el.playCount = (el.playCount || 0) + 1; return Promise.resolve(); },
      pause() { el.pauseCount = (el.pauseCount || 0) + 1; },
      load() { el.readyState = 4; setTimeout(() => el.dispatch('loadeddata'), 0); },
    };
    if (tag === 'div') hostCount++;
    return el;
  }
  const body = element('body');
  const head = element('head');
  const docListeners = new Map();
  const document = {
    hidden: false,
    body,
    head,
    documentElement: element('html'),
    createElement: element,
    getElementById(id) {
      const walk = node => {
        for (const child of node.children) {
          if (child.id === id) return child;
          const found = walk(child);
          if (found) return found;
        }
        return null;
      };
      return walk(body) || walk(head);
    },
    addEventListener(type, fn) { docListeners.set(type, fn); },
    removeEventListener(type) { docListeners.delete(type); },
  };
  const env = {
    window: {}, document,
    AbortController, setTimeout, clearTimeout,
    URL: {
      createObjectURL: () => 'blob:video-' + (revoked.length + 1),
      revokeObjectURL: url => revoked.push(url),
    },
    fetch: async (url, options) => {
      fetched.push({ url, options });
      return { ok: true, blob: async () => ({ size: 1024 }) };
    },
    Promise, console,
  };
  vm.createContext(env);
  vm.runInContext('var update = ' + updateVideoInRenderer.toString() + ';var dispose = ' + disposeVideoInRenderer.toString(), env);
  return { env, document, body, element, fetched, revoked, docListeners, hostCount: () => hostCount };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 5));

test('renderer mounts one video layer under body, muted and looping, and reuses it for the same key', async () => {
  const dom = fakeWallpaperDom();
  const first = dom.env.update({
    url: '/api/theme-video?id=nebula', token: 'tok', key: 'nebula:background.mp4:1024:1',
    css: '#wbs-video-wallpaper{z-index:-1}',
  });
  await settle();
  assert.equal(await first, true);

  const host = dom.document.getElementById('wbs-video-wallpaper');
  assert.ok(host, 'video host exists');
  assert.equal(dom.body.children[0], host, 'host is body\'s first child so #root paints the mask above it');
  assert.equal(dom.fetched.length, 1);
  assert.equal(dom.fetched[0].options.headers['X-WorkDaddy-Token'], 'tok');
  // 视频层样式独立挂在 head 上，不随主题样式表重写
  const style = dom.document.getElementById('wbs-video-style');
  assert.ok(style, 'layer keeps its own style element');
  assert.equal(style.textContent, '#wbs-video-wallpaper{z-index:-1}');

  const video = host.querySelector('video');
  assert.equal(video.muted, true, 'autoplay only works muted');
  assert.equal(video.loop, true);
  assert.equal(video.attrs.muted, '');
  assert.equal(video.attrs.playsinline, '');
  assert.equal(video.src, 'blob:video-1');
  assert.equal(host.classList.contains('wbs-video-ready'), true);
  assert.equal(video.playCount >= 1, true);

  // 同样的 key（拖蒙版/改毛玻璃会重复应用主题）不能再拉一遍视频
  assert.equal(await dom.env.update({ url: '/api/theme-video?id=nebula', token: 'tok', key: 'nebula:background.mp4:1024:1', css: '' }), true);
  await settle();
  assert.equal(dom.fetched.length, 1, 'same key must not refetch');
  assert.equal(dom.document.getElementById('wbs-video-wallpaper'), host, 'no duplicate layer');
  assert.equal(dom.document.head.children.length, 1, 'style element is reused, not stacked');
});

test('renderer replaces the layer for a new key and dispose removes it completely', async () => {
  const dom = fakeWallpaperDom();
  const first = dom.env.update({ url: '/a', token: 'tok', key: 'k1', css: 'a{}' });
  await settle();
  assert.equal(await first, true);

  const second = dom.env.update({ url: '/b', token: 'tok', key: 'k2', css: 'b{}' });
  await settle();
  assert.equal(await second, true);
  assert.equal(dom.fetched.length, 2);
  assert.deepEqual(dom.revoked, ['blob:video-1'], 'previous blob released');

  dom.env.dispose();
  assert.equal(dom.document.getElementById('wbs-video-wallpaper'), null);
  assert.equal(dom.body.children.length, 0, 'no leftover node');
  assert.equal(dom.document.getElementById('wbs-video-style'), null, 'style element removed with the layer');
  assert.equal(dom.env.window.__wbsVideoRuntime, undefined);
});

test('renderer retries the same video after a failed request', async () => {
  const dom = fakeWallpaperDom();
  let attempts = 0;
  dom.env.fetch = async () => {
    attempts++;
    if (attempts === 1) throw new Error('temporary network failure');
    return { ok: true, blob: async () => ({ size: 1024 }) };
  };
  const options = { url: '/a', token: 'tok', key: 'same-video' };
  assert.equal(await dom.env.update(options), false);
  assert.equal(dom.env.window.__wbsVideoRuntime, undefined, 'failed runtime is disposed');
  const retried = dom.env.update(options);
  await settle();
  assert.equal(await retried, true);
  assert.equal(attempts, 2, 'retry fetches the video again');
  dom.env.dispose();
});

test('video layer pauses while the window is hidden', async () => {
  const dom = fakeWallpaperDom();
  const loading = dom.env.update({ url: '/a', token: 'tok', key: 'k1' });
  await settle();
  await loading;
  const video = dom.document.getElementById('wbs-video-wallpaper').querySelector('video');
  const before = video.playCount;
  dom.document.hidden = true;
  dom.docListeners.get('visibilitychange')();
  assert.equal(video.pauseCount >= 1, true);
  dom.document.hidden = false;
  dom.docListeners.get('visibilitychange')();
  assert.equal(video.playCount > before, true);
});

test('video size limit is explicit and generous enough for a short clip loop', () => {
  assert.equal(VIDEO_MAX_BYTES, 128 * 1024 * 1024);
});

const daemonSource = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');

/** 在沙箱里跑真正的 applyThemeByCdp，拿它生成的注入表达式。 */
async function applyThemeSandbox(t, theme, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbs-theme-video-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'nebula'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'nebula', 'background.mp4'), mp4());
  const start = daemonSource.indexOf('async function applyThemeByCdp(id, options = {})');
  const end = daemonSource.indexOf('\n/**', start);
  const seen = { expression: '', applied: [], disposed: 0 };
  const context = {
    PROFILE: { name: 'WorkBuddy', capabilities: { theme: true } },
    cdp: { connected: true, ws: { readyState: 1 } },
    readSessionState: () => ({ themeTakeoverEnabled: true }), themeApplyGeneration: 0,
    stopSystemThemePolling() {}, currentAccount: () => null, log: () => {},
    getTheme: () => theme, THEMES_DIR: dir, DATA_DIR: dir, path, fs,
    LOCAL_THEME_OVERRIDES: [], themeExtrasCss: () => '', themeVarsCss: () => '',
    MAX_BACKGROUND_BLUR_PX: 24, readBackgroundBlur: () => 0,
    resolveVideoFile, VIDEO_LAYER_CSS, videoRootBackground,
    lastVideoKey: '', wallpaperRotation: { status: () => ({ mode: 'manual' }) },
    setTimeout: resolve => resolve(),
    applyVideoWallpaperByCdp: async (video, id) => { seen.applied.push([id, video.name]); return true; },
    disposeVideoWallpaperByCdp: async () => { seen.disposed++; return true; },
    cdpSend: async (_method, params) => {
      seen.expression = params.expression;
      // nebula 会先要求官方深色就绪（ready），再注入毛玻璃样式
      return { result: { value: { applied: true, ready: true, dark: true, bg: '', text: '' } } };
    },
    ...extra,
  };
  vm.runInNewContext(daemonSource.slice(start, end), context);
  await context.applyThemeByCdp('nebula');
  return seen;
}

test('theme apply hands the video layer to the renderer instead of a data URL background', async t => {
  const seen = await applyThemeSandbox(t, {
    id: 'nebula', dark: true, colors: { '--wb-bg-primary': '#111' }, video: 'background.mp4',
  });
  assert.match(seen.expression, /#root\{background:linear-gradient\(rgba\(0,0,0,0\.3\)/);
  assert.doesNotMatch(seen.expression, /data:image/, 'video mode must not embed an image background');
  assert.deepEqual(seen.applied, [['nebula', 'background.mp4']]);
  assert.equal(seen.disposed, 0);
});

test('theme apply without a video tears down a previously mounted layer', async t => {
  const seen = await applyThemeSandbox(t, { id: 'nebula', dark: true, colors: {} }, { lastVideoKey: 'nebula:background.mp4:1:1' });
  // 注入表达式本身就带兜底清理（daemon 重启后 lastVideoKey 为空也能摘掉旧层）
  assert.match(seen.expression, /window\.__wbsVideoRuntime\.dispose\(\)/);
  assert.deepEqual(seen.applied, []);
  // nebula 会先做一次官方深色预置（nativeOnly，videoPreflight），那里也会清一次视频层；
  // 真实实现清完会把 lastVideoKey 置空，所以外层那次是空操作。
  assert.ok(seen.disposed >= 1, 'previous layer must be removed');
});
