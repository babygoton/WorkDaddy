'use strict';

// 视频壁纸（毛玻璃主题）
// ============================================================
// 图片壁纸是把 #root 的 background 换成 data URL，视频没法这么塞，所以改成
// 「#root 只留蒙版/渐变，真正的画面交给 z-index:-1 的 <video> 层」。
// 两者的蒙版、背景毛玻璃、容器透明化完全复用，只有背景层本身不同。
//
// 视频层必须挂在 document.body 上并位于 #root 之下：
//   body 背景（画布）→ #wbs-video-wallpaper → #root 半透明蒙版 → 应用内容
// 这样蒙版才能压在视频上，应用自己的容器透明规则也照旧生效。
//
// 视频不进 CSS、不进 CDP 表达式（大文件会把协议撑爆），由 daemon 通过
// /api/theme-video 提供字节流，渲染进程 fetch 成 blob 再交给 <video>。
const fs = require('fs');
const path = require('path');

const VIDEO_MAX_BYTES = 128 * 1024 * 1024;
const VIDEO_HEAD_BYTES = 64 * 1024;

/** 只按文件头判断容器格式：扩展名与 Content-Type 都由调用方给，不能作为落盘依据。 */
function sniffVideo(buf) {
  if (!buf || buf.length < 16) return null;
  // ISO BMFF（MP4/MOV）：第 4~7 字节固定 'ftyp'
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') {
    // 品牌白名单：排除 HEIF/AVIF 这类同结构但不是视频的图片容器
    const brand = buf.toString('ascii', 8, 12);
    if (/^(heic|heix|mif1|msf1|avif|avis)$/i.test(brand)) return null;
    return { ext: 'mp4', mime: 'video/mp4', brand };
  }
  // EBML（WebM/Matroska）
  if (buf.readUInt32BE(0) === 0x1a45dfa3) {
    const head = buf.subarray(0, Math.min(buf.length, 512)).toString('latin1');
    // 只认 WebM：Chromium 不解码 Matroska 容器里的 H.264，mkv 上传后会一片黑。
    if (head.includes('webm')) return { ext: 'webm', mime: 'video/webm', brand: 'webm' };
    return null;
  }
  return null;
}

/**
 * 定位主题的视频文件。theme.json 里的 video 字段是相对文件名（background.mp4），
 * 但扁平布局（themes/<id>.json）下也可能写成相对 THEMES_DIR 的路径，两种都试。
 * 不做「按扩展名猜 background.*」的兜底：那会让一个写错的文件名静默命中另一段视频。
 */
function resolveVideoFile(themesDir, themeId, videoName) {
  const safeId = String(themeId || '').replace(/[^A-Za-z0-9_-]/g, '_');
  const raw = String(videoName || '').replace(/^\.\.?[/\\]/, '');
  if (!safeId || !raw) return null;
  const root = path.resolve(themesDir);
  const candidates = [path.join(root, safeId, raw), path.join(root, raw)];
  const isInside = (base, target) => target === base || target.startsWith(base + path.sep);
  for (const c of candidates) {
    try {
      const resolved = path.resolve(c);
      if (!isInside(root, resolved) || !fs.statSync(resolved).isFile()) continue;
      // Reject symlinks that point outside the themes directory as well as lexical traversal.
      if (!isInside(fs.realpathSync(root), fs.realpathSync(resolved))) continue;
      return resolved;
    } catch (_) {}
  }
  return null;
}

/** 视频壁纸只替换 #root 的背景层：蒙版/渐变/darken 与图片模式保持完全一致。 */
function videoRootBackground(mask) {
  const m = Math.min(1, Math.max(0, Number.isFinite(mask) ? mask : 0.3));
  return '#root{background:' + [
    'linear-gradient(rgba(0,0,0,' + m + '),rgba(0,0,0,' + m + '))',
    'linear-gradient(90deg,color-mix(in srgb,var(--wb-bg-primary) 40%,transparent) 0 18%,transparent 42%)',
    'linear-gradient(180deg,transparent 0 58%,color-mix(in srgb,var(--wb-bg-primary) 50%,transparent) 100%)',
  ].join(',') + ' !important;}';
}

// 视频层的定位：不能压在 z-index:-1 —— WorkBuddy 的 body 有不透明底色
// （--vscode-editor-background），按 CSS 绘制顺序它画在负层级之上，视频会被整块盖住，
// 表现出来就是「上传成功但界面一片黑」。所以视频停在第 0 层，由 #root 提到第 1 层，
// 蒙版和渐变仍随 #root 的背景压在视频上方。
const VIDEO_LAYER_CSS = [
  '#wbs-video-wallpaper{position:fixed;inset:0;z-index:0;overflow:hidden;pointer-events:none;background:transparent;opacity:0;transition:opacity .45s ease}',
  '#wbs-video-wallpaper.wbs-video-ready{opacity:1}',
  '#wbs-video-wallpaper video{width:100%;height:100%;object-fit:cover;display:block;pointer-events:none;background:transparent}',
  '#wbs-video-wallpaper video::-webkit-media-controls,#wbs-video-wallpaper video::-webkit-media-controls-enclosure,#wbs-video-wallpaper video::-webkit-media-controls-panel{display:none!important}',
  '#root{position:relative;z-index:1}',
].join('');

const VIDEO_HOST_ID = 'wbs-video-wallpaper';
// 视频层使用自己的 <style>，不跟着 #wbs-theme-style 一起被重写：
// 主题重应用（拖蒙版、改毛玻璃、nebula 的官方深色预置）不会把视频层的定位规则清掉，
// 也就不会出现"视频层突然变成 body 里的普通 div 把界面顶下去"的一帧。
const VIDEO_STYLE_ID = 'wbs-video-style';

/**
 * 在渲染进程里安装/更新视频壁纸层。
 * 这段函数体是被 toString() 序列化后注入页面的，不能引用模块作用域的任何变量。
 *
 * key 用来判断「是不是同一个视频」：蒙版/毛玻璃拖动会反复重应用主题，命中 key
 * 时直接复用已加载的 blob，不会把几十 MB 的视频重新拉一遍。
 */
async function updateVideoInRenderer(options) {
  var opts = options || {};
  var key = String(opts.key || '');
  if (!key) return false;

  function ensureStyle() {
    var style = document.getElementById('wbs-video-style');
    var css = String(opts.css || '');
    if (!style) {
      style = document.createElement('style');
      style.id = 'wbs-video-style';
      (document.head || document.documentElement).appendChild(style);
    }
    if (style.textContent !== css) style.textContent = css;
    return style;
  }

  var runtime = window.__wbsVideoRuntime;
  if (runtime && runtime.key === key && runtime.ready && runtime.host && runtime.host.isConnected) {
    ensureStyle();
    runtime.play();
    return true;
  }
  if (runtime && runtime.dispose) runtime.dispose();
  ensureStyle();

  var host = document.getElementById('wbs-video-wallpaper');
  if (!host) {
    host = document.createElement('div');
    host.id = 'wbs-video-wallpaper';
    host.setAttribute('aria-hidden', 'true');
  }
  // 必须是 body 的第一个子节点，且不能参与布局：fixed 已脱离文档流。
  var parent = document.body || document.documentElement;
  if (host.parentNode !== parent) parent.insertBefore(host, parent.firstChild);
  host.classList.remove('wbs-video-ready');
  var video = host.querySelector('video');
  if (!video) {
    video = document.createElement('video');
    video.muted = true;
    video.defaultMuted = true;
    video.loop = true;
    video.autoplay = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.setAttribute('muted', '');
    video.setAttribute('loop', '');
    video.setAttribute('autoplay', '');
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.setAttribute('disablepictureinpicture', '');
    video.setAttribute('disableremoteplayback', '');
    host.appendChild(video);
  }
  video.muted = true;

  var controller = new AbortController();
  var objectUrl = '';
  var onVisibility = null;
  var onGesture = null;
  var disposed = false;
  var rt = {
    key: key,
    host: host,
    video: video,
    ready: false,
    play: function () {
      if (document.hidden) return;
      try { var p = video.play(); if (p && p.catch) p.catch(function () {}); } catch (_) {}
      if (video.readyState >= 2) host.classList.add('wbs-video-ready');
    },
    dispose: function () {
      disposed = true;
      try { controller.abort(); } catch (_) {}
      if (onVisibility) { document.removeEventListener('visibilitychange', onVisibility); onVisibility = null; }
      if (onGesture) { document.removeEventListener('pointerdown', onGesture, true); onGesture = null; }
      try { video.pause(); } catch (_) {}
      try { video.removeAttribute('src'); video.load(); } catch (_) {}
      if (objectUrl) { try { URL.revokeObjectURL(objectUrl); } catch (_) {} objectUrl = ''; }
      if (host.parentNode) host.parentNode.removeChild(host);
      var style = document.getElementById('wbs-video-style');
      if (style && style.parentNode) style.parentNode.removeChild(style);
      if (window.__wbsVideoRuntime === rt) { try { delete window.__wbsVideoRuntime; } catch (_) {} }
    },
  };
  window.__wbsVideoRuntime = rt;

  // 窗口切到后台时暂停解码：视频壁纸持续播放会明显吃 GPU/电量。
  onVisibility = function () {
    if (disposed) return;
    if (document.hidden) { try { video.pause(); } catch (_) {} }
    else rt.play();
  };
  document.addEventListener('visibilitychange', onVisibility);

  var loaded = new Promise(function (resolve, reject) {
    var timer = setTimeout(function () { reject(new Error('视频加载超时')); }, 20000);
    video.addEventListener('loadeddata', function () {
      clearTimeout(timer);
      rt.ready = true;
      if (!disposed && window.__wbsVideoRuntime === rt) host.classList.add('wbs-video-ready');
      resolve(true);
    }, { once: true });
    video.addEventListener('error', function () {
      clearTimeout(timer);
      reject(new Error('视频无法解码'));
    }, { once: true });
    controller.signal.addEventListener('abort', function () {
      clearTimeout(timer);
      reject(new Error('已取消'));
    }, { once: true });
  });
  loaded.then(function () { rt.play(); }).catch(function () {});

  try {
    var response = await fetch(opts.url, {
      headers: { 'X-WorkDaddy-Token': opts.token, 'Cache-Control': 'no-store' },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error('wallpaper video unavailable');
    var blob = await response.blob();
    if (disposed || window.__wbsVideoRuntime !== rt) return false;
    objectUrl = URL.createObjectURL(blob);
    video.src = objectUrl;
    // 自动播放被策略拦下时，等用户第一次点击再补播（静音视频通常不需要）。
    onGesture = function () {
      if (disposed) return;
      rt.play();
      if (video.readyState >= 2) {
        document.removeEventListener('pointerdown', onGesture, true);
        onGesture = null;
      }
    };
    document.addEventListener('pointerdown', onGesture, true);
    try { video.load(); } catch (_) {}
    return await loaded.then(function () { return true; }).catch(function () {
      if (window.__wbsVideoRuntime === rt) rt.dispose();
      return false;
    });
  } catch (_) {
    if (window.__wbsVideoRuntime === rt) rt.dispose();
    return false;
  }
}

/** 摘掉视频层（切回图片壁纸 / 关闭接管 / 换成不支持视频的主题时）。 */
function disposeVideoInRenderer() {
  var runtime = window.__wbsVideoRuntime;
  if (runtime && runtime.dispose) runtime.dispose();
  var stale = document.getElementById('wbs-video-wallpaper');
  if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
  var style = document.getElementById('wbs-video-style');
  if (style && style.parentNode) style.parentNode.removeChild(style);
  return true;
}

module.exports = {
  VIDEO_MAX_BYTES,
  VIDEO_HEAD_BYTES,
  VIDEO_HOST_ID,
  VIDEO_STYLE_ID,
  VIDEO_LAYER_CSS,
  sniffVideo,
  resolveVideoFile,
  videoRootBackground,
  updateVideoInRenderer,
  disposeVideoInRenderer,
};
