/**
 * 右下角悬浮组件（注入到 WorkBuddy 渲染进程，由 daemon.js 通过 CDP 注入执行）
 *
 * 功能：
 *  1. 右下角圆形黑色悬浮按钮（hover 展开为胶囊显示"WorkDaddy"）
 *  2. 点击按钮弹出账号面板（白色主题）：面板右下角与按钮右下角重叠；面板打开时按钮隐藏，关闭后恢复
 *  3. 账号列表展示 昵称 / 手机（明文） / Token 过期时间（<7 天红字）；不展示 uid/uin/上次登录
 *  4. 每账号右侧为「切换」「删除」纯图标按钮（当前登录账号隐藏这两个按钮）；「删除」红色、二次确认永久删除
 *  5. 面板底部「退出登录」（假退出：仅退回登录页，token 不过期，可随时切回）
 *  6. 每日签到改为打开面板即自动调接口（见 daemon 的 claimDailyForAll），带每日缓存，无需按钮
 *  6. 备份由守护进程自动完成，面板不提供备份按钮
 *
 * 与后端通信：fetch 本地 daemon（__WBS_API__ 占位符在注入时替换为实际地址）
 * 幂等：window.__wbsWidget 防重复注入；document.body 未就绪时等待 DOMContentLoaded。
 */
function createBuildLifecycle() {
  var active = true;
  var disposers = [];

  function registerDisposer(fn) {
    if (typeof fn !== 'function') return fn;
    if (!active) {
      try { fn(); } catch (e) {}
      return fn;
    }
    disposers.push(fn);
    return fn;
  }

  function destroy() {
    if (!active) return;
    active = false;
    var pending = disposers;
    disposers = [];
    for (var i = 0; i < pending.length; i++) {
      try { pending[i](); } catch (e) {}
    }
  }

  return {
    registerDisposer: registerDisposer,
    destroy: destroy,
    alive: function () { return active; },
  };
}

// Keep the decision logic independent from DOM selectors so it can be regression-tested.
// `suspected` is intentionally conservative: it asks for human review instead of sending
// another prompt automatically when a provider stops without an explicit error.
function classifySessionHealth(snapshot) {
  var s = snapshot || {};
  if (s.blocked) return { status: 'blocked', confidence: 'high', reason: 'decision-prompt' };
  if (s.error || s.networkFailure) return { status: 'error', confidence: 'high', reason: s.networkFailure ? 'network-failure' : 'error-ui' };
  if (!s.observed) return { status: 'idle', confidence: 'none', reason: 'not-observed' };
  if (s.busy) return { status: 'running', confidence: 'high', reason: 'generation-active' };
  if (s.manualStop) return { status: 'stopped', confidence: 'high', reason: 'manual-stop' };
  if (Number(s.idleForMs || 0) < 2500) return { status: 'settling', confidence: 'low', reason: 'settling' };
  if (s.completionMarker) return { status: 'completed', confidence: 'high', reason: 'completion-marker' };
  if (s.hasAssistant && s.assistantChanged !== false && s.hasCompletionActions && Number(s.assistantTextLength || 0) > 0) {
    return { status: 'completed', confidence: 'medium', reason: 'assistant-actions' };
  }
  if ((!s.hasAssistant || Number(s.assistantTextLength || 0) === 0) && Number(s.idleForMs || 0) >= 8000) {
    return { status: 'suspected', confidence: 'medium', reason: 'empty-assistant' };
  }
  if (s.looksTruncated || Number(s.idleForMs || 0) >= 8000) {
    return { status: 'suspected', confidence: 'low', reason: s.looksTruncated ? 'truncated-assistant' : 'idle-without-completion' };
  }
  return { status: 'settling', confidence: 'low', reason: 'no-completion-evidence' };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createBuildLifecycle: createBuildLifecycle, classifySessionHealth: classifySessionHealth };
}
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
(function () {
  // 兜底清理：移除任何历史版本注入的残留节点，并清除旧守卫。
  // 关键：必须在守卫判断之前执行，否则旧注册的 window.__wbsWidget 会拦截新代码，
  // 导致“改了文件、重启守护、Command+R 仍跑旧逻辑 / 旧按钮残留”。
  (function () {
    var n;
    if ((n = document.querySelector('.wbs-root'))) n.remove();
    var st = document.querySelectorAll('.wbs-stash-inline, .wbs-stash-btn');
    for (var i = 0; i < st.length; i++) st[i].remove();
    var ss = document.querySelectorAll('#wbs-style');
    for (var j = 0; j < ss.length; j++) ss[j].remove();
    var dbg = document.querySelectorAll('#wbs-diag-badge, #wbs-debug-panel');
    for (var k = 0; k < dbg.length; k++) dbg[k].remove();
    // 销毁所有历史 build：置 alive=false、断开全部 observer/事件监听。
    // 关键：旧 build 的 observer 若不销毁，DOM 一变就会把旧的 stashBtn 重新设为可见（用户"始终看到按钮"的根因）。
    var builds = window.__wbsBuilds || [];
    for (var b = 0; b < builds.length; b++) {
      try { if (builds[b] && typeof builds[b].destroy === 'function') builds[b].destroy(); } catch (e) {}
    }
    window.__wbsBuilds = [];
    try { delete window.__wbsWidget; } catch (e) { window.__wbsWidget = null; }
    try { delete window.__wbsDiag; } catch (e) { window.__wbsDiag = null; }
    try { delete window.__wbsThemeAudit; } catch (e) { window.__wbsThemeAudit = null; }
  })();
  // ===== 顶部红色角标已移除（用户要求）；仅保留 console 标记 =====
  try { console.log('[WBS] inject.js 已执行于', location.href, 'body=', !!document.body); } catch (_) {}
  if (window.__wbsWidget) return; // 理论上 cleanup 已清除，保留为兜底
  var API = '__WBS_API__';
  var PROFILE_ID = '__WBS_PROFILE__';
  var CAPS = __WBS_CAPS__;
  var WBS_API_TOKEN = '__WBS_API_TOKEN__';
  // 面板品牌名跟随 profile：workbuddy-ai 显示 WorkDaddy AI，其余显示 WorkDaddy
  var WBS_BRAND = PROFILE_ID === 'workbuddy-ai' ? 'WorkDaddy AI' : 'WorkDaddy';

  // ===== 全局错误钩子：捕获渲染进程不可捕获的 error / unhandledrejection，把完整消息+栈
  // 打到 daemon 日志。渲染进程级崩溃（如 An object could not be cloned）虽非 try/catch 能拦，
  // 但很多是经 promise/microtask 抛出的可拦异常——这里统一兜住并留痕。
  if (!window.__wbsErrHook) {
    window.__wbsErrHook = true;
    function wbsReportErr(kind, ev) {
      var msg = '', stack = '';
      try {
        var e = ev && ev.error !== undefined ? ev.error : (ev && ev.reason);
        if (e instanceof Error) { msg = e && e.message; stack = e && e.stack; }
        else if (e && e.message) { msg = e.message; stack = e.stack; }
        else { msg = String(e); }
      } catch (_) {}
      var line = '[wbscrash] ' + kind + ': ' + msg + (stack ? '\n' + stack : '');
      try { console.error(line); } catch (_) {}
      try {
        fetch(API + '/api/breadcrumb', { method: 'POST', headers: { 'content-type': 'application/json', 'X-WorkDaddy-Token': WBS_API_TOKEN }, body: JSON.stringify({ msg: 'crash:' + kind + ':' + msg, extra: { stack: (stack || '').slice(0, 1500) } }) }).catch(function () {});
      } catch (_) {}
    }
    window.addEventListener('error', function (ev) { wbsReportErr('error', ev); });
    window.addEventListener('unhandledrejection', function (ev) { wbsReportErr('unhandledrejection', ev); });
  }

  var state = { accounts: [], current: null, open: false, batchRunning: false, creditRunId: 0, creditRemaining: 0, creditSummaryValue: null, checkinPollId: null };
  var currentBuild = null;
  // 当前注入的 daemon 版本号（由 daemon.js 注入时把 __WBS_VERSION__ 替换为 DAEMON_VERSION）
  // 「关于」tab 直接展示，升级 daemon 后这里自动同步
  var WBS_VERSION = '__WBS_VERSION__';

  // 纯图标 SVG（stroke 跟随按钮 currentColor）
  var SWITCH_SVG =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M16 3l4 4-4 4"/><path d="M20 7H8"/><path d="M8 21l-4-4 4-4"/><path d="M4 17h12"/></svg>';
  var AUTO_COPY_SVG =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M4 16V6a2 2 0 0 1 2-2h10"/><path d="M15 3l3 1-1 3"/></svg>';
  var TRASH_SVG =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/>' +
    '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>' +
    '<path d="M10 11v6"/><path d="M14 11v6"/></svg>';
  var MODEL_BACKUP_SVG =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>';
  var MODEL_TEST_SVG =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 11 14 10 22 21 10 13 10 13 2"/></svg>';
  var MODEL_COPY_SVG =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M4 16V6a2 2 0 0 1 2-2h10"/></svg>';
  var MODEL_EDIT_SVG =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m4 16-.8 4.8L8 20l11.5-11.5a2.1 2.1 0 0 0-3-3L5 17z"/><path d="m14.5 7.5 2 2"/></svg>';
  var MODEL_ENABLE_SVG =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M8 5.2a1 1 0 0 1 1.55-.83l9.6 6.8a1 1 0 0 1 0 1.66l-9.6 6.8A1 1 0 0 1 8 18.8V5.2Z"/></svg>';
  // 小贴士提示图标（灯泡，tips 通知风格）
  var MODEL_TIP_SVG =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.4 1 2.3h6c0-.9.4-1.8 1-2.3A7 7 0 0 0 12 2Z"/></svg>';
  var GIFT_SVG =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="3" y="8" width="18" height="4" rx="1"/>' +
    '<path d="M12 8v13"/><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/>' +
    '<path d="M7.5 8a2.5 2.5 0 0 1 0-5 2.5 2.5 0 0 1 2.5 2.5V8"/>' +
    '<path d="M16.5 8v-2.5a2.5 2.5 0 0 1 5 0 2.5 2.5 0 0 1-2.5 2.5H16.5"/></svg>';
  var LOGOUT_SVG =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>' +
    '<polyline points="16 17 21 12 16 7"/>' +
    '<line x1="21" y1="12" x2="9" y2="12"/></svg>';
  // 积分余额图标：AI 四芒星线条矢量（无背景色，currentColor 跟随文字色）
  var CREDIT_ICON =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>' +
    '<path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>' +
    '</svg>';
  // 导出账号：上箭头入托盘
  var EXPORT_ICON =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
    '<polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';
  // 导入账号：下箭头出托盘
  var IMPORT_ICON =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
    '<polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
  // 账号同步：双向循环箭头（sync 图标）
  var SYNC_SVG =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M21 12a9 9 0 0 1-15.5 6.2"/>' +
    '<path d="M3 12a9 9 0 0 1 15.5-6.2"/>' +
    '<polyline points="18.5 1.5 18.5 5.8 14.2 5.8"/>' +
    '<polyline points="5.5 22.5 5.5 18.2 9.8 18.2"/></svg>';

  // 暂存提示词按钮图标：纯色「标签」图标（实心填充风，非线条）；fill 用 currentColor 跟随按钮文字色（主题适配）
  var STASH_SVG =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M21.41 11.58l-9-9C12.05 2.22 11.55 2 11 2H4a2 2 0 0 0-2 2v7c0 .55.22 1.05.59 1.42l9 9c.36.36.86.58 1.41.58.55 0 1.05-.22 1.41-.59l7-7c.37-.36.59-.86.59-1.41 0-.55-.22-1.06-.59-1.42zM5.5 7C4.67 7 4 6.33 4 5.5S4.67 4 5.5 4 7 4.67 7 5.5 6.33 7 5.5 7z"/>' +
    '<circle cx="5.5" cy="5.5" r="1.5" fill="currentColor"/>' +
    '</svg>';

  // 今日签到状态展示：账号卡片底部与积分余额并列显示
  function isIdentityExpired(a) {
    if (!a) return false;
    var checkin = a.checkin || {};
    var code = String(checkin.code == null ? '' : checkin.code);
    var message = String(checkin.message || '');
    if (code === '401' || /401|Unauthorized|未授权|登录身份过期/.test(message)) return true;
    if (a.tokenExpiresAt !== undefined && a.tokenExpiresAt !== null && a.tokenExpiresAt !== '') {
      var expiry = Number(a.tokenExpiresAt);
      if (!isFinite(expiry)) expiry = Date.parse(String(a.tokenExpiresAt));
      if (isFinite(expiry) && expiry <= Date.now()) return true;
    }
    return false;
  }

  function checkinHtml(a) {
    // 国际版不开放签到活动：积分卡上的签到标签整体不展示（CN 版保留完整逻辑）
    if (PROFILE_ID === 'workbuddy-ai') return '';
    var c = a && a.checkin;
    if (!c) return '<span class="wbs-ck wbs-checkin-tag pending">签到中</span>';
    var msg = c.message || '';
    // 国际版/活动空窗期：接口 code 10001 且文案表明「活动未开启/未开始/已过期」时，
    // 并不是“今日已签到”，不应展示绿色成功标签，改为中性「无签到活动」。
    if (c.ok && /未开启|未开始|未开放|已过期|无.*活动|活动.*(结束|关闭|暂停)/i.test(msg)) {
      return '<span class="wbs-ck wbs-checkin-tag pending">无签到活动</span>';
    }
    // “本轮刚领取”和“今天已领取过”都是成功态，统一展示避免同一页面出现两套文案。
    if (c.ok) return '<span class="wbs-ck wbs-checkin-tag ok">今日已签到✓</span>';
    // 认证类错误（401/未授权）统一显示友好文案（daemon 已产出，缓存残留旧文案时兜底）
    if (/401|Unauthorized|未授权|登录身份过期/.test(msg)) msg = '登录身份过期';
    return '<span class="wbs-ck wbs-checkin-tag fail">' + msg + '</span>';
  }

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html !== undefined) n.innerHTML = html;
    return n;
  }

  function maskPhone(p) {
    if (!p) return '';
    if (p.length >= 7) return p.slice(0, 3) + '****' + p.slice(-4);
    return p.slice(0, 1) + '****';
  }

  function fmtTime(ts) {
    if (!ts) return '';
    var d = Date.now() - ts;
    if (d < 60e3) return '刚刚';
    if (d < 3600e3) return Math.floor(d / 60e3) + ' 分钟前';
    if (d < 86400e3) return Math.floor(d / 3600e3) + ' 小时前';
    var dt = new Date(ts);
    return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
  }

  function initial(name) {
    if (!name) return '?';
    var s = String(name).trim();
    return s ? Array.from(s)[0].toUpperCase() : '?';
  }

  function api(path, opts) {
    opts = opts || {};
    var request = {};
    Object.keys(opts).forEach(function (key) { request[key] = opts[key]; });
    var headers = {};
    if (opts.headers) {
      Object.keys(opts.headers).forEach(function (key) { headers[key] = opts.headers[key]; });
    }
    headers['X-WorkDaddy-Token'] = WBS_API_TOKEN;
    request.headers = headers;
    return fetch(API + path, request).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok || j.ok === false) {
          var error = new Error(j.error || '请求失败');
          error.payload = j;
          throw error;
        }
        return j;
      });
    });
  }

  // 调试：递归收集所有元素（含 shadowRoot 与同域 iframe），用于抓取输入框内容
  function collectAll(root) {
    var out = [];
    (function walk(node) {
      if (!node || !node.tagName) return;
      out.push(node);
      if (node.shadowRoot) {
        var srKids = node.shadowRoot.querySelectorAll ? node.shadowRoot.querySelectorAll('*') : [];
        for (var i = 0; i < srKids.length; i++) walk(srKids[i]);
      }
      var ch = node.children;
      if (ch) for (var j = 0; j < ch.length; j++) if (ch[j].nodeType === 1) walk(ch[j]);
    })(root);
    return out;
  }
  function allElements() {
    var set = collectAll(document.documentElement);
    try {
      var frames = document.querySelectorAll('iframe');
      for (var i = 0; i < frames.length; i++) {
        try {
          if (frames[i].contentDocument) set = set.concat(collectAll(frames[i].contentDocument.documentElement));
        } catch (e) {}
      }
    } catch (e) {}
    return set;
  }
  // 调试：抓取 WorkBuddy 输入框当前内容（文字/图片/附件/连接器/skill）
  function captureComposer() {
    var els = allElements();
    var editable = [], images = [], attachments = [];
    for (var i = 0; i < els.length; i++) {
      var e = els[i];
      if (!e.tagName) continue;
      var tag = e.tagName;
      var isCE = e.getAttribute && e.getAttribute('contenteditable') === 'true';
      if (tag === 'TEXTAREA' || tag === 'INPUT' || isCE) {
        var txt = (e.innerText || e.textContent || e.value || '').toString();
        editable.push({
          tag: tag,
          isContentEditable: !!isCE,
          text: txt.slice(0, 20000),
          value: (e.value || '').toString().slice(0, 20000),
          html: (e.innerHTML || '').toString().slice(0, 200000),
          placeholder: (e.getAttribute ? (e.getAttribute('placeholder') || '') : ''),
        });
      }
      if (tag === 'IMG') {
        images.push({
          src: (e.src || '').slice(0, 500),
          alt: e.alt || '',
          w: e.naturalWidth || e.width || 0,
          h: e.naturalHeight || e.height || 0,
        });
      }
      var cls = (e.className && e.className.toString()) || '';
      var t = (e.textContent || '').toString().trim();
      if (cls && /attach|chip|file|connector|skill|mention|tag|badge|token|pill/i.test(cls) && t && t.length < 200) {
        var ds = {};
        if (e.dataset) for (var k in e.dataset) ds[k] = e.dataset[k];
        attachments.push({ tag: tag, cls: cls.slice(0, 200), text: t.slice(0, 200), dataset: ds });
      }
    }
    editable.sort(function (a, b) { return (b.text.length + b.value.length) - (a.text.length + a.value.length); });
    return {
      capturedAt: new Date().toISOString(),
      url: location.href,
      title: document.title,
      editableCount: editable.length,
      editable: editable.slice(0, 10),
      imageCount: images.length,
      images: images.slice(0, 50),
      attachmentCount: attachments.length,
      attachments: attachments.slice(0, 100),
    };
  }

  // 定位 WorkBuddy 的 Slate 输入框（composer）
  // 关键修正：WorkBuddy 渲染的消息历史区也是 [data-slate-editor="true"]，
  // 旧实现 document.querySelector('[data-slate-editor="true"]') 会**错把消息历史当成输入框**，
  // 导致 composerHasContent 永远 true（消息历史永远有内容）。修正后：优先在操作栏祖先链内找
  // 可编辑节点；否则取所有 contenteditable 中 y 距 voice-mic-wrap 最近且在其上方的节点（输入框紧贴操作栏上方）。
  function findComposer() {
    var mic = document.querySelector('.voice-mic-wrap');
    if (!mic) {
      // AI 端（无 voice-mic-wrap）：输入框特征是 [contenteditable=true]，且位于视口下半部、
      // 可见、有尺寸（消息历史是只读渲染，不是 contenteditable=true）。取最靠底部的那个。
      var all = document.querySelectorAll('[contenteditable="true"]');
      var best = null, bestCy = -Infinity;
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (!el.getBoundingClientRect) continue;
        var r = el.getBoundingClientRect();
        if (r.height <= 0 || r.width <= 0) continue;
        var cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        var cy = r.top + r.height / 2;
        if (cy > window.innerHeight * 0.45 && cy > bestCy) { bestCy = cy; best = el; }
      }
      return best || (all.length ? all[0] : null);
    }
    // 1) 在 voice-mic-wrap 祖先链（最多 6 层）内找可编辑节点
    var p = mic.parentElement;
    for (var up = 0; up < 6 && p; up++) {
      try {
        var ed = p.querySelector('[contenteditable="true"]') || p.querySelector('[data-slate-editor="true"]');
        if (ed) return ed;
      } catch (_) {}
      p = p.parentElement;
    }
    // 2) 兜底：所有 contenteditable 中最靠近 voice-mic-wrap 且在其上方的
    var all = document.querySelectorAll('[contenteditable="true"]');
    var mr = mic.getBoundingClientRect();
    var best = null, bestDist = Infinity;
    for (var i = 0; i < all.length; i++) {
      var r = all[i].getBoundingClientRect();
      if (r.height > 0 && r.bottom > 0 && r.bottom <= mr.top + 40) {
        var d = mr.top - r.bottom;
        if (d >= 0 && d < bestDist) { bestDist = d; best = all[i]; }
      }
    }
    if (best) return best;
    // 3) 极兜底：第一个 contenteditable（不再用 data-slate-editor 兜底，避免命中消息历史）
    return all.length ? all[0] : null;
  }
  // 输入框是否有内容（文字或任意 contentblock 节点：图片/文件/技能）
  // 关键：Slate 空输入框时渲染 [data-slate-placeholder="true"] 占位节点（如"今天帮你做些什么？"），
  // innerText 会包含占位文字 → 误判有内容 → 按钮空输入框也显示。用 TreeWalker 遍历真实文本节点，
  // 跳过 placeholder 子树。
  function composerHasContent(editor) {
    if (!editor) return false;
    try {
      var textLen = 0;
      var walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, null);
      var n;
      while ((n = walker.nextNode())) {
        var p = n.parentElement;
        if (p && p.hasAttribute && p.hasAttribute('data-slate-placeholder')) continue; // 跳过占位文字
        textLen += (n.nodeValue || '').replace(/[\uFEFF\u200B\u00A0]/g, '').replace(/\s+/g, '').length;
      }
      if (textLen > 0) return true;
    } catch (_) {
      var t = (editor.innerText || editor.textContent || '').toString().replace(/[\uFEFF\u200B\u00A0]/g, '').replace(/\s+/g, '');
      if (t.length > 0) return true;
    }
    if (editor.querySelector && editor.querySelector('[data-contentblock]')) return true;
    return false;
  }
  // 干净地抓取输入框内容：只取 Slate 节点（不受页面装饰干扰）
  function getComposerContent() {
    var editor = findComposer();
    if (!editor) return null;
    var text = (editor.innerText || editor.textContent || '').toString();
    var items = [];
    var blocks = editor.querySelectorAll ? editor.querySelectorAll('[data-contentblock]') : [];
    for (var i = 0; i < blocks.length; i++) {
      try {
        var raw = blocks[i].getAttribute('data-contentblock') || '';
        var j = JSON.parse(raw.indexOf('&quot;') >= 0 ? raw.replace(/&quot;/g, '"') : raw);
        var item = {
          type: j.type,
          name: j.name || (j.uri || '').toString().split('/').pop() || '',
          uri: j.uri || '',
          _meta: j._meta || null,
        };
        if (j.type === 'image' && typeof j.data === 'string' && j.data.indexOf('iVBOR') === 0) {
          item.imageBase64 = j.data; // 完整 PNG 字节，可直接还原
        }
        items.push(item);
      } catch (e) {}
    }
    return {
      text: text,
      textLen: text.replace(/[\uFEFF\u200B]/g, '').trim().length,
      items: items,
      capturedAt: new Date().toISOString(),
    };
  }
  // 尽量拿到当前会话 id（URL / 侧边栏激活项 / 标题兜底）
  function getConversationId() {
    try {
      var u = new URL(location.href);
      var q = u.searchParams.get('conversationId') || u.searchParams.get('conversation_id');
      if (q) return q;
    } catch (_) {}
    var sel = document.querySelector('[data-conversation-id].active,[data-conversation-id][aria-selected="true"],.conversation-item.active,[data-conversation-id][class*="active"],.conv-item.active,[class*="conversation"][class*="active"]');
    if (sel) {
      var id = sel.getAttribute('data-conversation-id') || sel.getAttribute('data-id');
      if (id) return id;
    }
    var any = document.querySelector('[data-conversation-id]');
    if (any) return any.getAttribute('data-conversation-id');
    var titleEl = document.querySelector('[class*="chat-title"],[class*="conversation-title"],[class*="ChatTitle"],[class*="chatTitle"]');
    if (titleEl && titleEl.textContent) return 'title:' + titleEl.textContent.trim().slice(0, 40);
    return 'unknown';
  }

  function build() {
    var lifecycle = createBuildLifecycle();
    var registerDisposer = lifecycle.registerDisposer;
    var alive = true;
    var buildTimeouts = [];
    var buildIntervals = [];
    var buildFrames = [];
    var fabPosTimer = null;
    var sleepSyncTimer = null;
    var avatarTimer = null;
    var debugTimer = null;
    var sessionHealthTimer = null;
    var sessionHealth = {
      sessionId: null,
      observed: false,
      generationAt: 0,
      lastBusyAt: 0,
      baselineAssistantNode: null,
      baselineAssistantTextLength: 0,
      lastStatus: 'idle',
      result: { status: 'idle', confidence: 'none', reason: 'not-observed' },
    };

    function removeTimer(list, id) {
      var index = list.indexOf(id);
      if (index >= 0) list.splice(index, 1);
    }
    function setBuildTimeout(fn, delay) {
      var id = setTimeout(function () {
        removeTimer(buildTimeouts, id);
        if (alive) fn();
      }, delay);
      buildTimeouts.push(id);
      return id;
    }
    function setBuildInterval(fn, delay) {
      var id = setInterval(function () {
        if (alive) fn();
      }, delay);
      buildIntervals.push(id);
      return id;
    }
    function requestBuildFrame(fn) {
      var request = window.requestAnimationFrame || function (callback) { return setTimeout(callback, 40); };
      var id = request(function () {
        removeTimer(buildFrames, id);
        if (alive) fn();
      });
      buildFrames.push(id);
      return id;
    }
    function listen(target, type, handler, options) {
      target.addEventListener(type, handler, options);
      registerDisposer(function () { target.removeEventListener(type, handler, options); });
    }
    function toast(msg, isErr, targetRoot) {
      if (!alive) return;
      var t = el('div', 'wbs-toast' + (isErr ? ' err' : ''), msg);
      (targetRoot || document.body).appendChild(t);
      setBuildTimeout(function () {
        t.classList.add('out');
        setBuildTimeout(function () { t.remove(); }, 300);
      }, 4200);
    }

    function isVisibleHealthNode(node) {
      if (!node || !node.isConnected || (node.closest && node.closest('.wbs-root'))) return false;
      var r = node.getBoundingClientRect && node.getBoundingClientRect();
      if (!r || r.width <= 0 || r.height <= 0) return false;
      var cs = getComputedStyle(node);
      return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
    }

    function findBlockingPrompt() {
      var selectors = [
        '[role="dialog"]', '[class*="_dialog_"]', '[class*="_modal_"]', '[class*="_permission_"]',
        '[class*="_confirm_"]', '[class*="_decision_"]', '[class*="_approval_"]', '[class*="_question_"]', '[class*="_ask_"]',
        '[class*="permission-dialog"]', '[class*="confirm-dialog"]', '[class*="decision-dialog"]',
      ];
      var nodes = [];
      for (var i = 0; i < selectors.length; i++) {
        var found = document.querySelectorAll(selectors[i]);
        for (var j = 0; j < found.length; j++) if (nodes.indexOf(found[j]) < 0) nodes.push(found[j]);
      }
      for (var k = nodes.length - 1; k >= 0; k--) {
        var node = nodes[k];
        if (!isVisibleHealthNode(node)) continue;
        var text = String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text || text.length > 1800) continue;
        var buttons = Array.prototype.map.call(node.querySelectorAll('button,[role="button"]'), function (b) {
          return String(b.innerText || b.getAttribute('aria-label') || b.getAttribute('title') || '').trim();
        }).join(' ');
        var asks = /(确认|允许|授权|批准|执行|需要.*选择|是否继续|allow|approve|confirm|permission|continue)/i.test(text);
        var actions = /(允许|确认|批准|拒绝|取消|继续|是|否|allow|approve|deny|cancel|continue)/i.test(buttons);
        if (asks && actions) return { node: node, text: text.slice(0, 160) };
      }
      return null;
    }

    function findSessionError() {
      var selectors = [
        '[role="alert"]', '[class*="errorBanner"]', '[class*="_errorBanner_"]', '[class*="_retryBtn_"]', '[class*="_error_"]', '[class*="_failed_"]',
        '[class*="error-message"]', '[class*="errorMessage"]',
      ];
      var nodes = [];
      for (var i = 0; i < selectors.length; i++) {
        var found = document.querySelectorAll(selectors[i]);
        for (var j = 0; j < found.length; j++) if (nodes.indexOf(found[j]) < 0) nodes.push(found[j]);
      }
      for (var k = nodes.length - 1; k >= 0; k--) {
        var node = nodes[k];
        if (!isVisibleHealthNode(node)) continue;
        var text = String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text || !/(错误|失败|重试|超时|限流|429|5\d\d|error|failed|retry|timeout|rate limit)/i.test(text)) continue;
        return { node: node, text: text.slice(0, 160) };
      }
      return null;
    }

    function readAssistantHealth() {
      var selectors = [
        '[data-message-role="assistant"]', '[data-role="assistant"]', '[class*="assistantMessage"]',
        '[class*="_assistantMessage_"]', '[class*="assistant-message"]', '[class*="_assistant_"] .cb-markdown',
        '.cb-markdown[data-md-theme="answer"]', '.cb-markdown',
      ];
      var nodes = [];
      for (var i = 0; i < selectors.length; i++) {
        var found = document.querySelectorAll(selectors[i]);
        for (var j = 0; j < found.length; j++) if (nodes.indexOf(found[j]) < 0 && isVisibleHealthNode(found[j])) nodes.push(found[j]);
      }
      if (!nodes.length) return { node: null, previousNode: null, hasAssistant: false, assistantTextLength: 0, hasCompletionActions: false, completionMarker: false, looksTruncated: false, streaming: false };
      var node = nodes[nodes.length - 1];
      var previousNode = nodes.length > 1 ? nodes[nodes.length - 2] : null;
      var text = String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
      var cls = String(node.className || '');
      var streaming = /(streaming|loading|generating|typing)/i.test(cls);
      var actionRoot = node;
      for (var up = 0; up < 5 && actionRoot.parentElement; up++) {
        actionRoot = actionRoot.parentElement;
        var actionText = Array.prototype.map.call(actionRoot.querySelectorAll('button,[role="button"], [class*="action"], [class*="toolbar"]'), function (b) {
          return String(b.innerText || b.getAttribute('aria-label') || b.getAttribute('title') || '').trim();
        }).join(' ');
        if (/(复制|重试|重新生成|继续|copy|retry|regenerate|continue)/i.test(actionText)) {
          return { node: node, previousNode: previousNode, hasAssistant: true, assistantTextLength: text.length, hasCompletionActions: true, completionMarker: /<!--\s*WBS_DONE\s*-->|\bWBS_DONE\b/i.test(text), looksTruncated: false, streaming: streaming };
        }
      }
      var looksTruncated = /(\.\.\.|…|正在$|等待$|调用$|执行$|结果如下[:：]?$|[,，:：]$)/.test(text);
      return { node: node, previousNode: previousNode, hasAssistant: true, assistantTextLength: text.length, hasCompletionActions: false, completionMarker: /<!--\s*WBS_DONE\s*-->|\bWBS_DONE\b/i.test(text), looksTruncated: looksTruncated, streaming: streaming };
    }

    function setSessionHealthResult(result) {
      sessionHealth.result = result;
      var statusEl = root && root.querySelector ? root.querySelector('#wbs-health-status') : null;
      var dot = root && root.querySelector ? root.querySelector('.wbs-fab-health-dot') : null;
      var labels = { blocked: '等待确认', error: '会话错误', suspected: '疑似未完成', running: '运行中', completed: '已完成', stopped: '已停止', settling: '整理中', idle: '' };
      var label = labels[result.status] !== undefined ? labels[result.status] : result.status;
      if (statusEl) {
        statusEl.textContent = label;
        statusEl.className = 'wbs-health-status ' + result.status;
        statusEl.title = result.status === 'suspected' ? '回复已停止，但没有发现明确完成证据' : (result.reason || '');
      }
      if (dot) {
        dot.className = 'wbs-fab-health-dot ' + result.status;
        dot.title = label || '会话状态';
        dot.style.display = result.status === 'idle' || result.status === 'completed' ? 'none' : '';
      }
      if (result.status !== sessionHealth.lastStatus && (result.status === 'blocked' || result.status === 'error' || result.status === 'suspected')) {
        var msg = result.status === 'blocked' ? '会话正在等待决策确认' : result.status === 'error' ? '会话出现模型或网络错误' : '会话疑似异常停止，请检查结尾内容';
        toast(msg, result.status === 'error', root);
      }
      sessionHealth.lastStatus = result.status;
    }

    function scanSessionHealth() {
      if (!alive) return;
      var sid = getConversationId();
      if (sid !== sessionHealth.sessionId) {
        sessionHealth.sessionId = sid;
        sessionHealth.observed = false;
        sessionHealth.manualStop = false;
        sessionHealth.generationAt = 0;
        sessionHealth.lastBusyAt = 0;
        sessionHealth.baselineAssistantNode = null;
        sessionHealth.baselineAssistantTextLength = 0;
        sessionHealth.lastStatus = 'idle';
      }
      var blocked = findBlockingPrompt();
      var error = findSessionError();
      var busy = isAiBusy();
      var assistant = readAssistantHealth();
      if ((blocked || error) && !sessionHealth.observed) {
        sessionHealth.observed = true;
        sessionHealth.generationAt = Date.now() - 3000;
        sessionHealth.lastBusyAt = Date.now() - 3000;
        sessionHealth.baselineAssistantNode = assistant.node;
        sessionHealth.baselineAssistantTextLength = assistant.assistantTextLength;
      }
      if (busy && !sessionHealth.observed) {
        sessionHealth.observed = true;
        sessionHealth.generationAt = Date.now();
        sessionHealth.baselineAssistantNode = assistant.streaming ? assistant.previousNode : assistant.node;
        sessionHealth.baselineAssistantTextLength = assistant.streaming && assistant.previousNode ? Number(assistant.previousNode.textContent || '').length : assistant.assistantTextLength;
      }
      if (busy) sessionHealth.lastBusyAt = Date.now();
      var assistantChanged = !sessionHealth.baselineAssistantNode
        ? (assistant.hasAssistant && assistant.assistantTextLength > 0)
        : (assistant.node !== sessionHealth.baselineAssistantNode || assistant.assistantTextLength > sessionHealth.baselineAssistantTextLength);
      var idleForMs = sessionHealth.lastBusyAt ? Date.now() - sessionHealth.lastBusyAt : Date.now() - sessionHealth.generationAt;
      var result = classifySessionHealth({
        observed: sessionHealth.observed,
        blocked: !!blocked,
        error: !!error,
        busy: busy,
        idleForMs: idleForMs,
        hasAssistant: assistant.hasAssistant,
        assistantChanged: assistantChanged,
        assistantTextLength: assistant.assistantTextLength,
        hasCompletionActions: assistant.hasCompletionActions,
        completionMarker: assistant.completionMarker,
        looksTruncated: assistant.looksTruncated,
        manualStop: !!sessionHealth.manualStop,
      });
      setSessionHealthResult(result);
    }

    registerDisposer(function () {
      alive = false;
      for (var i = 0; i < buildTimeouts.length; i++) clearTimeout(buildTimeouts[i]);
      for (var j = 0; j < buildIntervals.length; j++) clearInterval(buildIntervals[j]);
      var cancelFrame = window.cancelAnimationFrame || clearTimeout;
      for (var k = 0; k < buildFrames.length; k++) cancelFrame(buildFrames[k]);
      buildTimeouts = [];
      buildIntervals = [];
      buildFrames = [];
    });

    var themeAudit = window.WBSThemeAudit && window.WBSThemeAudit.createThemeAudit
      ? window.WBSThemeAudit.createThemeAudit({
        schedule: requestBuildFrame,
        maxPerFlush: 50,
        now: Date.now,
        MutationObserver: window.MutationObserver,
        getComputedStyle: window.getComputedStyle ? window.getComputedStyle.bind(window) : null,
      })
      : null;
    var themeAuditRoot = null;
    var themeAuditGeneration = (Number(window.__wbsThemeAuditGeneration) || 0) + 1;
    window.__wbsThemeAuditGeneration = themeAuditGeneration;
    if (themeAudit) {
      window.__wbsThemeAudit = Object.freeze({
        summary: function () { return themeAudit.summary(); },
        active: function () { return themeAudit.active(); },
        generation: function () { return themeAuditGeneration; },
        root: function () { return themeAuditRoot ? themeAuditRoot.tagName + ':' + String(themeAuditRoot.className || '').slice(0, 120) : null; },
      });
    } else {
      window.__wbsThemeAudit = Object.freeze({
        summary: function () { return []; },
        active: function () { return false; },
        generation: function () { return themeAuditGeneration; },
        root: function () { return null; },
      });
    }
    var publicThemeAudit = window.__wbsThemeAudit;

    function isUsableThemeAuditRoot(node) {
      if (!node || !node.isConnected || node.closest('.wbs-root')) return false;
      if (node.hidden || node.getAttribute('aria-hidden') === 'true') return false;
      var hiddenAncestor = node.closest('[hidden],[aria-hidden="true"]');
      if (hiddenAncestor) return false;
      if (typeof node.getClientRects === 'function' && node.getClientRects().length === 0) return false;
      return true;
    }

    function findThemeAuditRoot() {
      var candidates = document.querySelectorAll(
        '[data-testid="message-list"],[class*="_chatMessageList_"],[class*="_messageList_"],' +
        '[data-view-id*="chat"] [class*="_messages_"],[class*="_conversationContent_"] [class*="_scrollContent_"]'
      );
      for (var i = candidates.length - 1; i >= 0; i--) {
        if (isUsableThemeAuditRoot(candidates[i])) return candidates[i];
      }
      return null;
    }

    function syncThemeAuditRoot() {
      if (!themeAudit || !alive) return;
      var nextThemeRoot = findThemeAuditRoot();
      if (nextThemeRoot !== themeAuditRoot) {
        themeAuditRoot = nextThemeRoot;
        if (nextThemeRoot) themeAudit.bind(nextThemeRoot);
        else themeAudit.disconnect();
      }
    }

    registerDisposer(function () {
      if (themeAudit) themeAudit.disconnect();
      themeAuditRoot = null;
      if (window.__wbsThemeAudit === publicThemeAudit) {
        try { delete window.__wbsThemeAudit; } catch (e) { window.__wbsThemeAudit = null; }
      }
    });

    // 根节点（fixed 右下角，面板 absolute 定位，右下角与按钮重合）
    var root = el('div', 'wbs-root');
    root.setAttribute('data-wbs-profile', PROFILE_ID);
    if (!CAPS.theme) root.classList.add('wbs-no-theme');
    if (!CAPS.stashPrompt) root.classList.add('wbs-no-stash');
    root.innerHTML = [
      '<div class="wbs-fab" title="' + WBS_BRAND + '">',
      '<span class="wbs-fab-sleep-dot" title="防休眠未开启"></span>',
      '<span class="wbs-fab-health-dot" title="会话状态" style="display:none"></span>',
      '<div class="click">',
      '<span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span>',
      '<button class="button up" type="button" aria-label="Codex 助手">',
      '<span class="wbs-fab-antenna" aria-hidden="true"><span class="wbs-fab-antenna-dot"></span></span>',
      '<span class="wbs-fab-ear wbs-fab-ear-left" aria-hidden="true"></span>',
      '<span class="wbs-fab-ear wbs-fab-ear-right" aria-hidden="true"></span>',
      '<div class="speak dblink"><div class="wrap"><div class="eye double-blink"></div><div class="eye double-blink"></div></div></div>',
      '<div class="speak doblink"><div class="wrap"><div class="eye down"></div><div class="eye down"></div></div></div>',
      '<div class="speak rblink"><div class="wrap"><div class="eye right-blink"></div><div class="eye right-blink"></div></div></div>',
      '<div class="speak ublink"><div class="wrap"><div class="eye up-blink"></div><div class="eye up-blink"></div></div></div>',
      '</button>',
      '<button disabled class="button shadow"></button>',
      '</div>',
      '</div>',
      '<div class="wbs-panel">',
      '<div class="wbs-head">',
      '<div class="wbs-head-left">',
      '<div class="wbs-title" id="wbs-title" title="连续点击 5 次呼出元素检查">' + WBS_BRAND + '</div>',
      '<span class="wbs-health-status" id="wbs-health-status" aria-live="polite"></span>',
      '<a class="wbs-ghbtn" href="https://github.com/babygoton/WorkDaddy" target="_blank" rel="noopener" title="GitHub 仓库">',
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M12 .3a12 12 0 0 0-3.79 23.39c.6.11.82-.26.82-.58v-2.03c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.33-1.76-1.33-1.76-1.09-.74.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.5 1 .1-.78.42-1.31.76-1.61-2.66-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.11-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6.01 0c2.29-1.55 3.3-1.23 3.3-1.23.65 1.66.24 2.88.12 3.18.77.84 1.23 1.91 1.23 3.22 0 4.61-2.81 5.62-5.49 5.92.43.37.82 1.1.82 2.22v3.29c0 .32.22.7.83.58A12 12 0 0 0 12 .3z"/></svg>',
      '</a>',
      '</div>',
      '<button class="wbs-btn-close" type="button" data-act="close">✕</button>',
      '</div>',
      '<div class="wbs-tabs">',
      '<button class="wbs-tab active" type="button" data-tab="account"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg><span>账号</span></button>',
      '<button class="wbs-tab" type="button" data-tab="theme"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a10 10 0 1 0 10 10c0-1.5-1-2-2-2h-3a2 2 0 0 1-2-2c0-1.5 1-2 1-2h2c0-3-2-4-6-4z"/><circle cx="13.5" cy="6.5" r="1"/><circle cx="17.5" cy="10.5" r="1"/><circle cx="8.5" cy="7.5" r="1"/><circle cx="6.5" cy="12.5" r="1"/></svg><span>主题</span></button>',
      '<button class="wbs-tab" type="button" data-tab="sessions"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><span>会话</span></button>',
      '<button class="wbs-tab" type="button" data-tab="models"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/></svg><span>模型</span></button>',
      '<button class="wbs-tab" type="button" data-tab="enhance"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg><span>增强</span></button>',
      '<button class="wbs-tab" type="button" data-tab="pc"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg><span>电脑</span></button>',
      '<button class="wbs-tab" type="button" data-tab="about"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg><span>关于</span></button>',
      '</div>',
      '<div class="wbs-body">',
      '<div class="wbs-pane active" data-pane="account"></div>',
      '<div class="wbs-pane" data-pane="theme"></div>',
      '<div class="wbs-pane" data-pane="sessions"></div>',
      '<div class="wbs-pane" data-pane="models"></div>',
      '<div class="wbs-pane" data-pane="enhance"></div>',
      '<div class="wbs-pane" data-pane="pc"></div>',
      '<div class="wbs-pane" data-pane="about"></div>',
      '</div>',
      '</div>',
    ].join('');
    document.body.appendChild(root);

    // 不同客户端只开放明确支持的能力；保留统一面板结构可避免模式切换时布局抖动。
    if (!CAPS.theme) {
      var themeTab = root.querySelector('[data-tab="theme"]');
      var themePane = root.querySelector('[data-pane="theme"]');
      if (themeTab) themeTab.remove();
      if (themePane) themePane.remove();
    }
    if (!CAPS.models) {
      var modelsTab = root.querySelector('[data-tab="models"]');
      var modelsPane = root.querySelector('[data-pane="models"]');
      if (modelsTab) modelsTab.remove();
      if (modelsPane) modelsPane.remove();
    }
    if (!CAPS.accounts) {
      var accountTab = root.querySelector('[data-tab="account"]');
      var accountPane = root.querySelector('[data-pane="account"]');
      var sessionsTab = root.querySelector('[data-tab="sessions"]');
      var sessionsPane = root.querySelector('[data-pane="sessions"]');
      if (accountTab) accountTab.remove();
      if (accountPane) accountPane.remove();
      if (sessionsTab) sessionsTab.classList.add('active');
      if (sessionsPane) sessionsPane.classList.add('active');
    }

    // ===== 暂存提示词：内联到「发送按钮」左侧，尺寸与发送按钮一致 =====
    // 显隐策略：直接监听 WorkBuddy 自己的「发送按钮」禁用态——输入框为空时发送按钮被禁用，
    // 此时隐藏暂存按钮；有内容（文字/图片/附件）时发送按钮可用，暂存按钮出现。
    // 这样无需自己去扫描 Slate 编辑器，和官方发送按钮行为完全一致。
    var stashBtn = document.createElement('div');
    stashBtn.className = 'wbs-stash-inline';
    stashBtn.setAttribute('role', 'button');
    stashBtn.setAttribute('tabindex', '0');
    stashBtn.title = '暂存提示词';
    stashBtn.innerHTML = '<span class="wbs-stash-ico">' + STASH_SVG + '</span><span class="wbs-stash-txt">暂存提示词</span>';
    if (!CAPS.stashPrompt) stashBtn.style.display = 'none';

    // 定位输入框操作栏（含 voice-mic-wrap 的父容器）
    function findActionRow() {
      var mic = document.querySelector('.voice-mic-wrap');
      if (mic) return mic.parentElement;
      // AI 端（无 voice-mic-wrap）：从输入框向上找最近的含按钮容器（操作栏），
      // 仅用于发送按钮状态监听，找不到不影响暂存按钮本身。
      var ed = findComposer();
      if (!ed) return null;
      var n = ed;
      for (var up = 0; up < 5 && n && n.parentElement; up++) {
        n = n.parentElement;
        if (!n.children || n.children.length < 2) continue;
        var hasBtn = false;
        for (var i = 0; i < n.children.length; i++) {
          var k0 = n.children[i];
          if (k0.tagName === 'BUTTON' || (k0.getAttribute && k0.getAttribute('role') === 'button')) { hasBtn = true; break; }
        }
        if (hasBtn) return n;
      }
      return null;
    }
    // AI 端输入框右下角按钮组。用户 DOM 路径：
    // ..._input-area-container_ > section._container_ > ... > div._spaceBetween_._inputBottom_ > div._item_._gapLarge_
    // 注意 _inputBottom_ 下有两个按钮组：左侧工具组(class 含 _selector_)、右侧发送按钮组(class 含 _gapLarge_，
    // x 更靠右)。必须命中右侧 _gapLarge_ 组，排除 _selector_ 组。
    function findAiToolbar() {
      var cands = document.querySelectorAll(
        '[class*="_inputBottom_"] > [class*="_gapLarge_"],' +
        '[class*="_inputBottom_"] > [class*="_gap_"]:not([class*="_selector_"]),' +
        '[class*="_inputBottom_"] > [class*="_item_"]:not([class*="_selector_"])'
      );
      var best = null, bestLeft = -Infinity;
      for (var i = 0; i < cands.length; i++) {
        var r = cands[i].getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        // 同一行内取最靠右的按钮组（发送按钮组）；行位置应贴近输入框底部
        if (r.left > bestLeft) { bestLeft = r.left; best = cands[i]; }
      }
      return best;
    }
    // 操作栏最右侧的「圆形可点击」元素才是发送按钮（左侧还可能有增强提示词/停止等圆形按钮）
    function findSendButton() {
      var row = findActionRow();
      if (!row || !row.children) return null;
      var kids = row.children;
      var matches = [];
      for (var i = 0; i < kids.length; i++) {
        var k = kids[i];
        if (k === stashBtn) continue; // 跳过自身（暂存按钮也是圆角可点击）
        var cs = getComputedStyle(k);
        var isClick = k.getAttribute && (k.getAttribute('role') === 'button' || k.tagName === 'BUTTON');
        var r = k.getBoundingClientRect();
        var w = r.width, h = r.height;
        if (!isClick || w < 16 || h < 16) continue;
        var circular = /%/.test(cs.borderRadius) || parseFloat(cs.borderRadius || '0') >= Math.min(w, h) / 2 - 3;
        if (circular) matches.push(k);
      }
      // 发送按钮始终在操作栏最右边（ microphone 右边、最末尾）
      if (matches.length) return matches[matches.length - 1];
      return kids[kids.length - 1] || null; // 兜底：最后一个子元素
    }
    // 发送按钮是否处于「禁用」态（输入框为空时官方会禁用它）
    function isSendDisabled(send) {
      if (!send) return false;
      if (send.disabled === true) return true;
      if (send.hasAttribute && send.hasAttribute('disabled')) return true;
      var ad = send.getAttribute && send.getAttribute('aria-disabled');
      if (ad === 'true' || ad === true) return true;
      var cls = (send.className || '').toString().toLowerCase();
      if (/(^|[\s_])disabled($|[\s_])/.test(cls) || cls.indexOf('is-disabled') >= 0 || cls.indexOf('ant-btn-disabled') >= 0) return true;
      return false;
    }
    // 关键：CN 端用 position: fixed 绝对定位到发送按钮坐标旁，挂在 document.body 下，
    // 不插入到操作栏 row.children 里——避开 React reconciliation 丢弃外部节点的问题。
    // AI 端（无 voice-mic-wrap）：实测其按钮容器不清理外部插入节点，直接内联插入
    // 操作栏右侧按钮组的第一位（用户要求的摆放方式），fixed 定位由 CSS 类覆盖为静态参与 flex。
    function insertStash() {
      // 重新注入脚本时先移除旧版按钮（避免旧 SVG 图标/样式残留）
      var oldBtn = document.querySelector('.wbs-stash-inline');
      if (oldBtn && oldBtn !== stashBtn) oldBtn.remove();
      var mic0 = document.querySelector('.voice-mic-wrap');
      if (!mic0) {
        var row0 = findAiToolbar();
        if (row0) {
          stashBtn.classList.add('wbs-stash-inline-inline');
          if (stashBtn.parentElement !== row0) row0.insertBefore(stashBtn, row0.firstChild);
        } else {
          // 容器暂不可用：回落到 body + fixed 定位
          stashBtn.classList.remove('wbs-stash-inline-inline');
          if (!stashBtn.parentElement) document.body.appendChild(stashBtn);
          positionStash();
        }
        return;
      }
      if (!stashBtn.parentElement) document.body.appendChild(stashBtn);
      positionStash();
    }
    function positionStash() {
      // AI 端没有 voice-mic-wrap：操作栏按钮行位于输入框正下方（与输入框同祖先容器）。
      // 取该行最左按钮的左边为锚，top 与按钮行对齐——与 CN 端「操作栏最左」语义一致。
      var mic = document.querySelector('.voice-mic-wrap');
      if (!mic) {
        var ed0 = findComposer();
        if (!ed0) { stashBtn.style.display = 'none'; return false; }
        var er0 = ed0.getBoundingClientRect();
        if (er0.width <= 0 || er0.height <= 0) { stashBtn.style.display = 'none'; return false; }
        var rowLeft = Infinity, rowTop = Infinity, rowH = 0, found = false;
        var n0 = ed0, depth = 0;
        while (n0 && n0 !== document.body && depth++ < 6) {
          n0 = n0.parentElement;
          if (!n0 || !n0.querySelectorAll || !n0.children) continue;
          var btns = n0.querySelectorAll('button,[role="button"],[class*="_ringClickable_"],[class*="_iconButton_"]');
          var row = [];
          for (var i = 0; i < btns.length; i++) {
            var k0 = btns[i];
            if (k0.classList && (k0.classList.contains('wbs-fab') || k0.classList.contains('wbs-stash-inline'))) continue;
            var r0 = k0.getBoundingClientRect();
            if (r0.width < 16 || r0.height < 16) continue;
            var cs0 = getComputedStyle(k0);
            if (cs0.visibility === 'hidden' || cs0.display === 'none') continue;
            var circ = /%/.test(cs0.borderRadius) || parseFloat(cs0.borderRadius || '0') >= Math.min(r0.width, r0.height) / 2 - 3;
            if (!circ) continue;
            // 只要「输入框同高区域下方、紧贴输入框底部」的操作栏按钮行，排除消息区/侧栏按钮
            if (r0.top < er0.top - 8 || r0.bottom > er0.bottom + 120) continue;
            row.push(r0);
          }
          if (row.length >= 2) {
            for (var j = 0; j < row.length; j++) {
              if (row[j].left < rowLeft) rowLeft = row[j].left;
              if (row[j].top < rowTop) rowTop = row[j].top;
              if (row[j].height > rowH) rowH = row[j].height;
            }
            found = true;
            break;
          }
        }
        var gap0 = 6;
        if (found) {
          stashBtn.style.right = (window.innerWidth - (rowLeft - gap0)) + 'px';
          stashBtn.style.top = (rowTop + Math.max(0, (rowH - 32) / 2)) + 'px';
        } else {
          // 回落：以输入框左边界为锚
          stashBtn.style.right = (window.innerWidth - (er0.left - gap0)) + 'px';
          stashBtn.style.top = (er0.top - 1) + 'px';
        }
        return true;
      }
      // 锚点：操作栏最左元素（row.children[0]），定位到它的左边——整个操作栏最左。
      // 用 right 锚定（CSS left:auto）：hover 时 width 增大 → 左边向左展开（参考 wbs-fab）。
      var row = mic.parentElement;
      if (!row || !row.children || !row.children.length) { stashBtn.style.display = 'none'; return false; }
      var firstChild = row.children[0]; // 操作栏最左元素（"上下文用量"按钮）
      var fr = firstChild.getBoundingClientRect();
      if (fr.width <= 0 || fr.height <= 0) { stashBtn.style.display = 'none'; return false; }
      var gap = 6;
      // 右边缘固定在 firstChild.left - gap，width 增大时左边向左伸出
      stashBtn.style.right = (window.innerWidth - (fr.left - gap)) + 'px';
      stashBtn.style.top = fr.top + 'px';
      return true;
    }
    function removeStash() {
      stashBtn.style.display = 'none';
    }
    // 是否在欢迎页（wb-home-page 或 main-content--welcome 存在即欢迎页）：
    // 用户要求欢迎页不展示暂存提示词按钮（欢迎页输入框只是快速提问入口，不需要暂存）。
    function isWelcomePage() {
      try {
        return !!(document.querySelector('.wb-home-page') || document.querySelector('.main-content--welcome'));
      } catch (_) { return false; }
    }
    // 是否该显示暂存按钮：直接看真正输入框是否有内容（修后 findComposer 不再误命中消息历史）。
    // WorkBuddy v5.3.8：空输入框下官方发送按钮 DOM 上不显式设置 disabled / is-disabled，
    // 显隐完全由「输入框是否有内容」决定，isSendDisabled 在空状态下检测不到。
    // 欢迎页一律不显示。
    function shouldShowStash() {
      if (isWelcomePage()) return false;
      var ed = findComposer();
      return composerHasContent(ed);
    }
    var stashSyncThrottle;
    function syncStash() {
      if (!alive) return;
      clearTimeout(stashSyncThrottle);
      // 节流 30ms：比 120ms 响应更快（接近原生 React 按钮的体感），仍能合并快速连续触发
      stashSyncThrottle = setBuildTimeout(function () {
        // 欢迎页强制隐藏（进入欢迎页/切回欢迎页时兜底，避免上一会话残留按钮）
        if (isWelcomePage()) { stashBtn.style.display = 'none'; return; }
        if (shouldShowStash()) {
          insertStash();
          stashBtn.style.display = 'flex';
        } else {
          stashBtn.style.display = 'none';
        }
      }, 30);
    }
    // 监听发送按钮自身的属性变化（class/disabled/aria-disabled 任一改变都重算显隐）
    var sendObserver = null, watchedSend = null;
    function watchSend() {
      if (!alive) return;
      var send = findSendButton();
      if (send === watchedSend) return;
      if (sendObserver) { sendObserver.disconnect(); sendObserver = null; }
      watchedSend = send;
      if (send && typeof MutationObserver !== 'undefined') {
        sendObserver = new MutationObserver(syncStash);
        sendObserver.observe(send, { attributes: true, attributeFilter: ['class', 'disabled', 'aria-disabled'] });
      }
      syncStash();
    }
    // 操作栏出现 / 子元素被替换时，重新定位发送按钮并绑定监听
    var rowObserver = null, watchedRow = null, bodyObserver = null;
    function watchRow() {
      if (!alive) return;
      var row = findActionRow();
      if (!row || typeof MutationObserver === 'undefined') {
        if (rowObserver) { rowObserver.disconnect(); rowObserver = null; }
        watchedRow = null;
        if (sendObserver) { sendObserver.disconnect(); sendObserver = null; }
        watchedSend = null;
        return;
      }
      if (row === watchedRow) return;
      if (rowObserver) rowObserver.disconnect();
      watchedRow = row;
      rowObserver = new MutationObserver(function () { watchSend(); syncStash(); });
      rowObserver.observe(row, { childList: true, attributes: true, attributeFilter: ['class'], subtree: false });
    }
    var lastStashSessionId = null;
    // 切会话安全：暂存签名按会话独立存储(stashedBySession)，切换不丢失；
    // 标签同步只对当前会话生效（syncQueueTags 内按 sessionId 过滤），旧会话的标签由面板重渲染自然清除。
    function guardSessionChange() {
      try {
        var a = window.__wbsAdapter;
        var sid = a && a.currentActiveSessionId;
        if (sid) lastStashSessionId = sid;
      } catch (e) {}
    }
    function onDomChange() {
      if (!alive) return;
      guardSessionChange();
      scheduleFabPos();
      watchRow();
      syncStash(); // 页面切换（欢迎页↔聊天页）后立即重算暂存按钮显隐
      if (!findActionRow()) return;
      watchSend();
      syncQueueTags();
      wrapQueueReorder();
    }
    function onInputSync() { if (!alive) return; guardSessionChange(); scheduleFabPos(); syncStash(); syncQueueTags(); wrapQueueReorder(); }
    syncThemeAuditRoot();
    if (themeAudit) setBuildInterval(syncThemeAuditRoot, 1200);
    // 暂存项暂停守护：1.2s 周期轮询，保证暂存提示词绝不被自动发送（见 guardStashedPause 注释）
    setBuildInterval(guardStashedPause, 1200);
    watchRow();
    watchSend();
    // 输入框输入/粘贴/中文合成结束也直接触发，覆盖 React 仅改内部状态、不动属性的情况
    listen(document, 'input', onInputSync);
    listen(document, 'compositionend', onInputSync);
    listen(document, 'keyup', onInputSync);
    listen(window, 'scroll', onInputSync, true);
    listen(window, 'resize', onInputSync);
    // 暂存项禁拖：捕获阶段拦截 dragstart（只 preventDefault/stopPropagation，不改 React 管理的 draggable 属性，
    // 不触发 mutation；普通项拖拽不受影响，官方 onDragStart 照常执行）
    listen(document, 'dragstart', function (e) {
      var t = e.target;
      var it = t && t.closest ? t.closest('.cb-message-queue-item') : null;
      if (it && it.getAttribute('data-wbs-stash') === '1') {
        if (e.preventDefault) e.preventDefault();
        if (e.stopPropagation) e.stopPropagation();
      }
    }, true);
    // 首屏操作栏可能尚未渲染：整体 DOM 变化时尝试定位操作栏并绑定
    // 【稳定性】body 级 observer 只监听子节点增删（不再监听 class 属性变化），且处理 rAF 节流到每帧最多一次。
    // 切会话/长消息列表重渲染会产生海量 mutation，若每批都同步跑 watchSend(getComputedStyle)/syncQueueTags，
    // 会形成强制样式重算 + 全量扫描风暴占满主线程（切会话卡死的主因）。
    var domChangePending = false;
    function scheduleDomChange() {
      if (domChangePending) return;
      domChangePending = true;
      requestBuildFrame(function () {
        domChangePending = false;
        if (alive) onDomChange();
      });
    }
    if (typeof MutationObserver !== 'undefined') {
      bodyObserver = new MutationObserver(scheduleDomChange);
      bodyObserver.observe(document.body, { childList: true, subtree: true });
    }
    syncStash(); // 初始检查
    setBuildTimeout(wrapQueueReorder, 800);

    // ===== 悬浮按钮动态定位：优先贴消息队列(cb-message-queue)右上角上方，否则贴输入框 mainArea 右上角上方 =====
    // 监听 body DOM/class 变化（onDomChange/onInputSync） + 轮询兜底，实时跟随组件显隐
    var fabPosPending = false;
    function scheduleFabPos() {
      if (fabPosPending) return;
      fabPosPending = true;
      requestBuildFrame(function () {
        fabPosPending = false;
        positionFab();
      });
    }
    function positionFab() {
      var fab = root.querySelector('.wbs-fab');
      if (!fab) return;
      if (fab.classList.contains('hidden')) return; // 面板打开时保持隐藏
      // WorkBuddy 首页 composer 的右上插槽存在时，按钮放回 WorkBuddy 窗口右下角，
      // 避免被首页输入区的内部定位挤到中间位置。
      var homeComposerCorner = document.querySelector('.wb-home-page [class*="_topRightSlotStandalone_"] > div:nth-child(1) > div:nth-child(3)');
      // WorkBuddy AI 欢迎页的右上插槽结构不同，第二个操作项出现时固定到窗口右下角。
      var aiHomeComposerCorner = PROFILE_ID === 'workbuddy-ai'
        ? document.querySelector('.wb-home-page [class*="_topRightSlotStandalone_"] > div:nth-child(1) > div:nth-child(2)')
        : null;
      if (homeComposerCorner || aiHomeComposerCorner) {
        var cornerRect = (aiHomeComposerCorner || homeComposerCorner).getBoundingClientRect();
        if (cornerRect.width > 0 && cornerRect.height > 0) {
          fab.classList.remove('fab--solid');
          fab.style.position = 'fixed';
          fab.style.left = 'auto';
          fab.style.top = 'auto';
          fab.style.right = '22px';
          fab.style.bottom = '22px';
          return;
        }
      }
      var target = null;
      var solid = false; // 贴消息队列上方时纯色背景（不毛玻璃）
      // 1) 消息队列展开时优先贴它
      var q = document.querySelector('.cb-message-queue.cb-expand');
      if (q) {
        var qr = q.getBoundingClientRect();
        if (qr.height > 1 && qr.width > 1) { target = qr; solid = true; }
      }
      // 2) 兜底：输入框主体 _mainArea（聊天页 _input-area-container 内 / 主页 wb-home-composer 内）
      if (!target) {
        var ma = document.querySelector('[class*="_input-area-container_"] [class*="_mainArea_"]');
        if (!ma) ma = document.querySelector('.wb-home-composer [class*="_mainArea_"]');
        if (ma) {
          var mr = ma.getBoundingClientRect();
          if (mr.height > 1 && mr.width > 1) target = mr;
        }
      }
      if (!target) {
        // 无目标（如登录页）：回落到默认右下角
        fab.style.right = '22px';
        fab.style.bottom = '22px';
        return;
      }
      var GAP_R = 8;   // 右边留间距
      var GAP_V = 0;   // 垂直完全贴合
      // 贴 queue 时纯色背景，贴 mainArea 时毛玻璃
      fab.classList.toggle('fab--solid', solid);
      fab.style.position = 'fixed';
      fab.style.left = 'auto';
      fab.style.top = 'auto';
      fab.style.right = (window.innerWidth - target.right + GAP_R) + 'px';
      fab.style.bottom = (window.innerHeight - target.top + GAP_V) + 'px';
    }
    // 轮询兜底：queue 显隐 / 输入框高度变化可能漏触发 observer
    fabPosTimer = setBuildInterval(function () { if (alive) scheduleFabPos(); }, 1500);
    setBuildTimeout(scheduleFabPos, 600); // 首屏定位

    // ===== chat widget 预览 iframe 背景透明（用户要求）=====
    // 场景：AI 生成的 widget（_widgetRendererWrapper/_widgetContainer 内的 iframe）在深色主题下
    // 自带黑底，与毛玻璃主题不协调；且元素拾取器无法进入 iframe 内部定位样式来源。
    // 两层兜底：
    //  1) iframe 元素级背景透明 —— 由 theme-patches.js 的 CSS 补丁处理（html[data-theme="dark"]）；
    //  2) 本 JS 对同源 iframe（srcdoc/blob，contentDocument 可访问）注入 html,body 透明样式，
    //     覆盖 iframe 内部文档自带的黑底（跨域 iframe 无法注入内部，仅靠元素级 CSS）。
    var WIDGET_IFRAME_STYLE_ID = 'wbs-iframe-transparent';
    function fixWidgetIframeBg() {
      if (!alive) return;
      try {
        var h = document.documentElement;
        var dark = h && (h.getAttribute('data-theme') === 'dark' || h.classList.contains('cb-dark'));
        if (!dark) return; // 仅深色主题需要处理（浅色下 widget 保持自身渲染）
        var frames = document.querySelectorAll('[class*="_widgetRendererWrapper_"] iframe,[class*="_widgetContainer_"] iframe');
        for (var i = 0; i < frames.length; i++) {
          try {
            var doc = frames[i].contentDocument;
            if (!doc || !doc.documentElement) continue;
            if (doc.getElementById(WIDGET_IFRAME_STYLE_ID)) continue;
            var st = doc.createElement('style');
            st.id = WIDGET_IFRAME_STYLE_ID;
            st.textContent = 'html,body{background:transparent !important;background-color:transparent !important;}';
            (doc.head || doc.documentElement).appendChild(st);
          } catch (_) {}
        }
      } catch (_) {}
    }
    setBuildInterval(fixWidgetIframeBg, 1500);
    setBuildTimeout(fixWidgetIframeBg, 800);

    // ===== 暂存提示词：优先入队到 WorkBuddy 的 message queue（完整富文本 + 暂停自动发送）=====
    // 通过 React fiber 提取 adapter（含 enqueueConversationMessageQueueItem / pauseConversationMessageQueue）。
    function findWbsAdapter() {
      // 缓存校验：adapter 的官方包装方法必须仍在（切账号/重挂载后旧实例可能失效，需重新查找）
      if (window.__wbsAdapter && typeof window.__wbsAdapter.enqueueConversationMessageQueueItem === 'function' &&
          typeof window.__wbsAdapter.pauseConversationMessageQueue === 'function') return window.__wbsAdapter;
      var roots = [document.querySelector('.voice-mic-wrap'), document.querySelector('[class*="_cbChat_"]'), document.querySelector('.chat-container')];
      for (var ri = 0; ri < roots.length; ri++) {
        var el = roots[ri];
        if (!el) continue;
        var node = el;
        for (var up = 0; up < 30 && node; up++) {
          var fk = Object.keys(node).find(function (k) { return k.indexOf('__reactFiber') === 0; });
          if (fk) {
            var cur = node[fk], seen = 0;
            while (cur && seen < 150) {
              var p = cur.memoizedProps;
              if (p && typeof p === 'object') {
                for (var pk in p) {
                  var v = p[pk];
                  if (v && typeof v === 'object' && typeof v.enqueueConversationMessageQueueItem === 'function') {
                    window.__wbsAdapter = v;
                    return v;
                  }
                }
              }
              cur = cur.return; seen++;
            }
          }
          node = node.parentElement;
        }
      }
      return null;
    }
    // 把抓取的输入框富文本转成 contentblocks（image 补回 base64 data），原样加入 WorkBuddy 队列。
    // 【稳定性】只保留最朴素的纯对象字段，去掉 _meta/displayAsPhrase 等可能带不可克隆引用的元数据——
    // 5.3.8 在重渲染队列面板跨进程克隆该项时会因这类字段崩（An object could not be cloned）。
    function contentToBlocks(content) {
      var blocks = [];
      var text = (content && content.text || '').replace(/[\uFEFF\u200B]+/g, '').trim();
      if (text) blocks.push({ type: 'text', text: text });
      (content && content.items || []).forEach(function (it) {
        try {
          if (it.type === 'image' && it.imageBase64) {
            blocks.push({ type: 'image', data: it.imageBase64, mimeType: 'image/png', uri: it.uri || '' });
          } else if (it.type === 'image') {
            blocks.push({ type: 'image', data: it.data || '', mimeType: 'image/png', uri: it.uri || '' });
          } else if (it.type !== 'text') {
            var b = { type: it.type, name: it.name || '附件', uri: it.uri || '', title: it.title || it.name || '附件' };
            if (it.mimeType) b.mimeType = it.mimeType;
            blocks.push(b);
          }
        } catch (e) {}
      });
      return blocks;
    }
    // 入队/暂停全部走 adapter 的官方包装方法（enqueueConversationMessageQueueItem / pauseConversationMessageQueue）：
    // 包装方法内部会调用 client RPC + _notifyQueueUpdate(snapshot)（sanitize + 存快照 + 同步运行时 + 通知面板回调），
    // 官方面板正是靠这一条链路刷新的。手动直调 client.sessions.* 或手动喂 _queueCallbacks 都会绕过/复刻这条
    // 链路——前者导致面板不刷新，后者（外部驱动宿主队列回调）经实测在渲染进程级崩溃，绝不可用。
    // 本地兜底仅在官方包装不可用（adapter 缺失/接口不全）时触发。

    // ===== 队列消息「暂存提示词」标签 =====
    // 通过「暂存提示词」按钮入队的消息，在 queue cell 的操作区最左边插入小标签「暂存提示词」。
    // 【稳定性】只做幂等的标签插入/移除，绝不动 class/draggable 等 React 管理的属性——
    // 面板重渲染时我们的属性变更会与 React 的 draggable 属性互相覆盖触发 mutation 风暴（切会话卡死）。
    // 排序保持由 WorkBuddy 自身调度器决定（暂存=暂停态，不会被自动发送插队），不再做任何 reorder。
    // 通过文本签名匹配（text blocks 拼接），入队成功后记录；按会话存储：切换会话后回来仍能认出本会话的暂存项。
    var stashedBySession = {};
    function stashSigs(sessionId) {
      if (!sessionId) return [];
      var arr = stashedBySession[sessionId];
      if (!arr) { arr = []; stashedBySession[sessionId] = arr; }
      return arr;
    }
    function recordStashQueueText(sessionId, blocks) {
      var parts = [];
      (blocks || []).forEach(function (b) {
        if (b && b.type === 'text' && b.text) parts.push(b.text);
      });
      if (!parts.length) return;
      var arr = stashSigs(sessionId);
      var sig = parts.join('\n').replace(/\s+/g, ' ').trim();
      if (sig && arr.indexOf(sig) < 0) arr.push(sig);
    }
    // 判断一个 queue item 是否为「暂存提示词」消息（按文本签名匹配，仅当前会话）
    function isStashItem(sessionId, it) {
      var arr = stashSigs(sessionId);
      if (!arr.length) return false;
      var contentEl = it.querySelector('.content');
      var txt = (contentEl && (contentEl.getAttribute('title') || contentEl.textContent) || '').replace(/\s+/g, ' ').trim();
      if (!txt) return false;
      return arr.some(function (s) { return s && txt.indexOf(s) >= 0; });
    }
    // 同步标签（仅当前会话的暂存签名）。只做幂等 DOM 插入/移除，不改 React 属性。
    function syncQueueTags() {
      var sessionId = (window.__wbsAdapter && window.__wbsAdapter.currentActiveSessionId);
      var arr = stashSigs(sessionId);
      if (!alive || !arr.length) return;
      var items = document.querySelectorAll('.cb-message-queue-item');
      Array.prototype.forEach.call(items, function (it) {
        var actions = it.querySelector('.cb-message-queue-item-actions');
        if (!actions) return;
        var hasTag = !!it.querySelector('.wbs-queue-tag');
        var matched = isStashItem(sessionId, it);
        if (matched) {
          if (!hasTag) {
            var tag = el('span', 'wbs-queue-tag');
            tag.innerHTML =
              '<svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">' +
              '<path d="M2.53 2.53A2.25 2.25 0 0 1 4.12 2h6.13c.6 0 1.17.24 1.59.66l9.5 9.5a2.25 2.25 0 0 1 0 3.18l-5.4 5.4a2.25 2.25 0 0 1-3.18 0l-9.5-9.5a2.25 2.25 0 0 1-.66-1.59V4.12c0-.6.24-1.17.66-1.59zM7.06 8.56a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z"/></svg>' +
              '<span>暂存提示词</span>';
            actions.insertBefore(tag, actions.firstChild);
          }
          // data-wbs-stash 标记：禁拖（dragstart 捕获拦截）+ 隐藏拖拽图标（CSS）。data 属性 React 不管理，幂等设置安全
          it.setAttribute('data-wbs-stash', '1');
        } else {
          if (hasTag) {
            var t = it.querySelector('.wbs-queue-tag');
            if (t) t.remove();
          }
          it.removeAttribute('data-wbs-stash');
        }
      });
    }
    function watchQueueOrder() { /* no-op：不做 reorder（私有 RPC 在切会话时会使渲染进程崩溃，日志证实） */ }
    // ===== 暂存项暂停守护 =====
    // 官方 pause 状态不稳定：backend 重启(normalizeQueueForRestart 只保留 error reason)或新 prompt 时会丢失 paused，
    // 回复完成后 dispatcher 会把队列 pending 项自动激活发送（daemon 日志实锤 [queue.dispatcher] prompt completed; activating）。
    // 守护 = 动态暂停策略，保证「普通项自动发送、暂存项只手动发送」：
    //   · 队列有普通 pending 项 → 保持未暂停（官方自动发送最上面的普通项，普通在前由排序守护保证）；
    //   · 只剩暂存 pending 项 → paused=true 挡住自动发送；
    //   · 用户点暂存项发送（sending）→ 放行该条（resume + 重放官方 sendQueueItemNow）；
    //   · 无暂存项 → 解除暂停、停止守护。
    // 识别复用 stashedBySession（文本签名）；按会话独立守护，切换会话不影响其他会话的暂存项。
    var stashSendingSince = {}; // sid -> ts：该会话 sending 暂存项出现时间（判断是否空闲卡住）
    // 顺序合规判定：按 order 排序的 pending 项中，第一个不是暂存项（即普通项在最前）
    function stashOrderValid(items, arr) {
      if (!items || !arr) return true;
      var pendings = [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].status === 'pending') pendings.push(items[i]);
      }
      if (!pendings.length) return true;
      pendings.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
      return !isStashItemByContent(pendings[0], arr);
    }
    function guardStashedPause() {
      if (!alive) return;
      var adapter = window.__wbsAdapter;
      if (!adapter || typeof adapter.getConversationMessageQueue !== 'function' ||
          typeof adapter.pauseConversationMessageQueue !== 'function' ||
          typeof adapter.resumeConversationMessageQueue !== 'function' ||
          typeof adapter.sendConversationMessageQueueItemNow !== 'function') return;
      var sids = Object.keys(stashedBySession);
      if (!sids.length) return;
      for (var gi = 0; gi < sids.length; gi++) {
        (function (sid) {
          var arr = stashSigs(sid);
          if (!arr.length) { delete stashedBySession[sid]; return; }
          var p;
          try { p = adapter.getConversationMessageQueue(sid); } catch (e) { return; }
          Promise.resolve(p).then(function (q) {
            if (!q || !q.items || !q.runtime) return;
            var hasStashPending = false;
            var hasStashSending = false;
            var hasNormalPending = false;
            var sendingItemId = null;
            for (var k = 0; k < q.items.length; k++) {
              var it = q.items[k];
              if (it.status === 'sending') {
                if (isStashItemByContent(it, arr)) { hasStashSending = true; if (!sendingItemId) sendingItemId = it.id; }
                continue;
              }
              if (it.status !== 'pending') continue;
              if (isStashItemByContent(it, arr)) hasStashPending = true;
              else hasNormalPending = true;
            }
            if (hasStashSending) {
              // 用户点了发送按钮（官方 sendQueueItemNow 把该条标为 sending + immediateItemId）：
              // 官方真正发送走 sendNow→continueAfterPrompt→activate 链路，若 paused=true 会拦停 → 卡 loading。
              // 若 2s 后该条仍未被 agent 自动消费（空闲场景）→ resume（清 paused）后重走官方
              // sendConversationMessageQueueItemNow：其内部会再调 continueAfterPrompt，paused=false 时官方自然
              // activate 并 dispatch 发送这一条（immediateItemId 指向它，不会误发其他项）。
              // 发送完成后动态暂停策略会在下一轮接管（有普通 pending 保持放行、只剩暂存则暂停）。
              if (!stashSendingSince[sid]) stashSendingSince[sid] = Date.now();
              if (Date.now() - stashSendingSince[sid] > 2000) {
                delete stashSendingSince[sid];
                var retrySend = function () {
                  try {
                    Promise.resolve(adapter.sendConversationMessageQueueItemNow(sid, sendingItemId))
                      .then(function () { crumb('guard:manual-send-ok'); })
                      .catch(function () { crumb('guard:manual-send-fail'); });
                  } catch (e) {}
                };
                if (q.runtime.paused) {
                  Promise.resolve(adapter.resumeConversationMessageQueue(sid)).then(retrySend).catch(retrySend);
                } else {
                  retrySend();
                }
              }
              return; // 发送处理分支：跳过暂停/排序干预，等下轮结果
            }
            delete stashSendingSince[sid];
            // ===== 动态暂停策略 =====
            // 普通（会自动发送）项与暂存项共存的正确行为：
            //   · 队列里有普通 pending 项 → 保持未暂停，回复完成后官方自动发送最上面的普通项
            //     （普通在前、暂存在后由排序守护 enforceStashOrder 保证，activate 永远先取普通项）；
            //   · 只剩暂存 pending 项 → 暂停，挡住暂存项被自动发送；
            //   · 已无本插件暂存项 → 解除暂停、停止守护。
            if (hasNormalPending) {
              // 防御：仅当「第一个 pending 项是普通项」时放行——顺序违规时先等 enforceStashOrder 修正，本轮不 resume，
              // 避免 resume 后官方 activate 误取到排在前面的暂存项
              if (q.runtime.paused && stashOrderValid(q.items, arr)) {
                try { adapter.resumeConversationMessageQueue(sid); crumb('guard:auto-send-resume'); } catch (e) {}
              }
              if (hasStashPending) {
                enforceStashOrder(sid, q.items, arr);
              } else {
                // 普通项还在但已无本插件暂存项：交给官方正常调度，停止守护
                delete stashedBySession[sid];
              }
            } else if (hasStashPending) {
              if (!q.runtime.paused) {
                try {
                  adapter.pauseConversationMessageQueue(sid, 'manual');
                  crumb('guard:repause');
                } catch (e) {}
              }
            } else {
              // 队列中已无本插件暂存项（用户已手动发送/移除）：解除暂停，恢复正常队列行为
              if (q.runtime.paused) {
                try { adapter.resumeConversationMessageQueue(sid); crumb('guard:resume'); } catch (e) {}
              }
              delete stashedBySession[sid];
            }
          }).catch(function () {});
        })(sids[gi]);
      }
    }
    // ===== 队列排序守护：普通项在前、暂存项在后 =====
    // 用户在队列中拖拽排序时，不允许把「会自动发送」的普通项拖到带「暂存提示词」标签的项之后。
    // 这里在守护轮询里检测顺序：只要存在普通项排在任一暂存项之后 → 用官方 reorderConversationMessageQueueItems
    // （官方包装方法：client RPC + _notifyQueueUpdate 刷新面板）重排为「普通项保持原相对顺序在前 + 暂存项保持原相对顺序在后」。
    // 【稳定性】受历史教训约束（reorder RPC 在切会话窗口可能使渲染进程崩溃，日志证实）：
    // 仅当真实违规时触发 + 在途互斥 + 4s 冷却 + 会话切换保护 + 全程 try/catch 静默，失败只记录 crumb 不抛错。
    var stashReorderBusy = false;
    var stashReorderAt = 0;
    function isStashItemByContent(it, arr) {
      var parts = [];
      (it.contentBlocks || []).forEach(function (b) { if (b && b.text) parts.push(b.text); });
      var txt = parts.join('\n').replace(/\s+/g, ' ').trim();
      if (!txt) return false;
      for (var i = 0; i < arr.length; i++) {
        if (arr[i] && txt.indexOf(arr[i]) >= 0) return true;
      }
      return false;
    }
    function enforceStashOrder(sessionId, items, arr) {
      if (!alive || !items || !arr || !arr.length) return;
      if (stashReorderBusy) return;
      var now = Date.now();
      if (now - stashReorderAt < 4000) return; // 冷却：低频修正，避免 reorder RPC 风暴
      var adapter = window.__wbsAdapter;
      if (!adapter || typeof adapter.reorderConversationMessageQueueItems !== 'function') return;
      // 按 order 升序排序（排除 sending 项：用户正在手动发送，不参与排序修正/不移动它），记录每个 item 是否暂存
      var sorted = items.filter(function (it) { return it.status !== 'sending'; })
        .slice().sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
      if (sorted.length < 2) return;
      var stashMap = {};
      var firstStashIdx = -1, lastNormalIdx = -1;
      for (var i = 0; i < sorted.length; i++) {
        if (isStashItemByContent(sorted[i], arr)) {
          stashMap[sorted[i].id] = true;
          if (firstStashIdx < 0) firstStashIdx = i;
        } else {
          lastNormalIdx = i;
        }
      }
      // 违规条件：存在普通项排在任一暂存项之后（即最后一个普通项的位置 > 第一个暂存项的位置）
      if (firstStashIdx < 0 || lastNormalIdx <= firstStashIdx) return;
      // 期望顺序：普通项（保持原相对顺序）+ 暂存项（保持原相对顺序）
      var orderedIds = [];
      for (var j = 0; j < sorted.length; j++) if (!stashMap[sorted[j].id]) orderedIds.push(sorted[j].id);
      for (var k = 0; k < sorted.length; k++) if (stashMap[sorted[k].id]) orderedIds.push(sorted[k].id);
      // 会话切换保护：reorder 前确认会话 id 仍可用，且避免跨会话竞态
      var curSid = adapter.currentActiveSessionId;
      if (!curSid) return;
      stashReorderBusy = true;
      crumb('order:reorder:' + sessionId);
      Promise.resolve(adapter.reorderConversationMessageQueueItems(sessionId, orderedIds))
        .then(function () { crumb('order:ok'); })
        .catch(function (e) { crumb('order:fail'); })
        .finally(function () {
          stashReorderBusy = false;
          stashReorderAt = Date.now();
        });
    }
    // 兼容旧调用点（onDomChange/onInputSync/setTimeout 仍调用旧函数名，改为内部转发）
    function wrapQueueReorder() { /* no-op：见 watchQueueOrder */ }
    // 清空输入框：通过 React fiber 找到 ChatInput 的 onChange（父级 setValue）并传空内容块。
    // 这样 React 正确更新 value 链（DOM + 父组件 store），避免 WorkBuddy 切换会话时用旧 value 恢复。
    // 【切会话守卫】入队 await 期间可能发生会话切换：此时 fiber 链可能已失效/指向旧会话，
    // 直接调 onChange 有渲染进程风险——一律跳过（输入框留着内容，用户可见可清）。
    function clearComposerViaOnChange() {
      try {
        var wbsA = window.__wbsAdapter;
        if (stashSessionAtClick && wbsA && wbsA.currentActiveSessionId &&
            wbsA.currentActiveSessionId !== stashSessionAtClick) return; // 会话已切换：跳过清空
        var mic = document.querySelector('.voice-mic-wrap');
        var ed = null;
        if (mic) {
          var p0 = mic.parentElement;
          for (var up = 0; up < 6 && p0; up++) {
            var e = p0.querySelector('[contenteditable="true"]');
            if (e) { ed = e; break; }
            p0 = p0.parentElement;
          }
        }
        if (!ed) return;
        var node = ed;
        for (var up = 0; up < 20 && node; up++) {
          var fk = Object.keys(node).find(function (k) { return k.indexOf('__reactFiber') === 0; });
          if (fk) {
            var cur = node[fk], seen = 0;
            while (cur && seen < 120) {
              var p = cur.memoizedProps;
              if (p && typeof p === 'object' && typeof p.onChange === 'function' && Array.isArray(p.value) &&
                  p.value[0] && typeof p.value[0] === 'object' && Array.isArray(p.value[0].children)) {
                // 只清空有内容的（避免空输入也触发重渲染）；仅命中 Slate 文档结构（paragraph+children），
                // 防止误调其它组件的 onChange 造成渲染死循环/卡死
                var hasText = false;
                try {
                  hasText = (ed.innerText || '').replace(/[\uFEFF\u200B]/g, '').trim().length > 0 || !!ed.querySelector('[data-contentblock]');
                } catch (_) {}
                // 二次守卫：fiber 必须仍挂在活 DOM 上（React 重渲染期间节点可能已 detach）
                if (hasText && document.contains(ed)) {
                  p.onChange([{ type: 'paragraph', children: [{ text: '' }] }]);
                }
                return;
              }
              cur = cur.return; seen++;
            }
          }
          node = node.parentElement;
        }
      } catch (e) {}
    }
    // 队列操作超时包装：WorkBuddy 内部 Promise 可能永不 settle，超时后走本地暂存兜底，避免"卡死"
    function withQueueTimeout(promise, ms) {
      return new Promise(function (resolve, reject) {
        var done = false;
        var t = setBuildTimeout(function () {
          if (!done) { done = true; reject(new Error('WorkBuddy 队列响应超时（' + Math.round(ms / 1000) + 's）')); }
        }, ms);
        promise.then(function (r) { if (!done) { done = true; clearTimeout(t); resolve(r); } },
          function (e) { if (!done) { done = true; clearTimeout(t); reject(e); } });
      });
    }
    function enqueueToWorkBuddyQueue(content) {
      try {
        var adapter = findWbsAdapter();
        // 官方包装方法必须齐全：enqueueConversationMessageQueueItem（入队+刷新面板）/ pauseConversationMessageQueue（暂停自动发送+刷新面板）
        if (!adapter || typeof adapter.enqueueConversationMessageQueueItem !== 'function' ||
            typeof adapter.pauseConversationMessageQueue !== 'function') {
          return Promise.reject(new Error('未找到 WorkBuddy 队列接口'));
        }
        var sessionId = adapter.currentActiveSessionId;
        if (!sessionId) return Promise.reject(new Error('未获取到当前会话'));
        var blocks = contentToBlocks(content);
        if (!blocks.length) return Promise.reject(new Error('输入框内容为空'));
        recordStashQueueText(sessionId, blocks);
        // 官方包装：client RPC + _notifyQueueUpdate(snapshot) → 官方面板自动显示该条（不手动喂回调）
        return withQueueTimeout(adapter.enqueueConversationMessageQueueItem(sessionId, blocks), 8000)
        .then(function () {
          crumb('enqueue:done');
          // 官方包装：patchConversationQueueRuntime({paused:true,pauseReason}) + RPC + 刷新面板；
          // 自动发送调度器只对 pauseReason==="cancel" 续发，manual 会稳定拦停。
          return withQueueTimeout(adapter.pauseConversationMessageQueue(sessionId, 'manual'), 5000)
            .then(function () { crumb('pause:ok'); })
            .catch(function () { crumb('pause:fail'); return null; });
        })
        .then(function () {
          crumb('enqueue:paused');
          return { ok: true, blocks: blocks.length, sessionId: sessionId };
        });
      } catch (e) {
        // 同步异常防护：adapter/队列 API 任何同步抛错都不中断点击链，转 reject 走本地暂存兜底
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
    }

    var stashBusy = false;
    var stashBusyTimer = null;
    var stashSessionAtClick = null; // 点击暂存时的会话 id：清空输入框的切会话守卫用
    function crumb(msg) {
      try { console.log('[wbscrum]', msg); } catch (e) {}
      try {
        fetch(API + '/api/breadcrumb', { method: 'POST', headers: { 'content-type': 'application/json', 'X-WorkDaddy-Token': WBS_API_TOKEN }, body: JSON.stringify({ msg: msg }) }).catch(function () {});
      } catch (e) {}
    }
    listen(stashBtn, 'click', function () {
      if (stashBusy) return;
      crumb('click:start');
      var content = getComposerContent();
      if (!content) { return; }
      stashBusy = true;
      stashBtn.style.opacity = '0.6';
      // 看门狗：15s 内未完成强制解锁——WorkBuddy 队列 Promise 可能永不 settle，避免按钮永久"卡死"
      clearTimeout(stashBusyTimer);
      stashBusyTimer = setBuildTimeout(function () {
        stashBusy = false;
        stashBtn.style.opacity = '';
      }, 15000);
      // 任意时刻都能暂存：走官方包装入队 + 暂停（不自动发送）；面板刷新由 adapter 内部 _notifyQueueUpdate 完成。
      crumb('click:enqueue');
      stashSessionAtClick = (window.__wbsAdapter && window.__wbsAdapter.currentActiveSessionId) || null;
      enqueueToWorkBuddyQueue(content)
        .then(function (r) {
          clearComposerViaOnChange();
          syncStash(); // 输入框清空后隐藏暂存按钮
        })
        .catch(function (e) {
          // 兜底：WorkBuddy 队列不可用时退回本地暂存
          var uidPromise = (state.current && state.current.uid)
            ? Promise.resolve(state.current.uid)
            : api('/api/current').then(function (c) { return (c && c.uid) || null; }).catch(function () { return null; });
          return uidPromise.then(function (uid) {
            var convId = getConversationId();
            return api('/api/stash', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ uid: uid || null, conversationId: convId, content: content }),
            }).then(function () {
              // 已暂存到本地面板（WorkBuddy 队列不可用时兜底）
            });
          });
        })
        .catch(function (e) {
          // 暂存失败：静默（功能内部错误不影响输入框）
        })
        .finally(function () { clearTimeout(stashBusyTimer); stashBusy = false; stashBtn.style.opacity = ''; stashSessionAtClick = null; });
    });

    var fab = root.querySelector('.wbs-fab');
    var panel = root.querySelector('.wbs-panel');
    var body = root.querySelector('.wbs-body');
    var accountsPane = root.querySelector('[data-pane="account"]');
    var themePane = root.querySelector('[data-pane="theme"]');
    var sessionsPane = root.querySelector('[data-pane="sessions"]');
    var modelsPane = root.querySelector('[data-pane="models"]');
    var enhancePane = root.querySelector('[data-pane="enhance"]');
    var pcPane = root.querySelector('[data-pane="pc"]');
    var aboutPane = root.querySelector('[data-pane="about"]');
    var logoutBtn = root.querySelector('[data-act="logout"]');
    var creditTooltip = null;
    var creditTooltipSegment = null;

    function findCreditSegment(target) {
      var node = target;
      while (node && node !== accountsPane) {
        if (node.nodeType === 1 && node.classList && node.classList.contains('wbs-credit-segment')) return node;
        node = node.parentNode;
      }
      return null;
    }

    function hideCreditTooltip() {
      creditTooltipSegment = null;
      if (creditTooltip) creditTooltip.style.display = 'none';
    }

    function showCreditTooltip(segment) {
      if (!segment || !segment.getAttribute('data-tip')) return;
      if (!creditTooltip) {
        creditTooltip = document.createElement('div');
        creditTooltip.className = 'wbs-credit-tooltip';
        creditTooltip.setAttribute('role', 'tooltip');
        document.body.appendChild(creditTooltip);
      }
      creditTooltip.textContent = segment.getAttribute('data-tip');
      creditTooltip.style.display = 'block';
      var rect = segment.getBoundingClientRect();
      var tipRect = creditTooltip.getBoundingClientRect();
      var gap = 8;
      var top = rect.top - tipRect.height - gap;
      if (top < 8) top = rect.bottom + gap;
      var left = rect.left + (rect.width / 2) - (tipRect.width / 2);
      left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8));
      creditTooltip.style.left = Math.round(left) + 'px';
      creditTooltip.style.top = Math.round(top) + 'px';
    }

    if (accountsPane) {
      listen(accountsPane, 'mouseover', function (event) {
        var segment = findCreditSegment(event.target);
        if (!segment || segment === creditTooltipSegment) return;
        creditTooltipSegment = segment;
        showCreditTooltip(segment);
      });
      listen(accountsPane, 'mouseout', function (event) {
        var from = findCreditSegment(event.target);
        var to = findCreditSegment(event.relatedTarget);
        if (from && from !== to) hideCreditTooltip();
      });
      listen(accountsPane, 'scroll', hideCreditTooltip, true);
      listen(window, 'resize', hideCreditTooltip);
      registerDisposer(function () {
        hideCreditTooltip();
        if (creditTooltip) { creditTooltip.remove(); creditTooltip = null; }
      });
    }

    // 账号 pane 初始化：顶部 导出/导入 工具栏 + 列表容器 + 底部退出登录按钮（原 foot 的 logout 迁移到账号 tab）
    if (accountsPane) {
      accountsPane.innerHTML =
        '<div class="wbs-acct-toolbar">' +
        '<div class="wbs-acct-summary" aria-label="账号汇总">' +
        '<div class="wbs-acct-stat"><span>账号数</span><strong id="wbs-acct-count">-</strong></div>' +
        '<span class="wbs-acct-stat-divider"></span>' +
        '<div class="wbs-acct-stat"><span>总积分</span><strong id="wbs-acct-total">-</strong></div>' +
        '</div>' +
        '<div class="wbs-acct-actions">' +
        '<button class="wbs-acct-io" type="button" data-act="export" title="输入密码后导出全部账号备份">' + EXPORT_ICON + '<span>导出</span></button>' +
        '<button class="wbs-acct-io" type="button" data-act="import" title="从加密导出文件导入账号备份">' + IMPORT_ICON + '<span>导入</span></button>' +
        '</div>' +
        '</div>' +
        '<div class="wbs-acct-list"></div>' +
        '<button class="wbs-logout-btn" type="button" data-act="logout">' + LOGOUT_SVG + '<span>登录新账号</span></button>' +
        '<input type="file" id="wbs-import-file" accept=".json,application/json" style="display:none">';
      logoutBtn = root.querySelector('[data-act="logout"]');
      root.querySelector('[data-act="export"]').addEventListener('click', onExportAccounts);
      root.querySelector('[data-act="import"]').addEventListener('click', function () {
        root.querySelector('#wbs-import-file').click();
      });
      root.querySelector('#wbs-import-file').addEventListener('change', onImportFile);
    }

    function closeAccountPasswordModal(mask) {
      if (mask && mask.parentNode) mask.parentNode.removeChild(mask);
    }

    function openAccountPasswordModal(mode, onConfirm) {
      closeAccountPasswordModal(panel && panel.querySelector('#wbs-account-password-modal'));
      var isExport = mode === 'export';
      var mask = document.createElement('div');
      mask.className = 'wbs-panel-modal-mask';
      mask.id = 'wbs-account-password-modal';
      mask.innerHTML =
        '<div class="wbs-password-modal" role="dialog" aria-modal="true" aria-labelledby="wbs-password-title">' +
        '<div class="wbs-login-modal-title" id="wbs-password-title">' + (isExport ? '导出账号' : '导入账号') + '</div>' +
        '<label class="wbs-password-field"><span>密码' + (isExport ? '' : '（可留空）') + '</span>' +
        '<input id="wbs-account-password" type="password" autocomplete="new-password" placeholder="' + (isExport ? '请输入密码' : '新版文件请输入密码') + '"></label>' +
        '<div class="wbs-password-hint">' + (isExport ? '密码不能为空，请妥善保管。' : '导入密码可留空；旧版导出文件默认使用 workdaddy。') + '</div>' +
        '<div class="wbs-password-error" id="wbs-password-error" role="alert"></div>' +
        '<div class="wbs-modal-actions"><button class="wbs-modal-btn" type="button" id="wbs-password-cancel">取消</button>' +
        '<button class="wbs-modal-btn wbs-modal-ok" type="button" id="wbs-password-confirm">确定</button></div>' +
        '</div>';
      (panel || root).appendChild(mask);
      var input = mask.querySelector('#wbs-account-password');
      var error = mask.querySelector('#wbs-password-error');
      var confirm = mask.querySelector('#wbs-password-confirm');
      var close = function () { closeAccountPasswordModal(mask); };
      mask.querySelector('#wbs-password-cancel').addEventListener('click', close);
      mask.addEventListener('click', function (ev) { if (ev.target === mask) close(); });
      confirm.addEventListener('click', function () {
        var value = input.value;
        if (isExport && !value.trim()) {
          error.textContent = '密码不能为空';
          input.focus();
          return;
        }
        confirm.disabled = true;
        confirm.textContent = '处理中…';
        close();
        onConfirm(value);
      });
      input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') confirm.click();
        if (ev.key === 'Escape') close();
      });
      setBuildTimeout(function () { input.focus(); }, 0);
    }

    // 导出账号：密码必填，daemon 使用随机 salt 加密后触发浏览器下载。
    function onExportAccounts() {
      openAccountPasswordModal('export', function (password) {
        api('/api/accounts/export', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: password }),
        })
          .then(function (r) {
            var blob = new Blob([r.content], { type: 'application/json' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = r.filename || 'WorkDaddy-accounts.json';
            document.body.appendChild(a);
            a.click();
            setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 300);
            toast('已导出 ' + r.count + ' 个账号（已加密）', false, root);
          })
          .catch(function (e) { toast('导出失败: ' + e.message, true, root); });
      });
    }

    // 导入账号：读文件后输入密码；空密码仅对历史 workdaddy 格式有效。
    function onImportFile(ev) {
      var file = ev.target && ev.target.files && ev.target.files[0];
      ev.target.value = '';
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        var content = String(reader.result);
        openAccountPasswordModal('import', function (password) {
          api('/api/accounts/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: content, password: password }),
          })
            .then(function (r) {
              toast('成功导入 ' + r.count + ' 个账号', false, root);
              refresh();
            })
            .catch(function (e) { toast('导入失败: ' + e.message, true, root); });
        });
      };
      reader.onerror = function () { toast('读取文件失败', true, root); };
      reader.readAsText(file);
    }

    // ===== 账号同步弹窗（两步向导）=====
    // codebuddy 桌面端后端逻辑待接入；plugin 与 cli 已接入 daemon：
    //   GET /api/plugin-sync/editors（编辑器安装/插件登录态/运行状态检测）
    //   POST /api/plugin-sync（state.vscdb 凭据切换，daemon 侧以 uid 三重校验防串号）
    //   GET /api/cli/status + POST /api/cli/sync（CLI 认证文件写入，同目录同格式）
    var SYNC_TARGETS = [
      { id: 'codebuddy', label: 'CodeBuddy', desc: '同步到 CodeBuddy 桌面端，需选择国际版或国内版' },
      { id: 'cli', label: 'CodeBuddy CLI', desc: '把账号直接写入 CLI 认证文件，无需重启；下次 CLI 请求即生效' },
      { id: 'plugin', label: 'CodeBuddy 插件', desc: '同步到 Cursor / VS Code 中已安装的 CodeBuddy 插件' },
    ];

    function closeSyncModal(mask) {
      if (mask && mask.parentNode) mask.parentNode.removeChild(mask);
    }

    function openSyncModal(accountName, accountUid) {
      var panelEl = root.querySelector('.wbs-panel');
      var mask = document.createElement('div');
      mask.className = 'wbs-panel-modal-mask wbs-sync-mask';
      (panelEl || root).appendChild(mask);
      var sel = { uid: accountUid || '', target: null, sub: null, subLabel: '' };
      var escKey = function (ev) { if (ev.key === 'Escape') cleanup(); };

      function cleanup() {
        document.removeEventListener('keydown', escKey);
        closeSyncModal(mask);
      }

      // 通用选项行（复用 .wbs-login-option 视觉），group 用于互斥选择
      function optionsHtml(items, group, selectedValue) {
        return items.map(function (it) {
          var checked = selectedValue === it.value ? ' selected' : '';
          return '<label class="wbs-login-option' + checked + (it.disabled ? ' disabled' : '') + '" data-sync-group="' + group + '" data-sync-value="' + it.value + '">' +
            '<input type="radio" name="wbs-sync-' + group + '" ' + (selectedValue === it.value ? 'checked ' : '') + (it.disabled ? 'disabled ' : '') + '>' +
            '<span class="wbs-login-option-copy"><span class="wbs-login-option-title">' + it.label + '</span>' +
            (it.desc ? '<span class="wbs-login-option-desc">' + it.desc + '</span>' : '') +
            '</span></label>';
        }).join('');
      }

      function bindOptions(group, onPick) {
        mask.querySelectorAll('[data-sync-group="' + group + '"]').forEach(function (opt) {
          opt.addEventListener('click', function () {
            var input = opt.querySelector('input');
            if (input && input.disabled) return;
            mask.querySelectorAll('[data-sync-group="' + group + '"]').forEach(function (o) { o.classList.remove('selected'); });
            opt.classList.add('selected');
            input.checked = true;
            onPick(opt.getAttribute('data-sync-value'));
          });
        });
      }

      function dialogHtml(title, sub, bodyHtml, actionsHtml) {
        return '<div class="wbs-password-modal" role="dialog" aria-modal="true" aria-label="' + title + '">' +
          '<div class="wbs-login-modal-title">' + title + '</div>' +
          (sub ? '<div class="wbs-sync-sub">' + sub + '</div>' : '') +
          bodyHtml +
          '<div class="wbs-modal-actions">' + actionsHtml + '</div></div>';
      }

      // 第一步：选择同步目标
      function renderStep1() {
        sel.target = null; sel.sub = null; sel.subLabel = '';
        mask.innerHTML = dialogHtml(
          '同步账号',
          '将「' + esc(accountName) + '」的登录态同步到：',
          '<div class="wbs-sync-options">' + optionsHtml(SYNC_TARGETS.map(function (t) { return { value: t.id, label: t.label, desc: t.desc }; }), 'target', null) + '</div>',
          '<button class="wbs-modal-btn" type="button" data-sync-act="cancel">取消</button>' +
          '<button class="wbs-modal-btn wbs-modal-ok" type="button" data-sync-act="next" disabled>下一步</button>'
        );
        bindOptions('target', function (v) {
          sel.target = v;
          var next = mask.querySelector('[data-sync-act="next"]');
          if (next) next.disabled = false;
        });
        mask.querySelector('[data-sync-act="cancel"]').addEventListener('click', cleanup);
        mask.querySelector('[data-sync-act="next"]').addEventListener('click', function () {
          if (!sel.target) return;
          renderStep2();
        });
      }

      // 拉取 CodeBuddy CLI 当前认证状态，更新 cli 步骤的提示文案
      function loadCliStatus() {
        api('/api/cli/status').then(function (d) {
          if (!mask.isConnected) return;
          var box = mask.querySelector('#wbs-cli-status-loading');
          if (!box) return;
          var parts = [];
          if (d.loggedOut) {
            parts.push('CLI 当前处于登出状态（存在 .logged-out 标记），同步时会自动清理标记并写入认证文件。');
          } else if (d.configured && d.activeUid && d.activeNickname) {
            parts.push('当前 CLI 账号：' + esc(d.activeNickname) + '。');
          } else if (d.configured) {
            parts.push('CLI 已配置认证文件，但当前未识别到账号。');
          } else {
            parts.push('CLI 尚未配置认证文件，将自动创建。');
          }
          parts.push('点击「完成」把 CLI 切到「' + esc(accountName) + '」，认证文件写入后下次 CLI 请求即生效。');
          box.innerHTML = parts.join(' ');
        }).catch(function (e) {
          if (!mask.isConnected) return;
          var box = mask.querySelector('#wbs-cli-status-loading');
          if (box) {
            box.textContent = '检查 CLI 状态失败：' + (e.message || e);
            box.style.color = 'var(--wb-color-text-warning, #c77b30)';
          }
        });
      }

      // 拉取编辑器检测列表并渲染为 plugin 步骤的选项（不可用项禁用但保留说明）
      function loadSyncEditors() {
        api('/api/plugin-sync/editors').then(function (d) {
          if (!mask.isConnected) return; // 弹窗已关闭
          var editors = (d && d.editors) || [];
          var loadingEl = mask.querySelector('#wbs-sync-editors-loading');
          var boxEl = mask.querySelector('#wbs-sync-editors');
          if (!boxEl) return;
          if (!editors.length) {
            if (loadingEl) loadingEl.textContent = '未检测到可用编辑器：请先安装 Cursor 或 VS Code，并在其中登录一次 CodeBuddy 插件。';
            return;
          }
          var items = editors.map(function (ed) {
            var desc;
            if (!ed.platformSupported) desc = '当前系统暂不支持';
            else if (!ed.installed) desc = '未安装';
            else if (!ed.hasPluginSecret) desc = '未检测到 CodeBuddy 插件登录记录，请先在编辑器内登录一次';
            else if (ed.running) desc = '正在运行，需完全退出后才能同步';
            else desc = '已就绪';
            return {
              value: ed.id,
              label: ed.label,
              desc: desc,
              disabled: !ed.platformSupported || !ed.installed || !ed.hasPluginSecret,
            };
          });
          boxEl.innerHTML = optionsHtml(items, 'sub', null);
          if (loadingEl) loadingEl.style.display = 'none';
          boxEl.style.display = '';
          bindOptions('sub', function (v) {
            sel.sub = v;
            var picked = items.filter(function (x) { return x.value === v; })[0];
            sel.subLabel = picked ? picked.label : '';
            var finish = mask.querySelector('[data-sync-act="finish"]');
            if (finish) finish.disabled = false;
          });
        }).catch(function (e) {
          if (!mask.isConnected) return;
          var loadingEl = mask.querySelector('#wbs-sync-editors-loading');
          if (loadingEl) loadingEl.textContent = '编辑器检测失败: ' + (e.message || e);
        });
      }

      // 第二步：按目标分流 —— codebuddy 选版本 / cli 直接切换 / plugin 选编辑器（异步检测）
      function renderStep2() {
        var title = '同步账号';
        var sub = '同步目标：' + (SYNC_TARGETS.filter(function (t) { return t.id === sel.target; })[0] || {}).label;
        var bodyHtml = '';
        var needPick = true;
        if (sel.target === 'codebuddy') {
          bodyHtml = '<div class="wbs-sync-options">' + optionsHtml([
            { value: 'intl', label: '国际版', desc: '同步到 CodeBuddy 国际版（workbuddy-ai）' },
            { value: 'cn', label: '国内版', desc: '同步到 CodeBuddy 国内版' },
          ], 'sub', null) + '</div>';
        } else if (sel.target === 'cli') {
          // CLI 无需二次选择：直接进入切换逻辑，先检查当前 CLI 认证状态
          needPick = false;
          sel.sub = 'cli';
          bodyHtml = '<div class="wbs-password-hint" id="wbs-cli-status-loading">正在检查 CodeBuddy CLI 当前账号…</div>';
        } else {
          bodyHtml = '<div class="wbs-password-hint" id="wbs-sync-editors-loading">正在检测已安装的编辑器…</div>' +
            '<div class="wbs-sync-options" id="wbs-sync-editors" style="display:none"></div>';
        }
        mask.innerHTML = dialogHtml(
          title, sub, bodyHtml,
          '<button class="wbs-modal-btn" type="button" data-sync-act="back">上一步</button>' +
          '<button class="wbs-modal-btn wbs-modal-ok" type="button" data-sync-act="finish"' + (needPick ? ' disabled' : '') + '>完成</button>'
        );
        if (needPick && sel.target !== 'plugin') {
          bindOptions('sub', function (v) {
            sel.sub = v;
            sel.subLabel = v === 'intl' ? '国际版' : '国内版';
            var finish = mask.querySelector('[data-sync-act="finish"]');
            if (finish) finish.disabled = false;
          });
        }
        if (sel.target === 'plugin') loadSyncEditors();
        if (sel.target === 'cli') loadCliStatus();
        mask.querySelector('[data-sync-act="back"]').addEventListener('click', renderStep1);
        mask.querySelector('[data-sync-act="finish"]').addEventListener('click', function () {
          if (needPick && !sel.sub) return;
          finishSync();
        });
      }

      // 完成：plugin 与 cli 调 daemon 同步接口；codebuddy 桌面端后端逻辑仍待接入
      function finishSync() {
        var targetLabel = (SYNC_TARGETS.filter(function (t) { return t.id === sel.target; })[0] || {}).label || sel.target;
        if (sel.target === 'plugin') {
          var finishBtn = mask.querySelector('[data-sync-act="finish"]');
          var backBtn = mask.querySelector('[data-sync-act="back"]');
          if (finishBtn) { finishBtn.disabled = true; finishBtn.textContent = '同步中…'; }
          if (backBtn) backBtn.disabled = true;
          api('/api/plugin-sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uid: sel.uid, editor: sel.sub }),
          })
            .then(function (r) {
              cleanup();
              toast('已同步到 ' + (r.label || sel.subLabel) + '：' + (r.nickname || '账号') + '，打开编辑器即可使用', false, root);
            })
            .catch(function (e) {
              if (finishBtn) { finishBtn.disabled = false; finishBtn.textContent = '完成'; }
              if (backBtn) backBtn.disabled = false;
              toast('同步失败: ' + (e.message || e), true, root);
            });
          return;
        }
        if (sel.target === 'cli') {
          var cliFinish = mask.querySelector('[data-sync-act="finish"]');
          var cliBack = mask.querySelector('[data-sync-act="back"]');
          if (cliFinish) { cliFinish.disabled = true; cliFinish.textContent = '同步中…'; }
          if (cliBack) cliBack.disabled = true;
          api('/api/cli/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uid: sel.uid }),
          })
            .then(function (r) {
              cleanup();
              toast('已切换 CodeBuddy CLI 为 ' + (r.activeNickname || '账号') + '；认证文件已写入，下次 CLI 请求即生效', false, root);
            })
            .catch(function (e) {
              if (cliFinish) { cliFinish.disabled = false; cliFinish.textContent = '完成'; }
              if (cliBack) cliBack.disabled = false;
              toast('同步失败: ' + (e.message || e), true, root);
            });
          return;
        }
        var subLabel = sel.target === 'codebuddy' ? (sel.sub === 'intl' ? '国际版' : '国内版') : '';
        cleanup();
        // TODO(backend): codebuddy 桌面端的同步接口，携带 { uid, target: sel.target, sub: sel.sub }
        toast('已发起同步：' + targetLabel + (subLabel ? ' · ' + subLabel : '') + '（后端逻辑待接入）', false, root);
      }

      mask.addEventListener('click', function (ev) { if (ev.target === mask) cleanup(); });
      document.addEventListener('keydown', escKey);
      renderStep1();
    }

    // ===== Tab 切换 =====
    function switchTab(name) {
      var tabs = root.querySelectorAll('.wbs-tab');
      var panes = root.querySelectorAll('.wbs-pane');
      for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('active', tabs[i].getAttribute('data-tab') === name);
      for (var j = 0; j < panes.length; j++) panes[j].classList.toggle('active', panes[j].getAttribute('data-pane') === name);
      if (name === 'theme') { if (themePane && !themePane.dataset.built) buildThemePane(); loadWallpapers(); }
      if (name === 'sessions' && sessionsPane && !sessionsPane.dataset.built) buildSessionsPane();
      if (name === 'models' && modelsPane && !modelsPane.dataset.built) buildModelsPane();
      if (name === 'enhance' && enhancePane && !enhancePane.dataset.built) buildEnhancePane();
      if (name === 'pc' && pcPane && !pcPane.dataset.built) buildPcPane();
      if (name === 'about' && aboutPane && !aboutPane.dataset.built) buildAboutPane();
    }
    var tabBtns = root.querySelectorAll('.wbs-tab');
    for (var ti = 0; ti < tabBtns.length; ti++) {
      (function (btn) {
        btn.addEventListener('click', function () { switchTab(btn.getAttribute('data-tab')); });
      })(tabBtns[ti]);
    }

    // ===== 会话 pane（构建：账号/时间筛选 + 按空间分组[默认2条/展开10条] + 刷新 + 批量操作[迁移/删除]）=====
    var sessionsState = { uid: undefined, range: '7d', list: [], selected: {}, wsExpanded: {}, accounts: [], batchMode: false, autoCopy: null };
    function isTaskSessionRecordUI(cwd) {
      // WorkBuddy 的普通工作区也使用 WorkBuddy\\YYYY-MM-DD-HH-MM-SS；仅凭 cwd 无法可靠区分任务会话。
      return false;
    }
    function canonicalWorkspaceUI(cwd) {
      var value = String(cwd || '').trim().replace(/\\/g, '/');
      if (!value) return '';
      value = value.replace(/\/+/g, '/');
      var parts = value.split('/');
      var out = [];
      parts.forEach(function (part) {
        if (!part || part === '.') return;
        if (part === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); return; }
        out.push(part);
      });
      value = (value.charAt(0) === '/' ? '/' : '') + out.join('/');
      if (value.length > 1) value = value.replace(/\/+$/, '');
      return value;
    }
    var SESS_WS_INIT = 2;    // 每个空间默认显示条数
    var SESS_WS_STEP = 10;   // 展开一次追加条数
    function buildSessionsPane() {
      if (!sessionsPane) return;
      sessionsPane.dataset.built = '1';
      sessionsPane.innerHTML =
        '<div class="wbs-pcard">' +
        '<div class="wbs-sess-filters">' +
        '<div class="wbs-sess-filter-row"><span class="wbs-sess-flabel">账号</span><select class="wbs-sess-select" id="wbs-sess-account-select" title="选择要查看的账号"><option value="">加载中…</option></select></div>' +
        '<div class="wbs-sess-filter-row"><span class="wbs-sess-flabel">时间</span><div class="wbs-sess-seg" id="wbs-sess-range-seg">' +
        '<button class="wbs-sess-seg-btn" type="button" data-range="today">今天</button>' +
        '<button class="wbs-sess-seg-btn active" type="button" data-range="7d">近 7 天</button>' +
        '<button class="wbs-sess-seg-btn" type="button" data-range="30d">近 30 天</button>' +
        '<button class="wbs-sess-seg-btn" type="button" data-range="all">全部</button>' +
        '</div></div>' +
        '</div>' +
        '<div class="wbs-sess-toolbar">' +
        '<button class="wbs-sess-bbtn" type="button" id="wbs-sess-batch">批量操作</button>' +
        '<span class="wbs-sess-count" id="wbs-sess-count"></span>' +
        '<button class="wbs-sess-refresh" type="button" id="wbs-sess-refresh" title="刷新并折叠所有空间"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg></button>' +
        '</div>' +
        '<div class="wbs-sess-batchbar" id="wbs-sess-batchbar" style="display:none">' +
        '<button class="wbs-sess-bbtn wbs-sess-check-toggle" type="button" id="wbs-sess-check-all" title="全部勾选/清空勾选"><span class="wbs-sess-check-ico" data-state="unchecked"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/></svg></span><span class="wbs-sess-check-label">全选</span></button>' +
        '<button class="wbs-sess-bbtn" type="button" id="wbs-sess-copy" title="复制选中到其他账号"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><span>复制</span></button>' +
        '<button class="wbs-sess-bbtn wbs-sess-delbtn" type="button" id="wbs-sess-delete" title="删除选中"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg><span>删除</span></button>' +
        '<button class="wbs-sess-bbtn wbs-sess-done" type="button" id="wbs-sess-done">取消</button>' +
        '</div>' +
        '<div class="wbs-sess-list" id="wbs-sess-list"></div>' +
        '</div>' +
        '<div class="wbs-modal-mask" id="wbs-sess-modal" style="display:none">' +
        '<div class="wbs-modal">' +
        '<div class="wbs-modal-title" id="wbs-sess-modal-title">操作会话</div>' +
        '<div class="wbs-modal-body" id="wbs-sess-modal-body"></div>' +
        '<div class="wbs-modal-actions">' +
        '<button class="wbs-modal-btn" type="button" id="wbs-sess-modal-cancel">取消</button>' +
        '<button class="wbs-modal-btn wbs-modal-ok" type="button" id="wbs-sess-modal-ok">确定</button>' +
        '</div>' +
        '</div>' +
        '</div>';
      wireSessionsPane();
      loadSessionAccounts();
      loadSessions();
    }

    // 加载账号下拉（当前账号 + 全部备份账号 + 全部账号）
    function loadSessionAccounts() {
      var sel = sessionsPane.querySelector('#wbs-sess-account-select');
      if (!sel) return;
      api('/api/accounts').then(function (d) {
        var accts = (d && d.accounts) || [];
        sessionsState.accounts = accts;
        var curUid = (d && d.current && d.current.uid) || '';
        var curName = '当前账号';
        for (var i = 0; i < accts.length; i++) if (accts[i].uid === curUid) curName = accts[i].nickname || curName;
        var html = '<option value="">' + esc(curName) + '</option>';
        accts.forEach(function (a) {
          if (a.uid === curUid) return;
          html += '<option value="' + a.uid + '">' + esc(a.nickname || '账号' + a.uid.slice(0, 4)) + '</option>';
        });
        html += '<option value="*">全部账号</option>';
        sel.innerHTML = html;
        // 恢复当前筛选：uid=undefined(当前账号,value="") / ''(全部,value="*") / 具体 uid
        sel.value = sessionsState.uid === '' ? '*' : (sessionsState.uid || '');
        sel.addEventListener('change', function () {
          var v = sel.value;
          // 约定：空字符串=当前账号(不传 uid)，星号→传空串=全部账号
          sessionsState.uid = (v === '') ? undefined : (v === '*' ? '' : v);
          sessionsState.selected = {};
          loadSessions();
        });
      }).catch(function () {});
    }

    function loadSessions() {
      if (!sessionsPane) return;
      var listEl = sessionsPane.querySelector('#wbs-sess-list');
      if (!listEl) return;
      listEl.innerHTML = '<div class="wbs-empty">加载中…</div>';
      // uid: undefined=当前账号(不传)，''=全部账号，具体值=指定账号
      var url = '/api/sessions?range=' + (sessionsState.range || '7d');
      if (sessionsState.uid !== undefined) url += '&uid=' + encodeURIComponent(sessionsState.uid);
      api(url).then(function (d) {
        // cwd 的时间戳路径同时用于普通工作区，不能据此隐藏会话；所有记录先保留给用户查看和操作。
        sessionsState.list = ((d && d.sessions) || []).filter(function (s) { return !isTaskSessionRecordUI(s.cwd); });
        sessionsState.autoCopy = (d && d.autoCopy) || null;
        sessionsState.selected = {};
        sessionsState.wsExpanded = {};
        renderSessions();
        // 筛选变化后退出批量模式（勾选框隐藏 + 恢复「批量操作」入口）
        if (sessionsState.batchMode) {
          sessionsState.batchMode = false;
          var bar = sessionsPane.querySelector('#wbs-sess-batchbar');
          if (bar) bar.style.display = 'none';
          var bb = sessionsPane.querySelector('#wbs-sess-batch');
          if (bb) { bb.style.display = ''; bb.classList.remove('active'); }
        }
        updateSessCount();
      }).catch(function (e) {
        listEl.innerHTML = '<div class="wbs-empty">会话加载失败: ' + (e.message || e) + '</div>';
      });
    }

    // 按空间分组渲染：每个空间最多显示 INIT 条 + 展开按钮（每次 +STEP）。
    function renderSessions() {
      var listEl = sessionsPane.querySelector('#wbs-sess-list');
      var countEl = sessionsPane.querySelector('#wbs-sess-count');
      if (!listEl) return;
      if (!sessionsState.list.length) {
        listEl.innerHTML = '<div class="wbs-empty">当前筛选下没有会话</div>';
        if (countEl) countEl.textContent = '0 个会话';
        return;
      }
      function canEditAutoCopy(uid) { return sessionsState.uid !== '' && !!uid; }
      function autoCopyButton(kind, key, uid, enabled, inherited) {
        if (!canEditAutoCopy(uid)) return '';
        var title = inherited ? '随空间自动复制' : (enabled ? '取消自动复制' : '切换账号时自动复制');
        var disabled = inherited ? ' disabled' : '';
        return '<button class="wbs-sess-auto' + (enabled ? ' active' : '') + (inherited ? ' inherited' : '') + '" type="button" data-auto-kind="' + kind + '" data-auto-key="' + escAttr(key) + '" data-auto-uid="' + escAttr(uid) + '" aria-label="' + escAttr(title) + '" title="' + escAttr(title) + '" aria-pressed="' + (enabled ? 'true' : 'false') + '"' + disabled + '><span class="wbs-sess-auto-label">自动复制</span><span class="wbs-sess-auto-switch' + (enabled ? ' on' : '') + '" aria-hidden="true"><span></span></span></button>';
      }
      var tasks = [];
      var groups = {};
      var wsOrder = [];
      sessionsState.list.forEach(function (s) {
        if (isTaskSessionRecordUI(s.cwd)) { tasks.push(s); return; }
        var cwd = s.cwd || '(未指定空间)';
        var owner = String(s.user_id || sessionsState.uid || '');
        var groupKey = owner + '::' + cwd;
        if (!groups[groupKey]) { groups[groupKey] = { cwd: cwd, uid: owner, items: [] }; wsOrder.push(groupKey); }
        groups[groupKey].items.push(s);
      });
      var total = sessionsState.list.length;
      var html = '';
      var batch = sessionsState.batchMode;
      if (tasks.length) {
        var taskKey = '__TASKS__';
        var taskShown = (sessionsState.wsExpanded[taskKey] || SESS_WS_INIT);
        var taskVis = tasks.slice(0, taskShown);
        var taskMore = tasks.length - taskVis.length;
        html += '<div class="wbs-sess-group wbs-sess-tasks">' +
          '<div class="wbs-sess-group-head">' +
          '<span class="wbs-sess-group-name" title="未选择项目的会话"><span class="wbs-sess-group-type">任务</span></span>' +
          '<span class="wbs-sess-group-count">' + tasks.length + '</span>' +
          '</div>';
        taskVis.forEach(function (s) {
          var title = s.custom_title || s.title || '(无标题)';
          html += '<div class="wbs-sess-row">' +
            '<span class="wbs-sess-main"><span class="wbs-sess-title">' + esc(title) + '</span>' +
            '<span class="wbs-sess-meta">' + fmtHumanTime(s.last_activity_at || s.updated_at || s.created_at) + '</span></span>' +
            '</div>';
        });
        if (taskMore > 0) html += '<button class="wbs-sess-more" type="button" data-ws="__TASKS__">展开 ' + Math.min(taskMore, SESS_WS_STEP) + ' 条（剩余 ' + taskMore + '）</button>';
        html += '</div>';
      }
      wsOrder.forEach(function (groupKey) {
        var group = groups[groupKey];
        var arr = group.items;
        var shown = (sessionsState.wsExpanded[groupKey] || SESS_WS_INIT);
        var vis = arr.slice(0, shown);
        var more = arr.length - vis.length;
        var checkedAll = arr.every(function (s) { return sessionsState.selected[s.id]; });
        var workspaceMarked = arr.some(function (s) { return !!s.autoCopyWorkspace; });
        var autoWorkspace = group.cwd === '(未指定空间)' ? '' : autoCopyButton('workspace', group.cwd, group.uid, workspaceMarked, false);
        html += '<div class="wbs-sess-group">' +
          '<div class="wbs-sess-group-head">' +
          (batch ? '<input type="checkbox" class="wbs-ws-check" data-ws="' + escAttr(groupKey) + '"' + (checkedAll ? ' checked' : '') + '>' : '') +
          '<span class="wbs-sess-group-name" title="' + escAttr(group.cwd) + '"><span class="wbs-sess-group-type">空间</span>' + esc(shortWs(group.cwd)) + '</span>' +
          (batch ? '' : autoWorkspace) +
          '<span class="wbs-sess-group-count">' + arr.length + '</span>' +
          '</div>';
        vis.forEach(function (s) {
          var title = s.custom_title || s.title || '(无标题)';
          var sel = sessionsState.selected[s.id] ? ' checked' : '';
          var inherited = !!s.autoCopyWorkspace;
          var marked = !!s.autoCopySession || inherited;
          html += '<div class="wbs-sess-row">' +
            (batch ? '<input type="checkbox" class="wbs-sess-check" data-id="' + escAttr(s.id) + '"' + sel + '>' : '') +
            '<span class="wbs-sess-main"><span class="wbs-sess-title">' + esc(title) + '</span>' +
            '<span class="wbs-sess-meta">' + fmtHumanTime(s.last_activity_at || s.updated_at || s.created_at) + '</span></span>' +
            (batch ? '' : autoCopyButton('session', s.id, s.user_id, marked, inherited)) +
            '</div>';
        });
        if (more > 0) html += '<button class="wbs-sess-more" type="button" data-ws="' + escAttr(groupKey) + '">展开 ' + Math.min(more, SESS_WS_STEP) + ' 条（剩余 ' + more + '）</button>';
        html += '</div>';
      });
      listEl.innerHTML = html;
      updateSessionSummary(countEl);
      bindSessEvents(listEl);
    }
    function activeAutoCopyCount() {
      return sessionsState.list.filter(function (s) {
        return !isTaskSessionRecordUI(s.cwd) && (!!s.autoCopySession || !!s.autoCopyWorkspace);
      }).length;
    }
    function updateSessionSummary(countEl) {
      if (!countEl) return;
      countEl.innerHTML = '<span class="wbs-sess-summary-tag">共 ' + sessionsState.list.length + ' 个会话</span>' +
        '<span class="wbs-sess-summary-tag wbs-sess-summary-auto">自动复制 ' + activeAutoCopyCount() + '</span>';
    }
    function shortWs(w) {
      var parts = String(w || '').replace(/\\/g, '/').split('/').filter(Boolean);
      return parts.length >= 2 ? parts.slice(-2).join('/') : w;
    }
    // 会话列表内事件委托
    function bindSessEvents(listEl) {
      listEl.onclick = function (e) {
        var t = e.target;
        var autoBtn = t.closest ? t.closest('.wbs-sess-auto') : null;
        if (autoBtn) {
          e.preventDefault();
          e.stopPropagation();
          if (autoBtn.disabled) return;
          toggleAutoCopyRule(autoBtn.getAttribute('data-auto-kind'), autoBtn.getAttribute('data-auto-key'), autoBtn.getAttribute('data-auto-uid'), autoBtn.getAttribute('aria-pressed') !== 'true');
          return;
        }
        // 空间/任务勾选
        var wsCheck = t.closest ? t.closest('.wbs-ws-check') : null;
        if (wsCheck) {
          var w = wsCheck.getAttribute('data-ws');
          var arr = sessionsState.list.filter(function (s) {
            return !isTaskSessionRecordUI(s.cwd) && String(s.user_id || sessionsState.uid || '') + '::' + (s.cwd || '(未指定空间)') === w;
          });
          var on = wsCheck.checked;
          arr.forEach(function (s) { sessionsState.selected[s.id] = on; });
          renderSessions();
          updateSessCount(); // 组头全选后同步刷新计数与「复制/删除」按钮显隐
          return;
        }
        // 展开按钮
        var more = t.closest ? t.closest('.wbs-sess-more') : null;
        if (more) {
          var w2 = more.getAttribute('data-ws');
          sessionsState.wsExpanded[w2] = (sessionsState.wsExpanded[w2] || SESS_WS_INIT) + SESS_WS_STEP;
          renderSessions();
          return;
        }
        // 单条勾选
        var check = t.closest ? t.closest('.wbs-sess-check') : null;
        if (check) {
          sessionsState.selected[check.getAttribute('data-id')] = check.checked;
          updateSessCount();
        }
      };
      listEl.querySelectorAll('.wbs-sess-check').forEach(function (c) {
        c.addEventListener('change', function () {
          sessionsState.selected[this.getAttribute('data-id')] = this.checked;
          updateSessCount();
        });
      });
    }
    function toggleAutoCopyRule(kind, key, uid, enabled) {
      if (!kind || !key || !uid) return;
      var listEl = sessionsPane.querySelector('#wbs-sess-list');
      var snapshot = sessionsState.list.map(function (s) {
        return { id: s.id, autoCopySession: !!s.autoCopySession, autoCopyWorkspace: !!s.autoCopyWorkspace };
      });
      var oldAutoCopy = sessionsState.autoCopy;
      var changedKey = kind === 'workspace' ? canonicalWorkspaceUI(key) : String(key);
      sessionsState.list.forEach(function (s) {
        if (kind === 'session' && String(s.id) === changedKey && String(s.user_id || '') === String(uid)) s.autoCopySession = enabled;
        if (kind === 'workspace' && canonicalWorkspaceUI(s.cwd) === changedKey) s.autoCopyWorkspace = enabled;
      });
      updateAutoCopyButtons(listEl);
      api('/api/sessions/auto-copy', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ uid: uid, kind: kind, key: key, enabled: enabled }),
      }).then(function (response) {
        if (response && response.rules) sessionsState.autoCopy = response.rules;
        toast(enabled ? '已开启切换账号时自动复制' : '已关闭自动复制', false, root);
        updateSessCount();
      }).catch(function (e) {
        sessionsState.list.forEach(function (s) {
          var previous = snapshot.find(function (x) { return x.id === s.id; });
          if (previous) { s.autoCopySession = previous.autoCopySession; s.autoCopyWorkspace = previous.autoCopyWorkspace; }
        });
        sessionsState.autoCopy = oldAutoCopy;
        updateAutoCopyButtons(listEl);
        toast('自动复制设置失败: ' + (e.message || e), true, root);
      });
    }
    function updateAutoCopyButtons(listEl) {
      if (!listEl) return;
      listEl.querySelectorAll('.wbs-sess-auto').forEach(function (button) {
        var kind = button.getAttribute('data-auto-kind');
        var key = button.getAttribute('data-auto-key') || '';
        var uid = button.getAttribute('data-auto-uid') || '';
        var state = false;
        var inherited = false;
        if (kind === 'workspace') {
          state = sessionsState.list.some(function (s) { return canonicalWorkspaceUI(s.cwd) === canonicalWorkspaceUI(key) && !!s.autoCopyWorkspace; });
        } else {
          var session = sessionsState.list.find(function (s) { return String(s.id) === String(key) && String(s.user_id || '') === String(uid); });
          if (session) {
            inherited = !!session.autoCopyWorkspace;
            state = !!session.autoCopySession || inherited;
          }
        }
        var title = inherited ? '随空间自动复制' : (state ? '取消自动复制' : '切换账号时自动复制');
        button.classList.toggle('active', state);
        button.classList.toggle('inherited', inherited);
        button.disabled = inherited;
        button.setAttribute('aria-pressed', state ? 'true' : 'false');
        button.setAttribute('aria-label', title);
        button.setAttribute('title', title);
        var knob = button.querySelector('.wbs-sess-auto-switch');
        if (knob) knob.classList.toggle('on', state);
      });
    }
    function updateSessCount() {
      var n = sessionsState.list.filter(function (s) { return !isTaskSessionRecordUI(s.cwd) && sessionsState.selected[s.id]; }).length;
      var countEl = sessionsPane.querySelector('#wbs-sess-count');
      updateSessionSummary(countEl);
      if (countEl && sessionsState.batchMode) {
        countEl.insertAdjacentHTML('beforeend', '<span class="wbs-sess-summary-selected">已选 ' + n + '</span>');
      }
      // 未选中会话时隐藏「复制/删除」按钮（仅批量模式可见）
      var cp = sessionsPane.querySelector('#wbs-sess-copy');
      var dl = sessionsPane.querySelector('#wbs-sess-delete');
      if (cp) cp.style.display = n ? '' : 'none';
      if (dl) dl.style.display = n ? '' : 'none';
      syncCheckAllBtn();
    }
    // 全选按钮：根据当前是否全选切换图标（勾选框 空/勾选 两种状态）与文案
    function syncCheckAllBtn() {
      if (!sessionsPane) return;
      var btn = sessionsPane.querySelector('#wbs-sess-check-all');
      if (!btn) return;
      var selectable = sessionsState.list.filter(function (s) { return !isTaskSessionRecordUI(s.cwd); });
      var allSel = selectable.length > 0 && selectable.every(function (s) { return sessionsState.selected[s.id]; });
      var ico = btn.querySelector('.wbs-sess-check-ico');
      var lbl = btn.querySelector('.wbs-sess-check-label');
      if (ico) {
        if (allSel) {
          ico.setAttribute('data-state', 'checked');
          ico.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" fill="currentColor" stroke="currentColor"/><path d="M8 12l3 3 5-6" stroke="#141416" stroke-width="2.4" fill="none"/></svg>';
        } else {
          ico.setAttribute('data-state', 'unchecked');
          ico.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>';
        }
      }
      if (lbl) lbl.textContent = allSel ? '取消全选' : '全选';
    }
    function esc(t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    function escAttr(t) { return esc(t).replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
    // 人性化时间：刚刚 / x 分钟前 / x 小时前 / 昨天 / x 天前 / 日期
    function fmtHumanTime(ts) {
      if (!ts) return '-';
      var n = Number(ts);
      if (isNaN(n)) return String(ts);
      var ms = n < 1e12 ? n * 1000 : n;
      var diff = Date.now() - ms;
      var min = 60 * 1000, hour = 60 * min, day = 24 * hour;
      if (diff < min) return '刚刚';
      if (diff < hour) return Math.floor(diff / min) + ' 分钟前';
      if (diff < day) return Math.floor(diff / hour) + ' 小时前';
      if (diff < 2 * day) return '昨天';
      if (diff < 30 * day) return Math.floor(diff / day) + ' 天前';
      var d = new Date(ms);
      var p = function (x) { return String(x).padStart(2, '0'); };
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    }

    // 事件绑定（元素在 buildSessionsPane 之后才存在）
    function wireSessionsPane() {
      // 时间 Segment 组件
      var rangeSeg = sessionsPane.querySelector('#wbs-sess-range-seg');
      if (rangeSeg) {
        rangeSeg.addEventListener('click', function (e) {
          var b = e.target.closest ? e.target.closest('.wbs-sess-seg-btn') : null;
          if (!b) return;
          rangeSeg.querySelectorAll('.wbs-sess-seg-btn').forEach(function (x) { x.classList.toggle('active', x === b); });
          sessionsState.range = b.getAttribute('data-range');
          sessionsState.selected = {};
          sessionsState.wsExpanded = {};
          loadSessions();
        });
      }
      // 刷新：重新加载并折叠所有空间
      var refreshBtn = sessionsPane.querySelector('#wbs-sess-refresh');
      if (refreshBtn) {
        refreshBtn.addEventListener('click', function () {
          sessionsState.selected = {};
          sessionsState.wsExpanded = {};
          loadSessions();
        });
      }
      // 批量操作：进入批量模式（隐藏入口按钮 + 显示勾选框与操作栏）。退出通过「取消」按钮
      var batchBtn = sessionsPane.querySelector('#wbs-sess-batch');
      if (batchBtn) {
        batchBtn.addEventListener('click', function () {
          if (sessionsState.batchMode) return; // 已在批量模式：仅「取消」可退出
          sessionsState.batchMode = true;
          sessionsState.selected = {};
          batchBtn.style.display = 'none'; // 隐藏「批量操作」入口
          var bar = sessionsPane.querySelector('#wbs-sess-batchbar');
          if (bar) bar.style.display = '';
          renderSessions();
          updateSessCount();
        });
      }
      // 全部勾选/清空 toggle（多选框图标按钮）
      var checkAll = sessionsPane.querySelector('#wbs-sess-check-all');
      if (checkAll) {
        checkAll.addEventListener('click', function () {
          var selectable = sessionsState.list.filter(function (s) { return !isTaskSessionRecordUI(s.cwd); });
          var allSel = selectable.length > 0 && selectable.every(function (s) { return sessionsState.selected[s.id]; });
          sessionsState.selected = {};
          if (!allSel) selectable.forEach(function (s) { sessionsState.selected[s.id] = true; });
          renderSessions();
          updateSessCount();
        });
      }
      // 复制选中到目标账号（复制，非迁移：原会话保留）
      var copyBtn = sessionsPane.querySelector('#wbs-sess-copy');
      if (copyBtn) {
        copyBtn.addEventListener('click', function () {
          var ids = selectedSessIds();
          if (!ids.length) { toast('请先勾选要复制的会话', true, root); return; }
          openCopyModal(ids);
        });
      }
      // 删除选中（批量栏按钮）：直接弹删除确认框（真实删除，弹窗内已警示不可恢复）
      var delBtn = sessionsPane.querySelector('#wbs-sess-delete');
      if (delBtn) {
        delBtn.addEventListener('click', function () {
          var ids = selectedSessIds();
          if (!ids.length) { toast('请先勾选要删除的会话', true, root); return; }
          openDeleteModal(ids);
        });
      }
      // 取消（退出批量模式，恢复「批量操作」入口）
      var doneBtn = sessionsPane.querySelector('#wbs-sess-done');
      if (doneBtn) {
        doneBtn.addEventListener('click', function () {
          sessionsState.batchMode = false;
          sessionsState.selected = {};
          var bar = sessionsPane.querySelector('#wbs-sess-batchbar');
          if (bar) bar.style.display = 'none';
          if (batchBtn) { batchBtn.style.display = ''; batchBtn.classList.remove('active'); }
          renderSessions();
          updateSessCount();
        });
      }
      // 弹窗取消
      var cancelBtn = sessionsPane.querySelector('#wbs-sess-modal-cancel');
      if (cancelBtn) {
        cancelBtn.addEventListener('click', function () { showSessModal(false); });
      }
      var mask = sessionsPane.querySelector('#wbs-sess-modal');
      if (mask) {
        mask.addEventListener('click', function (e) { if (e.target === mask) showSessModal(false); });
      }
    }
    // 迁移弹窗：选目标账号
    // 复制弹窗：选目标账号（复制，非迁移——原会话保留）
    function openCopyModal(ids) {
      var titleEl = sessionsPane.querySelector('#wbs-sess-modal-title');
      var body = sessionsPane.querySelector('#wbs-sess-modal-body');
      var okBtn = sessionsPane.querySelector('#wbs-sess-modal-ok');
      titleEl.textContent = '复制 ' + ids.length + ' 个会话到…';
      api('/api/accounts').then(function (d) {
        var accts = (d && d.accounts) || [];
        var curUid = (d && d.current && d.current.uid) || '';
        // 选中会话当前所属账号（复制到原账号无意义，排除）
        var ownerUids = {};
        sessionsState.list.forEach(function (s) {
          if (ids.indexOf(s.id) !== -1 && s.user_id) ownerUids[s.user_id] = true;
        });
        if (!Object.keys(ownerUids).length && curUid) ownerUids[curUid] = true; // 兜底：无归属信息时排除当前账号
        var targets = accts.filter(function (a) { return !ownerUids[a.uid]; });
        if (!targets.length) {
          body.innerHTML = '<div class="wbs-empty">无可复制的目标账号（已排除会话所属账号）</div>';
        } else {
          body.innerHTML = '<select class="wbs-sess-select wbs-sess-target" id="wbs-sess-target" title="选择目标账号">' +
            '<option value="">选择目标账号…</option>' +
            targets.map(function (a) {
              return '<option value="' + a.uid + '">' + esc(a.nickname || a.uid) + (a.phone ? '（' + esc(a.phone) + '）' : '') + '</option>';
            }).join('') +
            '</select>';
        }
        showSessModal(true);
        okBtn.onclick = function () {
          var sel = body.querySelector('#wbs-sess-target');
          if (!sel || !sel.value) { toast('请选择目标账号', true, root); return; }
          api('/api/sessions/copy', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ids: ids, targetUid: sel.value }),
          }).then(function () {
            toast('已复制 ' + ids.length + ' 个会话', false, root);
            showSessModal(false);
            loadSessions();
          }).catch(function (e) {
            toast('复制失败: ' + (e.message || e), true, root);
          });
        };
      }).catch(function (e) {
        toast('加载账号失败: ' + (e.message || e), true, root);
      });
    }
    // 删除弹窗：确认框（真实删除，弹窗内警示不可恢复）
    function openDeleteModal(ids) {
      var titleEl = sessionsPane.querySelector('#wbs-sess-modal-title');
      var body = sessionsPane.querySelector('#wbs-sess-modal-body');
      var okBtn = sessionsPane.querySelector('#wbs-sess-modal-ok');
      titleEl.textContent = '删除 ' + ids.length + ' 个会话？';
      body.innerHTML = '<div class="wbs-modal-warn">删除后会话将从列表中移除，该账号下的本地消息文件将被永久删除，此操作不可恢复。</div>';
      showSessModal(true);
      okBtn.onclick = function () {
        api('/api/sessions/delete', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ids: ids }),
        }).then(function () {
          toast('已删除 ' + ids.length + ' 个会话', false, root);
          showSessModal(false);
          loadSessions();
        }).catch(function (e) {
          toast('删除失败: ' + (e.message || e), true, root);
        });
      };
    }
    function selectedSessIds() {
      return sessionsState.list.filter(function (s) { return !isTaskSessionRecordUI(s.cwd) && sessionsState.selected[s.id]; }).map(function (s) { return s.id; });
    }
    function showSessModal(show) {
      var mask = sessionsPane.querySelector('#wbs-sess-modal');
      if (mask) mask.style.display = show ? '' : 'none';
    }

    // ===== 模型 pane（当前模型 + WorkDaddy 本地备份） =====
    var modelsState = { tab: 'official', official: [], groups: [], imports: [], selected: {}, batch: false, officialError: '' };
    function buildModelsPane() {
      if (!modelsPane) return;
      modelsPane.dataset.built = '1';
      modelsPane.innerHTML =
        '<div class="wbs-pcard wbs-model-card">' +
        '<div class="wbs-model-tabs" role="tablist">' +
        '<button class="wbs-model-tab active" type="button" data-model-tab="official">当前模型<span class="wbs-model-tab-count" id="wbs-model-official-count">0</span></button>' +
        '<button class="wbs-model-tab" type="button" data-model-tab="mine">备选模型<span class="wbs-model-tab-count" id="wbs-model-mine-count">0</span></button>' +
        '</div>' +
        '<div class="wbs-model-toolbar">' +
        '<span class="wbs-model-count" id="wbs-model-count"></span>' +
        '<span class="wbs-model-imports" id="wbs-model-imports"></span>' +
        '<span class="wbs-model-toolbar-spacer"></span>' +
        '<button class="wbs-sess-bbtn" type="button" id="wbs-model-batch" style="display:none">批量管理</button>' +
        '</div>' +
        '<div class="wbs-model-batchbar" id="wbs-model-batchbar" style="display:none">' +
        '<button class="wbs-sess-bbtn wbs-model-check-all" type="button" id="wbs-model-check-all">全选</button>' +
        '<span class="wbs-model-batch-count" id="wbs-model-batch-count">已选 0</span>' +
        '<button class="wbs-sess-bbtn wbs-model-batch-action" type="button" id="wbs-model-batch-action"></button>' +
        '<button class="wbs-sess-bbtn wbs-sess-done" type="button" id="wbs-model-done">取消</button>' +
        '</div>' +
        '<div class="wbs-model-tip" id="wbs-model-tip" style="display:none"><span class="wbs-model-tip-ico">' + MODEL_TIP_SVG + '</span><strong>小贴士</strong><span>解决 WorkBuddy 不支持多个同名模型的问题。</span></div>' +
        '<div class="wbs-model-list" id="wbs-model-list"><div class="wbs-empty">加载中…</div></div>' +
        '</div>' +
        '<div class="wbs-modal-mask" id="wbs-model-confirm" style="display:none"><div class="wbs-modal"><div class="wbs-modal-title" id="wbs-model-confirm-title">确认操作</div><div class="wbs-modal-body" id="wbs-model-confirm-body"></div><div class="wbs-modal-actions"><button class="wbs-modal-btn" type="button" id="wbs-model-confirm-cancel">取消</button><button class="wbs-modal-btn wbs-modal-ok" type="button" id="wbs-model-confirm-ok">确定</button></div></div></div>' +
        '<div class="wbs-modal-mask" id="wbs-model-edit" style="display:none"><div class="wbs-modal wbs-model-edit-modal"><div class="wbs-modal-title">编辑模型</div><div class="wbs-model-edit-form"><label class="wbs-model-edit-field"><span>名称</span><input id="wbs-model-edit-name" type="text" autocomplete="off"></label><label class="wbs-model-edit-field"><span>URL</span><input id="wbs-model-edit-url" type="url" autocomplete="off"></label><label class="wbs-model-edit-field"><span>API Key</span><span class="wbs-model-secret-wrap"><input id="wbs-model-edit-key" type="password" autocomplete="off"><button class="wbs-model-eye" id="wbs-model-edit-eye" type="button" title="显示或隐藏 API Key" aria-label="显示或隐藏 API Key"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/></svg></button></span></label></div><div class="wbs-modal-actions"><button class="wbs-modal-btn" type="button" id="wbs-model-edit-cancel">取消</button><button class="wbs-modal-btn wbs-modal-ok" type="button" id="wbs-model-edit-save">保存</button></div></div></div>';
      wireModelsPane();
      loadModels();
    }
    // 前端脱敏：与后端 maskApiKey 一致。cell 列表展示短脱敏串，title 同样脱敏；编辑弹窗用明文原值
    function maskModelKey(apiKey) {
      var value = String(apiKey || '');
      if (!value) return '';
      if (value.length <= 8) return '••••••';
      var prefix = value.slice(0, Math.min(3, value.length - 8));
      return prefix + '••••' + value.slice(-4);
    }
    function modelDetailsHtml(model) {
      var url = model.url || '-';
      var masked = maskModelKey(model.apiKey);
      var key = masked || '未设置';
      return '<div class="wbs-model-details">' +
        '<div class="wbs-model-field"><span>url</span><strong class="wbs-model-url" title="' + escAttr(url) + '">' + esc(url) + '</strong></div>' +
        '<div class="wbs-model-field"><span>apiKey</span><strong class="wbs-model-key" title="' + escAttr(key) + '">' + esc(key) + '</strong></div>' +
        '</div>';
    }
    function modelRowHtml(model, options) {
      options = options || {};
      var selectionKey = options.selectionKey || '';
      var checked = selectionKey && modelsState.selected[selectionKey] ? ' checked' : '';
      var checkbox = modelsState.batch && selectionKey ? '<input class="wbs-model-check" type="checkbox" data-model-select="' + escAttr(selectionKey) + '"' + checked + '>' : '';
      // 按钮组占流固定在标题行右侧，仅 hover/focus cell 时由透明变不透明，布局与高度恒定
      var actions = options.official
        ? '<div class="wbs-model-actions">' +
          '<button class="wbs-model-icon-action" type="button" data-model-backup="' + model.index + '" title="备份" aria-label="备份">' + MODEL_BACKUP_SVG + '</button>' +
          '<button class="wbs-model-icon-action" type="button" data-model-test="' + model.index + '" title="连通测试" aria-label="连通测试">' + MODEL_TEST_SVG + '</button>' +
          '<button class="wbs-model-icon-action wbs-model-danger-action" type="button" data-model-delete-official="' + model.index + '" title="删除" aria-label="删除">' + TRASH_SVG + '</button>' +
          '</div>'
        : '<div class="wbs-model-actions">' +
          '<button class="wbs-model-icon-action" type="button" data-model-copy="' + escAttr(model.backupId) + '" title="复制" aria-label="复制">' + MODEL_COPY_SVG + '</button>' +
          '<button class="wbs-model-icon-action" type="button" data-model-edit="' + escAttr(model.backupId) + '" title="编辑" aria-label="编辑">' + MODEL_EDIT_SVG + '</button>' +
          '<button class="wbs-model-action wbs-model-enable" type="button" data-model-enable="' + escAttr(model.backupId) + '" title="启用"><span class="wbs-model-enable-icon">' + MODEL_ENABLE_SVG + '</span><span>启用</span></button>' +
          '</div>';
      var tags = '<span class="wbs-model-tag">' + esc(model.vendor || '-') + '</span>' +
        '<span class="wbs-model-tag wbs-model-tag-id" title="' + escAttr(model.id || '-') + '">' + esc(model.id || '-') + '</span>';
      return '<div class="wbs-model-row' + (options.official ? '' : ' wbs-model-backup-row') + '">' +
        '<div class="wbs-model-main">' +
        '<div class="wbs-model-title-row">' + checkbox +
        '<div class="wbs-model-name" title="' + escAttr(model.name || model.id || '') + '">' + esc(model.name || model.id || '(未命名)') + '</div>' +
        actions +
        '</div>' +
        '<div class="wbs-model-tag-row">' + tags + '</div>' +
        modelDetailsHtml(model) +
        '</div></div>';
    }
    function loadModels() {
      if (!modelsPane) return;
      var list = modelsPane.querySelector('#wbs-model-list');
      if (list) list.innerHTML = '<div class="wbs-empty">加载中…</div>';
      api('/api/models').then(function (data) {
        modelsState.official = data.official || [];
        modelsState.groups = data.backups || [];
        modelsState.imports = data.imports || [];
        modelsState.officialError = data.officialError || '';
        renderModels();
      }).catch(function (e) {
        modelsState.official = [];
        modelsState.groups = [];
        modelsState.officialError = e.message || String(e);
        if (list) list.innerHTML = '<div class="wbs-empty">模型加载失败：' + esc(e.message || e) + '</div>';
        updateModelCounts();
      });
    }
    function updateModelCounts() {
      if (!modelsPane) return;
      var officialCount = modelsPane.querySelector('#wbs-model-official-count');
      var mineCount = modelsPane.querySelector('#wbs-model-mine-count');
      var count = modelsPane.querySelector('#wbs-model-count');
      var backupCount = modelsState.groups.reduce(function (n, group) { return n + (group.items || []).length; }, 0);
      if (officialCount) officialCount.textContent = modelsState.official.length;
      if (mineCount) mineCount.textContent = backupCount;
      if (count) count.textContent = modelsState.tab === 'official' ? '共 ' + modelsState.official.length + ' 个模型' : '共 ' + backupCount + ' 个备选';
    }
    function renderModels() {
      if (!modelsPane) return;
      var list = modelsPane.querySelector('#wbs-model-list');
      if (!list) return;
      modelsPane.querySelectorAll('.wbs-model-tab').forEach(function (tab) {
        tab.classList.toggle('active', tab.getAttribute('data-model-tab') === modelsState.tab);
      });
      var batchBtn = modelsPane.querySelector('#wbs-model-batch');
      if (batchBtn) batchBtn.style.display = !modelsState.batch ? '' : 'none';
      var batchbar = modelsPane.querySelector('#wbs-model-batchbar');
      if (batchbar) batchbar.style.display = modelsState.batch ? '' : 'none';
      var tip = modelsPane.querySelector('#wbs-model-tip');
      if (tip) tip.style.display = modelsState.tab === 'mine' && !modelsState.batch ? '' : 'none';
      var imports = modelsPane.querySelector('#wbs-model-imports');
      if (imports) {
        imports.style.display = modelsState.tab === 'official' && !modelsState.batch ? '' : 'none';
        imports.innerHTML = modelsState.imports.map(function (source) {
          var disabled = source.shared ? ' disabled' : (source.available ? '' : ' disabled');
          var title = source.shared
            ? '两个 WorkBuddy 客户端共用同一份模型配置，无需导入，切换客户端即可看到模型'
            : (source.available ? '只导入当前不存在的模型，同名模型保留当前配置' : '未找到模型配置文件');
          var label = source.shared ? '模型配置已共用' : '从 ' + esc(source.name) + ' 导入';
          return '<button class="wbs-sess-bbtn wbs-model-import" type="button" data-model-import="' + escAttr(source.profileId) + '" title="' + escAttr(title) + '"' + disabled + '>' + label + '</button>';
        }).join('');
      }
      updateModelCounts();
      if (modelsState.tab === 'official') {
        if (modelsState.officialError) { list.innerHTML = '<div class="wbs-empty">当前模型加载失败：' + esc(modelsState.officialError) + '</div>'; return; }
        if (!modelsState.official.length) { list.innerHTML = '<div class="wbs-empty">当前还未添加模型</div>'; return; }
        list.innerHTML = modelsState.official.map(function (model) { return modelRowHtml(model, { official: true, selectionKey: 'official:' + model.index }); }).join('');
        updateModelBatchState();
        return;
      }
      if (!modelsState.groups.length) { list.innerHTML = '<div class="wbs-empty">还没有模型备份</div>'; return; }
      list.innerHTML = modelsState.groups.map(function (group) {
        var items = group.items || [];
        return '<div class="wbs-model-group"><div class="wbs-model-group-head"><span class="wbs-model-group-title">' + esc(group.name || '(未命名模型)') + '</span><span class="wbs-model-group-count">' + items.length + '</span></div>' + items.map(function (model) {
          return modelRowHtml(model, { selectionKey: 'backup:' + model.backupId });
        }).join('') + '</div>';
      }).join('');
      updateModelBatchState();
    }
    function updateModelBatchState() {
      if (!modelsPane) return;
      var ids = Object.keys(modelsState.selected).filter(function (id) { return modelsState.selected[id]; });
      var count = modelsPane.querySelector('#wbs-model-batch-count');
      var action = modelsPane.querySelector('#wbs-model-batch-action');
      if (count) count.textContent = '已选 ' + ids.length;
      if (action) {
        action.disabled = !ids.length;
        action.textContent = '删除选中';
      }
      var all = modelsState.tab === 'official' ? modelsState.official.map(function (m) { return 'official:' + m.index; }) : modelsState.groups.reduce(function (out, group) { return out.concat((group.items || []).map(function (m) { return 'backup:' + m.backupId; })); }, []);
      var allSelected = all.length > 0 && all.every(function (id) { return modelsState.selected[id]; });
      var checkAll = modelsPane.querySelector('#wbs-model-check-all');
      if (checkAll) checkAll.textContent = allSelected ? '取消全选' : '全选';
    }
    function showModelConfirm(title, bodyText, onConfirm) {
      var mask = modelsPane.querySelector('#wbs-model-confirm');
      var titleEl = modelsPane.querySelector('#wbs-model-confirm-title');
      var body = modelsPane.querySelector('#wbs-model-confirm-body');
      var ok = modelsPane.querySelector('#wbs-model-confirm-ok');
      var cancel = modelsPane.querySelector('#wbs-model-confirm-cancel');
      titleEl.textContent = title;
      body.textContent = bodyText;
      mask.style.display = '';
      var close = function () { mask.style.display = 'none'; ok.onclick = null; cancel.onclick = null; };
      cancel.onclick = close;
      mask.onclick = function (event) { if (event.target === mask) close(); };
      ok.onclick = function () { close(); onConfirm(); };
    }
    function wireModelsPane() {
      modelsPane.addEventListener('click', function (event) {
        var tab = event.target.closest ? event.target.closest('.wbs-model-tab') : null;
        if (tab) { modelsState.tab = tab.getAttribute('data-model-tab') || 'official'; modelsState.batch = false; modelsState.selected = {}; renderModels(); return; }
        var backup = event.target.closest ? event.target.closest('[data-model-backup]') : null;
        if (backup) {
          api('/api/models/backup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ index: Number(backup.getAttribute('data-model-backup')) }) })
            .then(function () { toast('模型已备份到「备选模型」', false, root); modelsState.tab = 'mine'; modelsState.batch = false; modelsState.selected = {}; loadModels(); })
            .catch(function (e) { toast('模型备份失败：' + (e.message || e), true, root); });
          return;
        }
        var modelImport = event.target.closest ? event.target.closest('[data-model-import]') : null;
        if (modelImport && !modelImport.disabled) {
          var importProfileId = modelImport.getAttribute('data-model-import');
          modelImport.disabled = true;
          api('/api/models/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profileId: importProfileId }) })
            .then(function (data) {
              if (data && data.shared) {
                toast('两个客户端共用同一份模型配置，无需导入', false, root);
              } else {
                var imported = (data && data.imported || []).length;
                var skipped = (data && data.skipped || []).length;
                toast('已导入 ' + imported + ' 个模型' + (skipped ? '，跳过同名模型 ' + skipped + ' 个' : ''), false, root);
              }
              loadModels();
            })
            .catch(function (e) { toast('导入模型失败：' + (e.message || e), true, root); renderModels(); });
          return;
        }
        var modelTest = event.target.closest ? event.target.closest('[data-model-test]') : null;
        if (modelTest) {
          var testIndex = Number(modelTest.getAttribute('data-model-test'));
          modelTest.disabled = true;
          api('/api/models/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ index: testIndex }) })
            .then(function (data) {
              var result = data && data.result || {};
              toast(result.message || ('接口返回 HTTP ' + (result.status || '-')), !(result.authorized), root);
            })
            .catch(function (e) { toast('连通测试失败：' + (e.message || e), true, root); })
            .finally(function () { modelTest.disabled = false; });
          return;
        }
        var officialDelete = event.target.closest ? event.target.closest('[data-model-delete-official]') : null;
        if (officialDelete) {
          var officialIndex = Number(officialDelete.getAttribute('data-model-delete-official'));
          showModelConfirm('删除当前模型？', '删除后会直接修改官方 models.json，已备份到「备选模型」的配置不会受影响。', function () {
            api('/api/models/delete-official', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ indexes: [officialIndex] }) })
              .then(function () { toast('当前模型已删除', false, root); loadModels(); })
              .catch(function (e) { toast('删除当前模型失败：' + (e.message || e), true, root); });
          });
          return;
        }
        var copy = event.target.closest ? event.target.closest('[data-model-copy]') : null;
        if (copy) {
          var copyId = copy.getAttribute('data-model-copy');
          copy.disabled = true;
          api('/api/models/copy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ backupId: copyId }) })
            .then(function () { toast('模型已复制', false, root); loadModels(); })
            .catch(function (e) { toast('复制模型失败：' + (e.message || e), true, root); copy.disabled = false; });
          return;
        }
        var edit = event.target.closest ? event.target.closest('[data-model-edit]') : null;
        if (edit) { openModelEdit(edit.getAttribute('data-model-edit')); return; }
        var enable = event.target.closest ? event.target.closest('[data-model-enable]') : null;
        if (enable) {
          var backupId = enable.getAttribute('data-model-enable');
          showModelConfirm('启用模型配置？', '这会把该备份覆盖到官方 models.json 中，同 id 的旧配置将被移除。', function () {
            enable.disabled = true;
            api('/api/models/enable', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ backupId: backupId }) })
              .then(function () { toast('模型已启用', false, root); loadModels(); })
              .catch(function (e) { toast('启用模型失败：' + (e.message || e), true, root); renderModels(); });
          });
          return;
        }
        var batch = event.target.closest ? event.target.closest('#wbs-model-batch') : null;
        if (batch) { modelsState.batch = true; modelsState.selected = {}; renderModels(); return; }
        var checkAll = event.target.closest ? event.target.closest('#wbs-model-check-all') : null;
        if (checkAll) {
          var all = modelsState.tab === 'official' ? modelsState.official.map(function (m) { return 'official:' + m.index; }) : modelsState.groups.reduce(function (out, group) { return out.concat((group.items || []).map(function (m) { return 'backup:' + m.backupId; })); }, []);
          var allSelected = all.length > 0 && all.every(function (id) { return modelsState.selected[id]; });
          all.forEach(function (id) { modelsState.selected[id] = !allSelected; });
          renderModels();
          return;
        }
        var done = event.target.closest ? event.target.closest('#wbs-model-done') : null;
        if (done) { modelsState.batch = false; modelsState.selected = {}; renderModels(); return; }
        var batchAction = event.target.closest ? event.target.closest('#wbs-model-batch-action') : null;
        if (batchAction && !batchAction.disabled) {
          var ids = Object.keys(modelsState.selected).filter(function (id) { return modelsState.selected[id]; });
          if (modelsState.tab === 'official') {
            showModelConfirm('删除当前模型？', '删除后会直接修改官方 models.json，已备份到「备选模型」的配置不会受影响。', function () {
              var indexes = ids.map(function (id) { return Number(id.slice('official:'.length)); });
              api('/api/models/delete-official', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ indexes: indexes }) })
                .then(function () { toast('已删除 ' + indexes.length + ' 个当前模型', false, root); modelsState.batch = false; modelsState.selected = {}; loadModels(); })
                .catch(function (e) { toast('删除当前模型失败：' + (e.message || e), true, root); });
            });
          } else {
            showModelConfirm('删除模型备份？', '删除后无法恢复，但不会影响官方 models.json。', function () {
              var backupIds = ids.map(function (id) { return id.slice('backup:'.length); });
              api('/api/models/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ backupIds: backupIds }) })
                .then(function (data) {
                  var deleted = Number(data && data.deleted) || 0;
                  var requested = Number(data && data.requested) || backupIds.length;
                  toast('已删除 ' + deleted + ' 个模型备份' + (deleted < requested ? '，' + (requested - deleted) + ' 个已不存在' : ''), false, root);
                  modelsState.batch = false; modelsState.selected = {}; loadModels();
                })
                .catch(function (e) { toast('删除模型备份失败：' + (e.message || e), true, root); });
            });
          }
        }
      });
      modelsPane.addEventListener('change', function (event) {
        var checkbox = event.target.closest ? event.target.closest('.wbs-model-check') : null;
        if (!checkbox) return;
        modelsState.selected[checkbox.getAttribute('data-model-select')] = checkbox.checked;
        updateModelBatchState();
      });
    }

    function findModelBackup(backupId) {
      for (var i = 0; i < modelsState.groups.length; i++) {
        var item = (modelsState.groups[i].items || []).find(function (m) { return m.backupId === backupId; });
        if (item) return item;
      }
      return null;
    }
    function openModelEdit(backupId) {
      var item = findModelBackup(backupId);
      var mask = modelsPane.querySelector('#wbs-model-edit');
      if (!item || !mask) return;
      var name = modelsPane.querySelector('#wbs-model-edit-name');
      var url = modelsPane.querySelector('#wbs-model-edit-url');
      var key = modelsPane.querySelector('#wbs-model-edit-key');
      var eye = modelsPane.querySelector('#wbs-model-edit-eye');
      var save = modelsPane.querySelector('#wbs-model-edit-save');
      var cancel = modelsPane.querySelector('#wbs-model-edit-cancel');
      name.value = item.name || item.id || '';
      url.value = item.url || '';
      key.value = item.apiKey || '';
      key.type = 'password';
      key.dataset.originalMask = item.apiKey || '';
      save.disabled = false;
      mask.style.display = '';
      var close = function () { mask.style.display = 'none'; };
      cancel.onclick = close;
      mask.onclick = function (event) { if (event.target === mask) close(); };
      eye.onclick = function () { key.type = key.type === 'password' ? 'text' : 'password'; };
      save.onclick = function () {
        var patch = { name: name.value, url: url.value };
        if (key.value !== key.dataset.originalMask) patch.apiKey = key.value;
        save.disabled = true;
        api('/api/models/edit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ backupId: backupId, patch: patch }) })
          .then(function () { close(); toast('模型已保存', false, root); loadModels(); })
          .catch(function (e) { toast('保存模型失败：' + (e.message || e), true, root); save.disabled = false; });
      };
    }

    // ===== 主题 pane（构建：主题选择 + 背景图来源切换[官方壁纸/自定义上传] + 毛玻璃 + 头像）=====
    function buildThemePane() {
      if (!themePane) return;
      themePane.dataset.built = '1';
      themePane.innerHTML =
        '<div class="wbs-pcard">' +
        '<div class="wbs-pcard-title">主题外观</div>' +
        '<div class="wbs-theme-seg" id="wbs-theme-seg">' +
        '<button class="wbs-theme-opt active" type="button" data-theme="default">WorkBuddy 默认主题</button>' +
        '<button class="wbs-theme-opt" type="button" data-theme="nebula">' + WBS_BRAND + ' 主题</button>' +
        '</div>' +
        '</div>' +
        '<div class="wbs-pcard">' +
        '<div class="wbs-pcard-title">背景与头像</div>' +
        '<div class="wbs-bg-source">' +
        '<button class="wbs-bg-src active" type="button" data-src="official">' + WBS_BRAND + ' 壁纸</button>' +
        '<button class="wbs-bg-src" type="button" data-src="custom">自定义壁纸</button>' +
        '</div>' +
        '<div class="wbs-bg-panel" data-src-panel="official">' +
        '<div class="wbs-wallpapers" id="wbs-wallpapers"><div class="wbs-wp-loading">壁纸加载中…</div></div>' +
        '</div>' +
        '<div class="wbs-bg-panel" data-src-panel="custom" style="display:none">' +
        '<div class="wbs-bg-upload" id="wbs-bg-upload" title="点击选择图片，或拖拽到此处"><span class="wbs-bg-upload-ico">+</span><span>点击或拖拽上传壁纸</span><span class="wbs-bg-upload-hint">支持 PNG / JPG / WebP，自动压缩</span></div>' +
        '<img class="wbs-bg-preview" id="wbs-bg-preview" alt="自定义壁纸预览">' +
        '<input type="file" id="wbs-theme-file" accept="image/png,image/jpeg,image/webp" style="display:none">' +
        '</div>' +
        '<div class="wbs-avatar-row">' +
        '<img class="wbs-avatar-preview" id="wbs-avatar-preview" alt="头像预览" title="点击恢复官方头像">' +
        '<button class="wbs-theme-upload" id="wbs-avatar-upload" type="button" title="上传图片替换左下角头像">更换头像</button>' +
        '<button class="wbs-theme-upload" id="wbs-avatar-reset" type="button" title="恢复 WorkBuddy 官方头像">恢复默认</button>' +
        '<input type="file" id="wbs-avatar-file" accept="image/png,image/jpeg,image/webp" style="display:none">' +
        '</div>' +
        '<div class="wbs-blur-row" id="wbs-blur-row">' +
        '<label class="wbs-blur-label" for="wbs-blur-switch">背景毛玻璃<span class="wbs-blur-hint">背景图模糊、文字清晰</span></label>' +
        '<label class="wbs-switch" title="开启后背景图呈毛玻璃模糊感"><input type="checkbox" id="wbs-blur-switch"><span class="wbs-switch-slider"></span></label>' +
        '</div>' +
        '<div class="wbs-blur-ctrl" id="wbs-blur-ctrl" style="display:none">' +
        '<label class="wbs-blur-label">模糊度</label>' +
        '<input type="range" id="wbs-blur-range" min="0" max="100" step="1" value="80">' +
        '<span class="wbs-blur-val" id="wbs-blur-val">16</span>' +
        '</div>' +
        '<div class="wbs-mask-row">' +
        '<label class="wbs-blur-label" for="wbs-mask-range">背景蒙版<span class="wbs-blur-hint">黑色半透明遮罩，压暗背景图</span></label>' +
        '<input type="range" id="wbs-mask-range" min="0" max="100" step="1" value="30">' +
        '<span class="wbs-mask-val" id="wbs-mask-val">30%</span>' +
        '</div>' +
        '</div>';
      wireThemePane();
    }
    // 增强 pane（构建：决策弹窗 + 开发者工具[默认隐藏，连点标题5次呼出]）
    function buildEnhancePane() {
      if (!enhancePane) return;
      enhancePane.dataset.built = '1';
      enhancePane.innerHTML =
        '<div class="wbs-pcard" id="wbs-no-disturb-card">' +
        '<div class="wbs-pcard-title wbs-nd-head">' +
        '<span>免打扰</span>' +
        '<span class="wbs-pcard-sub" id="wbs-nd-count"></span>' +
        '<span class="wbs-nd-all-wrap" title="一键批量开启/关闭全部免打扰开关">' +
        '<label class="wbs-switch wbs-nd-all-switch"><input type="checkbox" id="wbs-nd-all"><span class="wbs-switch-slider"></span></label>' +
        '<span class="wbs-nd-all-label">全部开</span>' +
        '</span>' +
        '</div>' +
        '<div class="wbs-nd-row">' +
        '<span class="wbs-nd-title">沙箱外写文件免确认</span>' +
        '<span class="wbs-nd-hint">工作区外文件直接读写</span>' +
        '<label class="wbs-switch" title="开启后 AI 可直接读写工作区外的文件（包括文稿、下载目录、配置），不再逐一确认"><input type="checkbox" id="wbs-nd-outside"><span class="wbs-switch-slider"></span></label>' +
        '</div>' +
        '<div class="wbs-nd-row">' +
        '<span class="wbs-nd-title">常用命令行免确认</span>' +
        '<span class="wbs-nd-hint">常用命令直接执行</span>' +
        '<label class="wbs-switch" title="开启后 npm、git、curl、python3 等常用命令直接本地执行，不再先进沙箱"><input type="checkbox" id="wbs-nd-commands"><span class="wbs-switch-slider"></span></label>' +
        '</div>' +
        '<div class="wbs-nd-row">' +
        '<span class="wbs-nd-title">大批量删除免确认</span>' +
        '<span class="wbs-nd-hint">批量删除直接进回收站</span>' +
        '<label class="wbs-switch" title="开启后批量删除不再弹确认；为防误删，所有删除强制先进废纸篓/回收站"><input type="checkbox" id="wbs-nd-bulk"><span class="wbs-switch-slider"></span></label>' +
        '</div>' +
        '<div class="wbs-nd-row">' +
        '<span class="wbs-nd-title">系统级工具放行</span>' +
        '<span class="wbs-nd-hint">系统管理命令直接执行</span>' +
        '<label class="wbs-switch" title="开启后 wsl、reg、sc、schtasks 等系统管理工具直接运行，不再确认"><input type="checkbox" id="wbs-nd-systools"><span class="wbs-switch-slider"></span></label>' +
        '</div>' +
        '<div class="wbs-nd-row">' +
        '<span class="wbs-nd-title">弹窗自动点允许</span>' +
        '<span class="wbs-nd-hint">确认弹窗自动允许</span>' +
        '<label class="wbs-switch" title="开启后仍有确认弹窗时自动替你点「允许」，所有自动批准记录在审计日志"><input type="checkbox" id="wbs-nd-auto"><span class="wbs-switch-slider"></span></label>' +
        '</div>' +
        '</div>' +
        '<div class="wbs-pcard" id="wbs-ask-card" style="display:none">' +
        '<div class="wbs-pcard-title">决策弹窗</div>' +
        '<div class="wbs-ask-row">' +
        '<label class="wbs-ask-label" for="wbs-ask-switch">用弹窗提问<span class="wbs-ask-hint">需要我决策时弹窗确认（全局生效）</span></label>' +
        '<label class="wbs-switch" title="开启后 WorkBuddy 需要你决策时会用弹窗提问（写入全局自定义指令，所有会话生效）"><input type="checkbox" id="wbs-ask-switch"><span class="wbs-switch-slider"></span></label>' +
        '</div>' +
        '</div>' +
        '<div class="wbs-pcard" id="wbs-devtools-card" style="display:none">' +
        '<div class="wbs-pcard-title">开发者工具<span class="wbs-pcard-sub">隐藏功能</span></div>' +
        '<div class="wbs-enh-row">' +
        '<button class="wbs-theme-devtools" id="wbs-theme-devtools" type="button" title="打开 Chrome DevTools（完整元素检查/控制台/网络调试）">打开 DevTools</button>' +
        '<button class="wbs-theme-inspect" id="wbs-theme-inspect" type="button" title="检查元素：点击页面任意组件，查看它的样式与颜色来源">元素检查</button>' +
        '</div>' +
        '<div class="wbs-enh-tip">连续点击面板标题「' + WBS_BRAND + '」5 次可隐藏/呼出本模块</div>' +
        '</div>';
      wireEnhancePane();
    }

    // 电脑 pane：休眠设置（从增强页迁出，单独 Tab)
    function buildPcPane() {
      if (!pcPane) return;
      pcPane.dataset.built = '1';
      pcPane.innerHTML =
        '<div class="wbs-pcard">' +
        '<div class="wbs-pcard-title">电脑休眠</div>' +
        '<div class="wbs-sleep-modes" id="wbs-sleep-modes">' +
        '<label class="wbs-sleep-mode"><input type="radio" name="wbs-sleep-mode" value="allow"><span class="wbs-sleep-mode-name">允许电脑休眠</span><span class="wbs-sleep-mode-hint">系统默认，空闲后正常休眠</span></label>' +
        '<label class="wbs-sleep-mode"><input type="radio" name="wbs-sleep-mode" value="keep"><span class="wbs-sleep-mode-name">持续禁止休眠</span><span class="wbs-sleep-mode-hint">保持唤醒，防黑屏锁屏</span></label>' +
        '<label class="wbs-sleep-mode"><input type="radio" name="wbs-sleep-mode" value="until-done"><span class="wbs-sleep-mode-name">所有任务结束后允许休眠</span><span class="wbs-sleep-mode-hint">AI 忙碌时保持唤醒，结束自动恢复</span></label>' +
        '</div>' +
        '<div class="wbs-ask-row" id="wbs-display-sleep-row" style="display:none">' +
        '<label class="wbs-ask-label" for="wbs-display-switch">允许显示器休眠<span class="wbs-ask-hint">禁止休眠时，是否允许显示器单独黑屏</span></label>' +
        '<label class="wbs-switch" title="开启后仅阻止系统睡眠，显示器可黑屏省电"><input type="checkbox" id="wbs-display-switch"><span class="wbs-switch-slider"></span></label>' +
        '</div>' +
        '</div>';
      wirePcPane();
    }

    function wirePcPane() {
      var sleepModeRadios = pcPane && pcPane.querySelectorAll('input[name="wbs-sleep-mode"]');
      if (sleepModeRadios) {
        sleepModeRadios.forEach(function (r) {
          r.addEventListener('change', function () {
            if (!this.checked) return;
            postSleepMode(this.value, displaySleepSwitch ? displaySleepSwitch.checked : false);
          });
        });
      }
      displaySleepSwitch = pcPane && pcPane.querySelector('#wbs-display-switch');
      if (displaySleepSwitch) {
        displaySleepSwitch.addEventListener('change', function () {
          var cur = getSleepMode();
          if (cur === 'allow') return; // allow 模式下无意义（该行已隐藏）
          postSleepMode(cur, this.checked);
        });
      }
      syncSleepState();
    }

    // 关于 pane：项目信息卡（名字/标语/原理徽章/介绍）+ 支持项目入口 + 版本
    function buildAboutPane() {
      if (!aboutPane) return;
      aboutPane.dataset.built = '1';
      aboutPane.innerHTML =
        '<div class="wbs-pcard wbs-about-update" id="wbs-update-card" style="display:none">' +
          '<div class="wbs-update-head">' +
            '<span class="wbs-update-dot" aria-hidden="true"></span>' +
            '<span class="wbs-update-title" id="wbs-update-title">发现新版本</span>' +
          '</div>' +
          '<div class="wbs-update-notes" id="wbs-update-notes"></div>' +
          '<div class="wbs-update-actions">' +
            '<button class="wbs-update-btn" id="wbs-update-btn" type="button">立即更新</button>' +
          '</div>' +
          '<div class="wbs-update-progress" id="wbs-update-progress" style="display:none" role="status" aria-live="polite"></div>' +
          '<div class="wbs-update-bar" id="wbs-update-bar" style="display:none;height:6px;border-radius:3px;background:color-mix(in srgb,var(--wb-button-primary-bg,#1f1f1f) 22%,transparent);overflow:hidden;margin-top:8px"><i id="wbs-update-bar-fill" style="display:block;height:100%;width:0;border-radius:3px;background:var(--wb-button-primary-bg,#1f1f1f);transition:width .6s ease"></i></div>' +
        '</div>' +
        '<div class="wbs-pcard wbs-about-hero">' +
          '<div class="wbs-about-name" id="wbs-about-name">' + WBS_BRAND + '</div>' +
          '<div class="wbs-about-tag" id="wbs-about-tag">' + (PROFILE_ID === 'workbuddy-ai' ? 'WorkBuddy AI 的多账号 · 主题 · 增强工具集' : 'WorkBuddy 的多账号 · 主题 · 增强工具集') + '</div>' +
          '<span class="wbs-about-badge" id="wbs-about-badge">本机回环 CDP 注入 · 不改官方安装包</span>' +
          '<div class="wbs-about-desc">一个基于 <b>Chrome DevTools Protocol (CDP)</b> 的 WorkBuddy 桌面端增强工具。零侵入、零重签名——只把界面组件注入到正在运行的 WorkBuddy 渲染进程里。</div>' +
          '<div class="wbs-about-support">' +
            '<span class="wbs-about-support-text">如果 WorkDaddy 对你有帮助，欢迎在 GitHub 点个 Star。你的支持会让这个小项目持续更新。</span>' +
            '<a class="wbs-about-ghbtn" id="wbs-about-repo" href="https://github.com/babygoton/WorkDaddy" target="_blank" rel="noopener" aria-label="在 GitHub 上给 WorkDaddy 点 Star" title="在 GitHub 上给 WorkDaddy 点 Star">' +
              '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M12 .3a12 12 0 0 0-3.79 23.39c.6.11.82-.26.82-.58v-2.03c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.33-1.76-1.33-1.76-1.09-.74.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.5 1 .1-.78.42-1.31.76-1.61-2.66-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.11-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6.01 0c2.29-1.55 3.3-1.23 3.3-1.23.65 1.66.24 2.88.12 3.18.77.84 1.23 1.91 1.23 3.22 0 4.61-2.81 5.62-5.49 5.92.43.37.82 1.1.82 2.22v3.29c0 .32.22.7.83.58A12 12 0 0 0 12 .3z"/></svg>' +
            '</a>' +
          '</div>' +
          '<div class="wbs-about-foot">' +
            '<span class="wbs-about-ver" id="wbs-about-ver">' + esc('') + '</span>' +
            '<a class="wbs-about-feedback" id="wbs-about-issues" href="https://github.com/babygoton/WorkDaddy/issues" target="_blank" rel="noopener" title="去 GitHub Issues 反馈问题">' +
              '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' +
              '<span>问题反馈</span>' +
            '</a>' +
          '</div>' +
        '</div>';

      // 回拉 /api/about 填充信息（失败时保留硬编码占位）
      var ver = aboutPane.querySelector('#wbs-about-ver');
      if (ver) ver.textContent = 'v' + (WBS_VERSION && WBS_VERSION.indexOf('__WBS_') !== 0 ? WBS_VERSION : '');
      api('/api/about').then(function (d) {
        if (!d || !d.ok) return;
        var el;
        el = aboutPane.querySelector('#wbs-about-name');
        if (el && d.name) el.textContent = d.name;
        el = aboutPane.querySelector('#wbs-about-tag');
        if (el && d.tagline) el.textContent = d.tagline;
        el = aboutPane.querySelector('#wbs-about-badge');
        if (el && d.principle) el.textContent = d.principle;
        el = aboutPane.querySelector('#wbs-about-ver');
        // 运行中的 daemon 注入版本是第一事实来源；旧 app 壳里的 package.json 可能滞后。
        var runtimeVersion = WBS_VERSION && WBS_VERSION.indexOf('__WBS_') !== 0 ? WBS_VERSION : d.version;
        if (el && runtimeVersion) el.textContent = 'v' + runtimeVersion;
        var repo = aboutPane.querySelector('#wbs-about-repo');
        if (repo && d.repository) repo.href = d.repository;
        var issues = aboutPane.querySelector('#wbs-about-issues');
        if (issues && d.repository) issues.href = d.repository.replace(/\/$/, '') + '/issues';
      }).catch(function () {});
      // 自动更新：检查 + 红点 + 更新卡片
      checkForUpdate();
    }

    // 自动更新 UI：查询 /api/update-check（force=1 每次面板打开都强制刷新，不受 daemon 6 小时缓存限制）
    // → 有新版则 tab 红点 + 更新卡片 → 点击走 下载→安装→自动重启
    function checkForUpdate() {
      api('/api/update-check?force=1').then(function (d) {
        if (!d || !d.hasUpdate) return; // 无更新或检查失败：不打扰
        var tab = root.querySelector('.wbs-tab[data-tab="about"]');
        if (tab) tab.classList.add('wbs-tab-dot');
        var card = aboutPane.querySelector('#wbs-update-card');
        if (!card) return;
        card.style.display = '';
        var title = aboutPane.querySelector('#wbs-update-title');
        if (title) title.textContent = '发现新版本 v' + d.latest;
        var notes = aboutPane.querySelector('#wbs-update-notes');
        if (notes) {
          var noteLines = (d.notes || '').split('\n').map(function (l) {
            return l.trim().replace(/^[-*+]\s*/, '').replace(/^#+\s*/, '');
          }).filter(function (l) {
            return l && !/^SHA-?256[:：]/i.test(l) && !/^https?:\/\//i.test(l) && !/full changelog/i.test(l);
          });
          notes.textContent = noteLines.join('\n') || '有新版本可用，点击更新。';
        }
        var btn = aboutPane.querySelector('#wbs-update-btn');
        if (btn) {
          btn.onclick = function () { startUpdate(); };
        }
      }).catch(function () {});
    }

    function updateLogTimestamp() {
      var d = new Date();
      var pad = function (n) { return String(n).padStart(2, '0'); };
      return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }
    function appendUpdateLog(prog, message) {
      if (!prog || !message) return;
      var text = String(message);
      if (prog._wbsLastLog === text) return;
      prog._wbsLastLog = text;
      prog.style.display = '';
      var line = document.createElement('div');
      line.className = 'wbs-update-log-line';
      line.textContent = updateLogTimestamp() + ' ' + text;
      prog.appendChild(line);
      while (prog.childNodes.length > 80) prog.removeChild(prog.firstChild);
      prog.scrollTop = prog.scrollHeight;
    }
    function formatDownloadRate(rate) {
      var n = Number(rate) || 0;
      if (n < 1024) return Math.round(n) + ' B/s';
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB/s';
      return (n / (1024 * 1024)).toFixed(1) + ' MB/s';
    }
    function formatDownloadEta(seconds) {
      if (seconds === null || typeof seconds === 'undefined' || !isFinite(Number(seconds))) return '剩余时间计算中';
      var s = Math.max(0, Math.round(Number(seconds)));
      if (s < 60) return '预计剩余 ' + s + ' 秒';
      var m = Math.floor(s / 60);
      var rem = s % 60;
      return '预计剩余 ' + m + ' 分 ' + rem + ' 秒';
    }
    function formatDownloadTransfer(status) {
      var rate = Number(status && status.downloadRate) || 0;
      var eta = status && status.etaSeconds;
      var parts = [];
      // 初始请求尚未收到数据时不要展示“0 B/s · 剩余时间计算中”。
      if (rate > 0) {
        parts.push(formatDownloadRate(rate));
        parts.push(formatDownloadEta(eta));
      } else if (eta !== null && typeof eta !== 'undefined' && isFinite(Number(eta))) {
        parts.push(formatDownloadEta(eta));
      }
      return parts.length ? ' · ' + parts.join(' · ') : '';
    }
    function formatUpdateFailure(value, fallback) {
      var payload = value && value.payload ? value.payload : (value && typeof value === 'object' ? value : null);
      var detail = payload && (payload.error || payload.message) || (value && value.message) || fallback || '未知错误';
      var stage = payload && payload.status;
      var stageNames = { checking: '检查', downloading: '下载', verifying: '校验', installing: '安装', rebooting: '重启' };
      var text = '更新失败' + (stage ? '（阶段：' + (stageNames[stage] || stage) + '）' : '') + '：' + detail;
      if (payload && payload.attemptId) text += '；尝试 ID：' + payload.attemptId;
      if (payload && payload.applyLog) text += '；安装日志：' + payload.applyLog;
      if (payload && payload.debugLog) text += '；诊断日志：' + payload.debugLog;
      return text;
    }

    // 点击「立即更新」：后台下载 → 轮询状态 → 安装（daemon 写脚本替换 + 自动重启）
    function startUpdate() {
      var btn = aboutPane.querySelector('#wbs-update-btn');
      var prog = aboutPane.querySelector('#wbs-update-progress');
      var card = aboutPane.querySelector('#wbs-update-card');
      if (!btn || !card) return;
      btn.disabled = true;
      btn.textContent = '更新中…';
      if (prog) { prog.innerHTML = ''; prog._wbsLastLog = ''; appendUpdateLog(prog, '正在准备更新…'); }
      api('/api/update-download', { method: 'POST' }).then(function (d) {
        if (!d.ok) throw new Error(d.error || '下载失败');
        return pollUpdateProgress(prog, btn, card);
      }).catch(function (e) {
        if (btn) { btn.disabled = false; btn.textContent = '重试更新'; }
        var failure = formatUpdateFailure(e, '更新失败');
        if (prog) appendUpdateLog(prog, failure);
        try { toast(failure, true, root); } catch (_) {}
      });
    }

    // 轮询 /api/update-status 直到下载完成 → 触发 apply → daemon 自我退出进入「重启等待」。
    // 重启期间 /api/update-status 会连接失败（daemon 已退出换文件）——这属于"正常重启"而非失败，
    // 继续重试直到新 daemon 起来并报告新版本号，才算完成。全程用分阶段文案反馈，不再一句「即将重启」了事。
    // 重启等待阶段的分阶段预估进度（替换/启动真实耗时不透明，按安装向导惯例分步推进，
    // 让用户看到进度而非一句「30~60 秒」干等；新 daemon 真正就绪后以实际版本收尾）
    var REBOOT_STEPS = [
      { t: 0,     pct: 12, text: '停止旧服务…' },
      { t: 3000,  pct: 30, text: '写入新文件…' },
      { t: 9000,  pct: 55, text: '启动新版本…' },
      { t: 16000, pct: 80, text: '连接新服务…' },
      { t: 26000, pct: 95, text: '即将完成…' },
    ];
    function pollUpdateProgress(prog, btn, card) {
      return new Promise(function (resolve, reject) {
        var rounds = 0;
        var rebooting = false;
        var rebootElapsed = 0;
        var applyStarted = false;
        var lastStatus = null;
        var bar = card ? card.querySelector('#wbs-update-bar') : null;
        var barFill = bar ? bar.querySelector('#wbs-update-bar-fill') : null;
        function renderRebootUi() {
          var text = '正在重启…';
          var pct = 95;
          for (var i = 0; i < REBOOT_STEPS.length; i++) {
            if (rebootElapsed >= REBOOT_STEPS[i].t) { text = REBOOT_STEPS[i].text; pct = REBOOT_STEPS[i].pct; }
          }
          if (rebootElapsed > 45000) { text = '启动较慢，请稍候…'; pct = 99; }
          appendUpdateLog(prog, text);
          if (bar) bar.style.display = '';
          if (barFill) barFill.style.width = pct + '%';
        }
        var timer = setInterval(function () {
          rounds++;
          api('/api/update-status').then(function (s) {
            if (!prog) return;
            if (!s) throw new Error('status-empty');
            lastStatus = s;
            if (rebooting) {
              if (rebootElapsed > 120000) {
                clearInterval(timer);
                var timeoutError = new Error('新版本服务在 120 秒内未恢复');
                timeoutError.payload = lastStatus || {};
                reject(timeoutError);
                return;
              }
              // 重启等待阶段：新 daemon 已就绪且有版本 → 完成
              var newVer = s.version;
              if (newVer && (!WBS_VERSION || WBS_VERSION.indexOf('__WBS_') === 0 || newVer !== WBS_VERSION)) {
                clearInterval(timer);
                if (bar) bar.style.display = '';
                if (barFill) barFill.style.width = '100%';
                appendUpdateLog(prog, '已升级到 v' + newVer + '，更新完成');
                if (btn) btn.textContent = '已完成';
                resolve(true);
              } else {
                rebootElapsed += 1000;
                renderRebootUi();
              }
              return;
            }
            var st = s.status;
            if (st === 'downloading' || st === 'verifying') {
              var transfer = '';
              if (st === 'downloading') {
                transfer = formatDownloadTransfer(s);
              }
              appendUpdateLog(prog, (s.message || '正在下载…') + (s.progress ? ' ' + s.progress + '%' : '') + transfer);
            } else if (st === 'installing') {
              appendUpdateLog(prog, '正在安装新版本…');
              if (btn) btn.textContent = '安装中…';
              fireApply();
            } else if (st === 'error') {
              clearInterval(timer);
              var statusError = new Error(formatUpdateFailure(s, '更新出错'));
              statusError.payload = s;
              reject(statusError);
            } else if (st === 'idle' && s.downloaded) {
              appendUpdateLog(prog, '下载完成，准备安装…');
              fireApply();
            } else if (st === 'idle' && s.hasUpdate) {
              appendUpdateLog(prog, s.message || '发现新版本，准备更新…');
            }
          }).catch(function (e) {
            // 连接断开（daemon 已退出替换文件）= 正在重启；稍等片刻再进入等待态
            if (!rebooting && rounds > 2) { appendUpdateLog(prog, '更新服务正在重启…'); enterRebootWait(); return; }
            if (rebooting) { rebootElapsed += 1000; renderRebootUi(); return; }
            clearInterval(timer); reject(new Error(formatUpdateFailure(e, '更新失败')));
          });

          function fireApply() {
            if (rebooting || applyStarted) return;
            applyStarted = true;
            api('/api/update-apply', { method: 'POST' }).then(function (r) {
              if (r && r.ok) { enterRebootWait(); }
              else { clearInterval(timer); reject(new Error(formatUpdateFailure(r, '安装失败'))); }
            }).catch(function (e2) {
              var msg = String((e2 && e2.message) || e2);
              if (/ECONNREFUSED|Failed to fetch|NetworkError|load failed/i.test(msg)) { enterRebootWait(); }
              else { clearInterval(timer); reject(new Error(formatUpdateFailure(e2, '安装失败'))); }
            });
          }

          function enterRebootWait() {
            if (rebooting) return;
            rebooting = true;
            rebootElapsed = 0;
            renderRebootUi();
            if (btn) btn.textContent = '重启中…';
          }
        }, 1000);
      });
    }

    // 主题 pane 事件绑定（元素在 buildThemePane 之后才存在，延迟到首次切换时绑定）
    function wireThemePane() {
      // 主题选择：segmented 按钮直接切换
      themePane.addEventListener('click', function (e) {
        var t = e.target;
        var segBtn = t.closest ? t.closest('.wbs-theme-opt') : null;
        if (segBtn) {
          var id = segBtn.getAttribute('data-theme');
          // 不做 active 拦截：即使当前已是该主题也强制重新应用（保证「切换到默认主题=强制浅色 / 切换到 WorkDaddy 主题=强制深色」始终生效，面板状态与真实主题不一致时也能纠正）
          themePane.querySelectorAll('.wbs-theme-opt').forEach(function (b) { b.classList.toggle('active', b === segBtn); });
          applyTheme(id).then(function () {
            toast('已应用主题「' + (id === 'default' ? 'WorkBuddy 默认主题' : WBS_BRAND + ' 主题') + '」', false, root);
          }).catch(function (er) {
            toast('应用主题失败: ' + (er.message || er), true, root);
          });
          return;
        }
        var srcBtn = t.closest ? t.closest('.wbs-bg-src') : null;
        if (srcBtn) {
          themePane.querySelectorAll('.wbs-bg-src').forEach(function (b) { b.classList.toggle('active', b === srcBtn); });
          var src = srcBtn.getAttribute('data-src');
          themePane.querySelectorAll('.wbs-bg-panel').forEach(function (p) { p.style.display = p.getAttribute('data-src-panel') === src ? '' : 'none'; });
          return;
        }
        var up = t.closest ? t.closest('#wbs-bg-upload, #wbs-theme-upload') : null;
        if (up) { var f = themePane.querySelector('#wbs-theme-file'); if (f) f.click(); return; }
        var av = t.closest ? t.closest('#wbs-avatar-upload') : null;
        if (av) { var af = themePane.querySelector('#wbs-avatar-file'); if (af) af.click(); return; }
        var rs = t.closest ? t.closest('#wbs-avatar-reset') : null;
        if (rs) {
          try { localStorage.removeItem(AVATAR_KEY); } catch (_) {}
          applyAvatar();
          toast('已恢复官方头像', false, root);
          return;
        }
        // 点击头像预览 = 应用官方头像
        var pvEl = t.closest ? t.closest('#wbs-avatar-preview') : null;
        if (pvEl) {
          try { localStorage.removeItem(AVATAR_KEY); } catch (_) {}
          applyAvatar();
          toast('已应用官方头像', false, root);
          return;
        }
      });
      themePane.addEventListener('change', function (e) {
        var t = e.target;
        if (t && t.id === 'wbs-theme-file') {
          var file = t.files && t.files[0];
          if (!file) return;
          var reader = new FileReader();
          reader.onload = function () { replaceThemeBg(reader.result); };
          reader.readAsDataURL(file);
          t.value = '';
        }
        if (t && t.id === 'wbs-avatar-file') {
          var f2 = t.files && t.files[0];
          if (!f2) return;
          var reader2 = new FileReader();
          reader2.onload = function () {
            var imgEl = new Image();
            imgEl.onload = function () {
              try {
                var size = Math.min(imgEl.width, imgEl.height);
                var c = document.createElement('canvas');
                c.width = 96; c.height = 96;
                c.getContext('2d').drawImage(imgEl, (imgEl.width - size) / 2, (imgEl.height - size) / 2, size, size, 0, 0, 96, 96);
                var dataUrl = c.toDataURL('image/webp', 0.85);
                try { localStorage.setItem(AVATAR_KEY, dataUrl); } catch (_) {}
                applyAvatar();
                toast('头像已更新 ✓', false, root);
              } catch (e) {
                toast('头像处理失败：' + String(e).slice(0, 50), true, root);
              }
            };
            imgEl.src = reader2.result;
          };
          reader2.readAsDataURL(f2);
          t.value = '';
        }
      });
      // 毛玻璃控件绑定（元素在主题 pane 构建后才存在）
      blurSwitch = themePane.querySelector('#wbs-blur-switch');
      blurRange = themePane.querySelector('#wbs-blur-range');
      blurVal = themePane.querySelector('#wbs-blur-val');
      blurRow = themePane.querySelector('#wbs-blur-row');
      blurCtrl = themePane.querySelector('#wbs-blur-ctrl');
      if (blurSwitch) {
        blurSwitch.addEventListener('change', function () {
          var enabled = this.checked;
          var px = sliderToBlur(blurRange ? blurRange.value : 80);
          saveBlur(enabled, px);
          applyBlur();
          toast(enabled ? '已开启背景毛玻璃（模糊 ' + px + 'px）' : '已关闭背景毛玻璃', false, root);
        });
      }
      if (blurRange) {
        blurRange.addEventListener('input', function () {
          var px = sliderToBlur(this.value);
          if (blurVal) blurVal.textContent = String(blurRange ? blurRange.value : blurToSlider(px)) + '%';
          if (blurSwitch && blurSwitch.checked) {
            saveBlur(true, px);
            applyBlur();
          }
        });
      }
      applyBlur(); // 同步开关/滑块状态到 UI
      loadThemes();
      // 背景蒙版滑块：拖动防抖 300ms 调 /api/mask（daemon 保存 + 重应用主题）
      var maskRange = themePane.querySelector('#wbs-mask-range');
      var maskVal = themePane.querySelector('#wbs-mask-val');
      var maskTimer = null;
      if (maskRange) {
        maskRange.addEventListener('input', function () {
          var pct = parseInt(this.value, 10) || 0;
          if (maskVal) maskVal.textContent = pct + '%';
          clearTimeout(maskTimer);
          maskTimer = setBuildTimeout(function () {
            api('/api/mask', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ opacity: pct / 100 }),
            }).catch(function (e) {
              toast('蒙版设置失败: ' + (e.message || e), true, root);
            });
          }, 300);
        });
        api('/api/mask').then(function (d) {
          if (d && typeof d.opacity === 'number') {
            var pct = Math.round(d.opacity * 100);
            maskRange.value = String(pct);
            if (maskVal) maskVal.textContent = pct + '%';
          }
        }).catch(function () {});
      }
      // 自定义背景图上传区：点击 / 拖拽
      var bgUpload = themePane.querySelector('#wbs-bg-upload');
      if (bgUpload) {
        bgUpload.addEventListener('dragover', function (e) {
          e.preventDefault();
          this.classList.add('drag');
        });
        bgUpload.addEventListener('dragleave', function () { this.classList.remove('drag'); });
        bgUpload.addEventListener('drop', function (e) {
          e.preventDefault();
          this.classList.remove('drag');
          var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
          if (!f) return;
          if (!/^image\/(png|jpe?g|webp)$/i.test(f.type)) { toast('仅支持 PNG / JPG / WebP', true, root); return; }
          var reader = new FileReader();
          reader.onload = function () { replaceThemeBg(reader.result); };
          reader.readAsDataURL(f);
        });
      }
    }
    function wireEnhancePane() {
      // 决策弹窗开关
      askSwitch = enhancePane.querySelector('#wbs-ask-switch');
      if (askSwitch) {
        askSwitch.addEventListener('change', function () {
          var enabled = this.checked;
          api('/api/ask-mode-set', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled: enabled }),
          })
            .then(function (d) {
              toast(enabled
                ? '已开启：需要你决策时 WorkBuddy 会用弹窗提问（全局生效）'
                : '已关闭：WorkBuddy 需要决策时可能改用文本询问', false, root);
            })
            .catch(function (e) {
              toast('设置失败: ' + (e.message || e), true, root);
              askSwitch.checked = !enabled;
            });
        });
      }
      syncAskSwitch();
      wireNoDisturbPane();
      // DevTools 按钮
      var devtoolsBtn = enhancePane.querySelector('#wbs-theme-devtools');
      if (devtoolsBtn) {
        devtoolsBtn.addEventListener('click', function () {
          api('/api/devtools-url').then(function (d) {
            if (d && d.ok && d.url) { window.open(d.url, '_blank'); }
            else { toast('无法打开 DevTools：' + ((d && d.error) || '未知错误'), true, root); }
          }).catch(function () {
            toast('无法打开 DevTools：daemon 不可达', true, root);
          });
        });
      }
      // 🔍 元素检查按钮（隐藏入口：连点标题 5 次呼出；按钮点击切换检查模式）
      var inspectBtn = enhancePane.querySelector('#wbs-theme-inspect');
      if (inspectBtn) {
        inspectBtn.addEventListener('click', function () { toggleInspect(); });
      }
    }

    // 官方壁纸网格：加载 /api/wallpapers，渲染缩略图，点击切换背景图
    // file:// 页面无法直接 <img src="http://...">（Electron 拦截），改为 fetch → blob → objectURL 预览
    // 面板高度固定为主题页高度：防止切 tab 时高度忽高忽低（首次主题页壁纸渲染后锁定一次）
    function lockPanelHeight() {
      if (!panel || panel.dataset.hLocked) return;
      panel.style.height = '650px';
      panel.style.maxHeight = '650px';
      panel.dataset.hLocked = '1';
      var bodyEl = panel.querySelector('.wbs-body');
      if (bodyEl) bodyEl.style.overflowY = 'auto';
    }
    function loadWallpapers() {
      var grid = root.querySelector('#wbs-wallpapers');
      if (!grid) return;
      if (grid.dataset.loaded) return;
      grid.dataset.loaded = '1';
      var base = API.replace(/\/api\/?$/, '');
      api('/api/wallpapers').then(function (d) {
        var list = d.wallpapers || [];
        if (!list.length) { grid.innerHTML = '<div class="wbs-wp-loading">暂无官方壁纸</div>'; return; }
        var html = '';
        list.forEach(function (w) {
          html +=
            '<div class="wbs-wp" data-wp="' + w.name + '" title="' + w.title + '">' +
            '<div class="wbs-wp-thumb"><img data-src="' + base + '/wallpapers/' + encodeURIComponent(w.name) + '" alt="' + w.title + '" loading="lazy"></div>' +
            '<div class="wbs-wp-badge">' + (String(w.name).replace(/\D/g, '').replace(/^0+/, '') || w.title) + '</div>' +
            '</div>';
        });
        grid.innerHTML = html;
        // 高亮当前正在使用的壁纸（daemon 按内容哈希匹配返回）
        if (d.currentWallpaper) {
          grid.querySelectorAll('.wbs-wp').forEach(function (c) {
            if (c.getAttribute('data-wp') === d.currentWallpaper) c.classList.add('active');
          });
        }
        // 面板高度固定为主题页高度：首进主题页壁纸渲染后锁定，防止切 tab 高度跳动
        lockPanelHeight();
        // 逐张 fetch → blob → objectURL 预览（no-store 防 HTTP 缓存旧图——图库重建后同名文件内容会变）
        grid.querySelectorAll('.wbs-wp-thumb img').forEach(function (im) {
          fetch(im.getAttribute('data-src'), { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.blob() : Promise.reject(new Error('HTTP ' + r.status)); })
            .then(function (blob) { im.src = URL.createObjectURL(blob); })
            .catch(function () {
              im.alt = '加载失败';
              im.style.opacity = '.25';
            });
        });
        grid.querySelectorAll('.wbs-wp').forEach(function (card) {
          card.addEventListener('click', function () {
            var name = card.getAttribute('data-wp');
            if (card.classList.contains('busy')) return;
            card.classList.add('busy');
            var target = themeSelectValue();
            api('/api/theme-bg', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ id: target, wallpaper: name }),
            }).then(function (r) {
              if (!r || !r.ok) throw new Error((r && r.error) || '切换壁纸失败');
              grid.querySelectorAll('.wbs-wp').forEach(function (c) { c.classList.remove('active'); });
              card.classList.add('active');
              toast('已应用壁纸「' + card.getAttribute('title') + '」', false, root);
            }).catch(function (e) {
              toast('切换壁纸失败: ' + (e.message || e), true, root);
            }).finally(function () { card.classList.remove('busy'); });
          });
        });
      }).catch(function () {
        grid.innerHTML = '<div class="wbs-wp-loading">壁纸加载失败（daemon 不可达）</div>';
      });
    }

    function setOpen(open) {
      state.open = open;
      panel.classList.toggle('show', open);
      fab.classList.toggle('hidden', open); // 打开时隐藏按钮
      if (open) {
        refresh();
        checkForUpdate(); // 打开面板即检测更新（每次打开都强制查一次新版本）
      } else {
        stopCheckinPolling();
        state.creditRunId++;
      }
    }

    fab.addEventListener('click', function () { setOpen(true); });
    root.querySelector('[data-act="close"]').addEventListener('click', function () { setOpen(false); });


    // 登录新账号：弹窗二选一 —— 方法一 假退出当前账号 / 方法二 无感登录
    logoutBtn.addEventListener('click', function () {
      if (this.disabled) return;
      openLoginChoice();
    });

    function closeLoginModal(mask) {
      if (mask && typeof mask.__wbsCancel === 'function') {
        var cancel = mask.__wbsCancel;
        mask.__wbsCancel = null;
        try { cancel(); } catch (_) {}
      }
      if (mask && mask.parentNode) mask.parentNode.removeChild(mask);
    }

    function openLoginChoice() {
      closeLoginModal(panel && panel.querySelector('#wbs-login-modal'));
      var mask = document.createElement('div');
      mask.className = 'wbs-panel-modal-mask';
      mask.id = 'wbs-login-modal';
      mask.innerHTML =
        '<div class="wbs-login-modal" role="dialog" aria-modal="true" aria-labelledby="wbs-login-modal-title">' +
        '<div class="wbs-login-modal-title" id="wbs-login-modal-title">选择登录方式</div>' +
        '<div class="wbs-login-body" id="wbs-login-body" role="radiogroup" aria-label="登录方式">' +
        '<label class="wbs-login-option selected" data-way="logout">' +
        '<input type="radio" name="wbs-login-way" value="logout" checked>' +
        '<span class="wbs-login-option-copy"><span class="wbs-login-option-title">假退出</span>' +
        '<span class="wbs-login-option-desc">以「不让当前账号登录身份过期」的方式切到登录页，可以登录新账号，也可以切回已登录账号</span></span>' +
        '</label>' +
        '<label class="wbs-login-option" data-way="seamless">' +
        '<input type="radio" name="wbs-login-way" value="seamless">' +
        '<span class="wbs-login-option-copy"><span class="wbs-login-option-title">无感登录</span>' +
        '<span class="wbs-login-option-desc">不退出 WorkBuddy，在浏览器完成授权后新账号自动加入列表</span></span>' +
        '</label>' +
        '</div>' +
        '<div class="wbs-modal-actions"><button class="wbs-modal-btn" type="button" id="wbs-login-cancel">取消</button>' +
        '<button class="wbs-modal-btn wbs-modal-ok" type="button" id="wbs-login-confirm">确定</button></div>' +
        '</div>';
      (panel || root).appendChild(mask);
      var body = mask.querySelector('#wbs-login-body');
      mask.querySelector('#wbs-login-cancel').addEventListener('click', function () { closeLoginModal(mask); });
      mask.addEventListener('click', function (ev) { if (ev.target === mask) closeLoginModal(mask); });

      var options = mask.querySelectorAll('.wbs-login-option');
      var syncSelected = function () {
        for (var i = 0; i < options.length; i++) {
          var input = options[i].querySelector('input');
          options[i].classList.toggle('selected', !!(input && input.checked));
        }
      };
      for (var oi = 0; oi < options.length; oi++) {
        options[oi].querySelector('input').addEventListener('change', syncSelected);
        options[oi].addEventListener('click', function () { syncSelected(); });
      }

      mask.querySelector('#wbs-login-confirm').addEventListener('click', function () {
        var confirmBtn = this;
        var selected = body.querySelector('input[name="wbs-login-way"]:checked');
        if (!selected || confirmBtn.disabled) return;
        if (selected.value === 'seamless') {
          startSeamlessLogin(mask, body);
          return;
        }
        confirmBtn.disabled = true;
        confirmBtn.textContent = '处理中…';
        api('/api/logout', { method: 'POST' })
          .then(function () {
            closeLoginModal(mask);
            toast('WorkBuddy 即将退出并重新打开到登录页', false, root);
          })
          .catch(function (e) {
            confirmBtn.disabled = false;
            confirmBtn.textContent = '确定';
            toast('退出失败: ' + (e.message || e), true, root);
          });
      });
    }

    function startSeamlessLogin(mask, body) {
      var pollTimer = null;
      var cancelled = false;
      mask.__wbsCancel = function () {
        cancelled = true;
        if (pollTimer) clearTimeout(pollTimer);
      };
      body.innerHTML =
        '<div class="wbs-login-status" id="wbs-login-status">正在发起授权…</div>';
      mask.querySelector('.wbs-modal-actions').innerHTML =
        '<button class="wbs-modal-btn" type="button" id="wbs-login-cancel2">取消</button>';
      mask.querySelector('#wbs-login-cancel2').addEventListener('click', function () {
        closeLoginModal(mask);
      });

      var statusEl = function () { return mask.querySelector('#wbs-login-status'); };
      api('/api/oauth/start', { method: 'POST' })
        .then(function (r) {
          if (cancelled) return;
          // 自动在系统浏览器打开授权页；失败不阻断
          api('/api/open-url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: r.verificationUri }),
          }).catch(function () {});
          var el = statusEl();
          if (el) {
            el.textContent = '已在系统浏览器打开授权页，扫码确认后会自动切换到新账号...';
          }
          var poll = function () {
            if (cancelled) return;
            api('/api/oauth/poll?loginId=' + encodeURIComponent(r.loginId))
              .then(function (p) {
                if (cancelled) return;
                if (!p.done) { pollTimer = setTimeout(poll, 1500); return; }
                if (p.result) {
                  var uid = String(p.result.uid || '').trim();
                  if (!uid) {
                    var missingUidEl = statusEl();
                    if (missingUidEl) missingUidEl.textContent = '授权成功，但未获取到新账号 UID，请关闭后重试';
                    return;
                  }
                  var switchingEl = statusEl();
                  if (switchingEl) switchingEl.textContent = '授权成功，正在切换到「' + (p.result.nickname || uid) + '」…';
                  api('/api/switch', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ uid: uid, reload: true }),
                  })
                    .then(function (switched) {
                      if (cancelled) return;
                      closeLoginModal(mask);
                      toast(
                        switched && switched.reloaded
                          ? '已登录并切换到「' + (switched.nickname || uid) + '」'
                          : '已登录「' + (switched.nickname || uid) + '」，请刷新 WorkBuddy 窗口',
                        false,
                        root
                      );
                      setBuildTimeout(refresh, 1500);
                    })
                    .catch(function (e) {
                      if (cancelled) return;
                      var switchErrEl = statusEl();
                      if (switchErrEl) switchErrEl.textContent = '账号已授权，但自动切换失败：' + (e.message || e) + '。可关闭后在列表中手动切换。';
                    });
                } else {
                  var errEl = statusEl();
                  if (errEl) errEl.textContent = p.error || '登录失败，请关闭后重试';
                }
              })
              .catch(function (e) {
                if (cancelled) return;
                var errEl = statusEl();
                if (errEl) errEl.textContent = '网络暂时失败，正在重试…';
                pollTimer = setTimeout(poll, 1500);
              });
          };
          pollTimer = setTimeout(poll, 1500);
        })
        .catch(function (e) {
          if (cancelled) return;
          var el = statusEl();
          if (el) el.textContent = '发起授权失败: ' + (e.message || e);
        });
    }

    // ===== 主题系统（WorkDaddy 换肤）：segmented 切换 =====
    // 主题 = CSS 变量覆盖（--wb-* / --dc-*），daemon 通过 CDP 注入 <style>。
    // 只提供两个入口：官方主题(default) 与 WorkDaddy 官方主题(nebula)，其余自定义主题不展示
    // 默认选中「WorkBuddy 默认主题」(default)：未设置/异常时回退到 default 而非 nebula（用户要求）
    var ALLOWED_THEMES = ['default', 'nebula'];
    function loadThemes() {
      api('/api/themes')
        .then(function (d) {
          var seg = root.querySelector('.wbs-theme-seg');
          if (!seg) return;
          var cur = d.current && ALLOWED_THEMES.indexOf(d.current) >= 0 ? d.current : 'default';
          seg.querySelectorAll('.wbs-theme-opt').forEach(function (b) {
            b.classList.toggle('active', b.getAttribute('data-theme') === cur);
          });
          // 若当前主题不在允许列表（如之前应用了自定义主题），回退到默认主题
          if (d.current && ALLOWED_THEMES.indexOf(d.current) < 0 && cur === 'default') {
            applyTheme('default').catch(function () {});
          }
        })
        .catch(function () {});
    }
    function applyTheme(id) {
      return api('/api/theme-apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: id }),
      });
    }
    // 当前主题 id（壁纸切换目标）：segmented 激活项；无则 nebula
    function themeSelectValue() {
      var seg = root.querySelector('.wbs-theme-seg');
      var act = seg ? seg.querySelector('.wbs-theme-opt.active') : null;
      var id = act ? act.getAttribute('data-theme') : null;
      return id && id !== 'default' ? id : 'nebula';
    }
    // 页面加载时应用已保存的主题（daemon 侧通过 CDP 注入，reload 后需重新应用）
    setBuildTimeout(function () {
      api('/api/themes').then(function (d) {
        if (d && d.current && d.current !== 'default') {
          applyTheme(d.current).catch(function () {});
        }
      }).catch(function () {});
    }, 1500);

    // ===== 背景毛玻璃：开关 + 模糊度调节 =====
    // 原理：给内容容器加 backdrop-filter: blur(px)，背景图透过半透明容器被模糊（真毛玻璃），文字保持清晰。
    // 通过独立 style 标签注入（优先级高于主题 CSS 的透明背景），关掉即移除。
    var blurRow = root.querySelector('#wbs-blur-row');
    var blurSwitch = root.querySelector('#wbs-blur-switch');
    var blurCtrl = root.querySelector('#wbs-blur-ctrl');
    var blurRange = root.querySelector('#wbs-blur-range');
    var blurVal = root.querySelector('#wbs-blur-val');
    var BLUR_KEY = 'wbsBgBlur';
    var blurStyleEl = null;
    // 滑块 0-100 映射到模糊度 0-20px（每格 0.2px，粒度更细）
    var BLUR_MAX = 20;
    function sliderToBlur(v) { return Math.round((parseInt(v, 10) || 0) * BLUR_MAX / 100 * 10) / 10; }
    function blurToSlider(px) { return Math.round(((parseFloat(px) || 0) / BLUR_MAX) * 100); }

    function blurCssFor(px) {
      // 半透明背景 + 毛玻璃：内容容器看到背景图被模糊；侧边栏/主区/弹层都覆盖
      // 背景不加 !important：有背景图的主题（daemon 注入的毛玻璃背景 !important）优先，
      // 无背景图主题时本规则仍提供 38% 半透明效果；blur 值始终由用户滑块控制
      return [
        'body[data-vscode-theme-name] .teams-container,',
        'body[data-vscode-theme-name] [data-view-id],',
        'body[data-vscode-theme-name] .conversation-list,',
        'body[data-vscode-theme-name] .main-content,',
        'body[data-vscode-theme-name] [class*="cbChat"],',
        'body[data-vscode-theme-name] .cb-message,',
        'body[data-vscode-theme-name] [class*="message-box"] {',
        'background: color-mix(in srgb, var(--wb-bg-primary) 38%, transparent);',
        'backdrop-filter: blur(' + px + 'px) saturate(1.15) !important;',
        '-webkit-backdrop-filter: blur(' + px + 'px) saturate(1.15) !important;',
        '}',
        // 输入框区域也要毛玻璃
        'body[data-vscode-theme-name] [class*="input-area-container"] {',
        'background: color-mix(in srgb, var(--wb-bg-primary) 52%, transparent);',
        'backdrop-filter: blur(' + px + 'px) saturate(1.15) !important;',
        '-webkit-backdrop-filter: blur(' + px + 'px) saturate(1.15) !important;',
        '}',
      ].join('');
    }
    function applyBlur() {
      var saved = null;
      try { saved = JSON.parse(localStorage.getItem(BLUR_KEY) || 'null'); } catch (_) {}
      var enabled = !!(saved && saved.enabled);
      var px = saved && typeof saved.blur === 'number' ? saved.blur : 16;
      if (blurSwitch) blurSwitch.checked = enabled;
      if (blurRow) blurRow.style.display = '';   // 行始终可见（后续可优化为仅背景主题显示）
      if (blurCtrl) blurCtrl.style.display = enabled ? '' : 'none';
      if (blurRange) blurRange.value = String(blurToSlider(px));
      if (blurVal) blurVal.textContent = String(blurRange ? blurRange.value : blurToSlider(px)) + '%';
      if (blurStyleEl) { blurStyleEl.remove(); blurStyleEl = null; }
      if (enabled && px > 0) {
        blurStyleEl = document.createElement('style');
        blurStyleEl.id = 'wbs-blur-style';
        blurStyleEl.textContent = blurCssFor(px);
        document.head.appendChild(blurStyleEl);
      }
    }
    function saveBlur(enabled, blur) {
      try { localStorage.setItem(BLUR_KEY, JSON.stringify({ enabled: !!enabled, blur: blur })); } catch (_) {}
    }
    // 毛玻璃开关/滑块事件在 wireThemePane() 中绑定（元素位于主题 pane，构建后才存在）
    // 初始化（读取上次设置；等主题恢复后再应用，避免被主题 CSS 覆盖）
    setBuildTimeout(applyBlur, 1800);

    // ===== 开发者工具（类 Chrome DevTools：拾取元素 → 查看样式/主题变量/规则来源 + DevTools）=====
    // 隐藏入口：默认隐藏整个「开发者工具」模块，连续点击面板标题「WorkDaddy」5 次才呼出
    var inspectBtn = null; // 增强 pane 构建后由 wireEnhancePane 赋值
    var inspectTitle = root.querySelector('#wbs-title');
    var inspectHidden = true;
    var titleClickCount = 0;
    var titleClickTimer = null;
    if (inspectTitle) {
      inspectTitle.addEventListener('click', function () {
        titleClickCount += 1;
        clearTimeout(titleClickTimer);
        titleClickTimer = setBuildTimeout(function () { titleClickCount = 0; }, 1200);
        if (titleClickCount >= 5) {
          titleClickCount = 0;
          inspectHidden = !inspectHidden;
          if (enhancePane && !enhancePane.dataset.built) buildEnhancePane();
          if (aboutPane && !aboutPane.dataset.built) buildAboutPane();
          var card = root.querySelector('#wbs-devtools-card');
          if (card) card.style.display = inspectHidden ? 'none' : '';
          try { toast(inspectHidden ? '开发者工具已隐藏' : '开发者工具已呼出', false, root); } catch (_) {}
        }
      });
    }
    var inspectState = { active: false, hoverEl: null };
    var INSPECT_KEYS = [
      ['--wb-bg-primary', '背景-主'], ['--wb-bg-secondary', '背景-面板'], ['--wb-sidebar-bg', '侧边栏背景'],
      ['--wb-color-text-primary', '文字-主'], ['--wb-color-text-secondary', '文字-次'], ['--wb-border-default', '边框'],
      ['--wb-button-primary-bg', '按钮背景'], ['--vscode-editor-background', 'vscode背景'], ['--vscode-editor-foreground', 'vscode文字'],
    ];
    function buildSelector(el) {
      if (!el || el === document.body) return 'body';
      if (el.id) return '#' + el.id;
      var cls = (el.className || '').toString().trim().split(/\s+/).filter(Boolean).slice(0, 2);
      var sel = el.tagName.toLowerCase();
      if (cls.length) sel += '.' + cls.join('.');
      return sel;
    }
    // 元素 query 路径：从 body 到元素的完整 CSS 选择器（带 :nth-child 保证唯一，可直接 document.querySelector）
    function buildQueryPath(el) {
      var parts = [];
      var node = el;
      while (node && node !== document.body && node !== document.documentElement) {
        var seg = node.tagName.toLowerCase();
        if (node.id) { parts.unshift(seg + '#' + node.id); break; }
        var cls = (node.className || '').toString().trim().split(/\s+/).filter(Boolean).slice(0, 2);
        if (cls.length) seg += '.' + cls.join('.');
        else if (node.parentElement) {
          var idx = Array.prototype.indexOf.call(node.parentElement.children, node) + 1;
          seg += ':nth-child(' + idx + ')';
        }
        parts.unshift(seg);
        node = node.parentElement;
      }
      parts.unshift('body');
      return parts.join(' > ');
    }
    function showInspector(el) {
      try {
        var old = document.getElementById('wbs-inspector');
        if (old) old.remove();
        var cs = getComputedStyle(el);
      var r = el.getBoundingClientRect();
      var rows = '';
      var items = [
        ['标签', el.tagName.toLowerCase()], ['尺寸', Math.round(r.width) + ' x ' + Math.round(r.height)],
        ['背景色', cs.backgroundColor], ['文字色', cs.color], ['字号', cs.fontSize],
        ['圆角', cs.borderRadius], ['模糊', cs.backdropFilter === 'none' ? '—' : cs.backdropFilter],
      ];
      for (var i = 0; i < items.length; i++) {
        rows += '<div class="wbs-ins-row"><span>' + items[i][0] + '</span><code>' + (items[i][1] || '—') + '</code></div>';
      }
      var vars = '';
      for (var k = 0; k < INSPECT_KEYS.length; k++) {
        var v = cs.getPropertyValue(INSPECT_KEYS[k][0]).trim();
        vars += '<div class="wbs-ins-row"><span>' + INSPECT_KEYS[k][1] + ' <em>' + INSPECT_KEYS[k][0] + '</em></span><code>' + (v || '未定义（继承上层）') + '</code></div>';
      }
      var rules = [];
      try {
        for (var s = 0; s < document.styleSheets.length && rules.length < 4; s++) {
          var sheet; try { sheet = document.styleSheets[s]; } catch (e) { continue; }
          var rs; try { rs = sheet.cssRules; } catch (e) { continue; }
          for (var i2 = 0; i2 < rs.length && rules.length < 4; i2++) {
            var rr = rs[i2];
            if (rr.selectorText && rr.style && el.matches(rr.selectorText) &&
                (rr.style.getPropertyValue('background') || rr.style.getPropertyValue('background-color') || rr.style.getPropertyValue('color') || rr.style.getPropertyValue('filter'))) {
              rules.push(rr.selectorText.slice(0, 72));
            }
          }
        }
      } catch (e) {}
      var rulesHtml = rules.length
        ? rules.map(function (x) { return '<div class="wbs-ins-rule">' + x + '</div>'; }).join('')
        : '<div class="wbs-ins-rule muted">无直接样式规则（颜色来自继承）</div>';
      // 完整报告文本（复制用：选择器 + 基础样式 + 主题变量 + 匹配规则）
      var report = ['🔍 ' + buildSelector(el), ''];
      items.forEach(function (it) { report.push(it[0] + ': ' + (it[1] || '—')); });
      report.push('', '主题变量（当前生效值）');
      INSPECT_KEYS.forEach(function (kv, idx) {
        var v = cs.getPropertyValue(kv[0]).trim();
        report.push('  ' + kv[0] + ' = ' + (v || '未定义（继承上层）'));
      });
      report.push('', '匹配的样式规则');
      if (rules.length) rules.forEach(function (x) { report.push('  ' + x); });
      else report.push('  无直接样式规则（颜色来自继承）');
      var div = document.createElement('div');
      div.id = 'wbs-inspector';
      div.className = 'wbs-inspector'; // 必须设 class：CSS 选择器是 .wbs-inspector，只设 id 会变全宽 div 掉到页面底部
      // 元素 query 路径（从 body 到该元素的完整 CSS 选择器，可直接用于 document.querySelector）
      var queryPath = buildQueryPath(el);
      div.innerHTML =
        '<div class="wbs-ins-head"><span>🔍 ' + buildSelector(el) + '</span>' +
        '<span class="wbs-ins-btns"><button class="wbs-ins-copy" type="button" title="复制元素 query 路径（从 body 起的完整 CSS 选择器）">复制路径</button><button class="wbs-ins-repick" type="button">再检查</button><button class="wbs-ins-close" type="button">✕</button></span></div>' +
        '<div class="wbs-ins-sec">元素路径</div><div class="wbs-ins-path">' + queryPath + '</div>' +
        '<div class="wbs-ins-sec">基础样式</div>' + rows +
        '<div class="wbs-ins-sec">主题变量（当前生效值）</div>' + vars +
        '<div class="wbs-ins-sec">匹配的样式规则</div>' + rulesHtml +
        '<div class="wbs-ins-tip">变量显示「未定义」说明组件颜色来自硬编码，可用「定制」修复 · 「复制路径」把 query 路径贴给 AI 或查 DevTools</div>';
      document.body.appendChild(div);
      div.querySelector('.wbs-ins-close').addEventListener('click', function () { div.remove(); });
      div.querySelector('.wbs-ins-repick').addEventListener('click', function () { div.remove(); startInspect(); });
      div.querySelector('.wbs-ins-copy').addEventListener('click', function () {
        try {
          var ta = document.createElement('textarea');
          ta.value = queryPath;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          var ok = false;
          try { ok = document.execCommand('copy'); } catch (_) {}
          ta.remove();
          try { toast(ok ? '已复制元素路径 ✓' : '复制失败，请手动选择', !ok, root); } catch (_) {}
        } catch (e2) {
          try { toast('复制失败：' + String(e2).slice(0, 60), true, root); } catch (_) {}
        }
      });
      } catch (err) {
        try { toast('检查失败：' + String(err && err.message || err).slice(0, 80), true, root); } catch (_) {}
      }
    }
    function stopInspect() {
      inspectState.active = false;
      document.removeEventListener('mousemove', onInspectMove, true);
      document.removeEventListener('click', onInspectClick, true);
      document.removeEventListener('keydown', onInspectKey, true);
      if (inspectState.hoverEl) { inspectState.hoverEl.style.outline = ''; inspectState.hoverEl = null; }
      var tip = document.getElementById('wbs-inspect-tip');
      if (tip) tip.remove();
      // 恢复面板显示
      if (root && root.style && inspectState.panelDisplay !== undefined) {
        root.style.display = inspectState.panelDisplay;
        inspectState.panelDisplay = undefined;
      }
    }
    function onInspectMove(e) {
      var el = e.target;
      if (el.closest && (el.closest('.wbs-root') || el.closest('#wbs-inspector'))) return;
      if (inspectState.hoverEl && inspectState.hoverEl !== el) inspectState.hoverEl.style.outline = '';
      el.style.outline = '2px solid #22d3ee';
      el.style.outlineOffset = '-2px';
      inspectState.hoverEl = el;
    }
    function onInspectClick(e) {
      var el = e.target;
      if (el.closest && (el.closest('.wbs-root') || el.closest('#wbs-inspector'))) return;
      e.preventDefault(); e.stopPropagation();
      stopInspect();
      showInspector(el);
      if (inspectBtn) inspectBtn.textContent = '🔍';
    }
    function onInspectKey(e) {
      if (e.key === 'Escape') { stopInspect(); if (inspectBtn) inspectBtn.textContent = '🔍'; }
    }
    function startInspect() {
      if (inspectState.active) return;
      inspectState.active = true;
      // 收起面板：避免面板遮挡浮层/干扰拾取（检查完自动恢复）
      if (root && root.style && root.style.display !== 'none') {
        inspectState.panelDisplay = root.style.display;
        root.style.display = 'none';
      }
      document.addEventListener('mousemove', onInspectMove, true);
      document.addEventListener('click', onInspectClick, true);
      document.addEventListener('keydown', onInspectKey, true);
      var tip = document.createElement('div');
      tip.id = 'wbs-inspect-tip';
      tip.textContent = '拾取模式：移动鼠标高亮元素，点击查看详情（Esc 退出）';
      document.body.appendChild(tip);
      if (inspectBtn) inspectBtn.textContent = '✕';
    }
    // 🔍 按钮切换（增强 pane 构建后由 wireEnhancePane 绑定到按钮点击）
    function toggleInspect() {
      if (inspectState.active) { stopInspect(); if (inspectBtn) inspectBtn.textContent = '🔍 元素检查'; return; }
      startInspect();
    }
    // DevTools 按钮：打开 WorkBuddy 的完整 DevTools（Electron 自带前端，绕开 chrome://inspect 404）
    // 绑定逻辑已迁移到 wireEnhancePane()（按钮位于增强 pane）

    // ===== 头像（官方 footer-brand-logo SVG / 自定义上传，localStorage 持久化，定时保持）=====
    var AVATAR_KEY = 'wbsAvatar';
    // WorkBuddy 官方品牌 logo（footer-brand-logo），作为「官方头像」预览/选择/恢复默认的目标
    var OFFICIAL_LOGO_SVG =
      '<svg xmlns="http://www.w3.org/2000/svg" width="161" height="161" viewBox="0 0 161 161" fill="none">' +
      '<g clip-path="url(#c0)">' +
      '<path d="M123.136 12.5936C124.714 11.1778 124.809 11.1233 125.967 11.0538C127.842 10.9168 129.56 11.8165 132.484 14.4786C139.316 20.6865 148.829 33.4498 154.743 44.349L157.028 48.5792L160.255 50.1832C163.371 51.7577 168.483 54.986 170.618 56.7173C171.583 57.5155 171.718 57.5323 172.722 57.1418C177.253 55.3774 183.742 57.716 189.466 63.2075C194.619 68.1461 199.554 76.584 201.445 83.6267C201.721 84.7601 202.087 87.1965 202.22 89.0111C202.652 95.383 200.608 100.473 196.673 102.776C195.869 103.24 195.815 103.366 195.838 105.371C196.019 114.913 193.447 124.438 188.28 133.727C182.447 144.157 172.061 154.947 158.004 165.112C150.456 170.605 132.596 181.01 124.521 184.663C105.178 193.371 89.6718 196.712 76.2024 195.062C68.1682 194.089 59.074 190.952 53.6933 187.312C52.2768 186.332 52.0529 186.272 50.9706 186.582C45.2104 188.237 37.6668 184.836 31.258 177.722C28.7019 174.878 24.5759 167.896 23.2384 164.16C20.1449 155.416 20.7603 147.526 24.8811 142.814C25.9459 141.6 25.9789 141.549 25.7463 139.507C25.3622 136.166 25.1878 131.223 25.3633 128.032L25.5029 125.051L21.0275 117.135C14.0977 104.805 9.69618 94.4507 7.99809 86.5401C7.10166 82.2025 7.1576 80.2787 8.2587 78.8548C8.92882 77.995 11.1261 77.105 13.7757 76.6156C20.4456 75.4446 34.9927 76.5037 51.1768 79.361L52.8581 79.6521L56.552 76.384C62.6848 70.9515 66.7595 67.9056 74.2707 63.2222C82.0993 58.3241 90.9344 54.2952 100.884 51.1047L104.076 50.0813L105.83 45.474C112.113 28.8884 118.548 16.6611 123.136 12.5936ZM70.508 97.5819C63.407 101.682 59.8561 103.732 57.2472 106.03C46.6828 115.333 42.7347 130.067 47.2323 143.406C48.343 146.7 50.3925 150.251 54.4921 157.351C58.5918 164.452 60.6425 168.003 62.9398 170.612C72.2427 181.176 86.9773 185.125 100.316 180.627C103.61 179.516 107.161 177.466 114.262 173.367L155.11 149.783C162.211 145.684 165.762 143.633 168.371 141.336C178.935 132.033 182.883 117.298 178.386 103.959C177.275 100.665 175.225 97.1139 171.126 90.013C167.026 82.9123 164.976 79.3619 162.678 76.753C153.375 66.1886 138.641 62.2405 125.302 66.7381C122.008 67.8488 118.457 69.8987 111.356 73.9984L70.508 97.5819Z" fill="#4C4F6B" fill-opacity="0.3"></path>' +
      '<rect x="74.4458" y="126.121" width="16.1364" height="33.514" rx="8.06819" transform="rotate(-30 74.4458 126.121)" fill="#4C4F6B" fill-opacity="0.3"></rect>' +
      '<rect x="117.981" y="100.984" width="16.1364" height="33.514" rx="8.06819" transform="rotate(-30 117.981 100.984)" fill="#4C4F6B" fill-opacity="0.3"></rect>' +
      '</g><defs><clipPath id="c0"><rect width="161" height="161" rx="34.7421" fill="white"></rect></clipPath></defs></svg>';
    var OFFICIAL_AVATAR = null; // 官方头像 PNG dataURL（SVG 转 96px）
    var avatarWrapperStates = [], avatarImageStates = [];
    function rememberAvatarWrapper(wrap) {
      for (var i = 0; i < avatarWrapperStates.length; i++) {
        if (avatarWrapperStates[i].node === wrap) return;
      }
      avatarWrapperStates.push({ node: wrap, backgroundImage: wrap.style.backgroundImage });
    }
    function rememberAvatarImage(img) {
      for (var i = 0; i < avatarImageStates.length; i++) {
        if (avatarImageStates[i].node === img) return;
      }
      avatarImageStates.push({ node: img, visibility: img.style.visibility, display: img.style.display });
    }
    function restoreAvatarDom() {
      var applied = document.querySelectorAll('[data-wbs-avatar-app]');
      for (var i = 0; i < applied.length; i++) applied[i].remove();
      for (var j = 0; j < avatarWrapperStates.length; j++) {
        avatarWrapperStates[j].node.style.backgroundImage = avatarWrapperStates[j].backgroundImage;
      }
      for (var k = 0; k < avatarImageStates.length; k++) {
        avatarImageStates[k].node.style.visibility = avatarImageStates[k].visibility;
        avatarImageStates[k].node.style.display = avatarImageStates[k].display;
      }
      avatarWrapperStates = [];
      avatarImageStates = [];
    }
    // SVG → PNG dataURL
    function svgToPng(svgStr, size) {
      return new Promise(function (resolve) {
        var img = new Image();
        img.onload = function () {
          try {
            var c = document.createElement('canvas');
            c.width = size; c.height = size;
            c.getContext('2d').drawImage(img, 0, 0, size, size);
            resolve(c.toDataURL('image/png'));
          } catch (e) { resolve(null); }
        };
        img.onerror = function () { resolve(null); };
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgStr);
      });
    }
    // 初始化官方头像（转换完成后立即应用一次）
    svgToPng(OFFICIAL_LOGO_SVG, 96).then(function (d) {
      if (!alive) return;
      OFFICIAL_AVATAR = d;
      applyAvatar();
    });
    function applyAvatar() {
      var dataUrl = null;
      try { dataUrl = localStorage.getItem(AVATAR_KEY); } catch (_) {}
      var pv = root.querySelector('#wbs-avatar-preview');
      var wrap = document.querySelector('.user-menu-trigger-avatar');
      // 目标头像：自定义 or 官方 logo
      var target = dataUrl || OFFICIAL_AVATAR;
      if (wrap) {
        rememberAvatarWrapper(wrap);
        // 官方默认头像图片改用 visibility:hidden（保留占位与布局，仅不可见）：
        // 不能 display:none——头像容器尺寸由这张 img 撑开，display:none 会让容器塌陷成 0×0，
        // 导致昵称等相邻元素位置错乱（盖到头像上）。
        try {
          var offImgs = wrap.querySelectorAll('img:not([data-wbs-avatar-app]):not([data-wbs-custom])');
          for (var oi = 0; oi < offImgs.length; oi++) {
            rememberAvatarImage(offImgs[oi]);
            offImgs[oi].style.visibility = 'hidden';
            offImgs[oi].style.display = '';
          }
          if (wrap.style.backgroundImage && wrap.style.backgroundImage !== 'none') wrap.style.backgroundImage = 'none';
        } catch (_) {}
        var custom = wrap.querySelector('img[data-wbs-custom]');
        if (custom && custom.getAttribute('src') !== target) custom.remove();
        if (target) {
          var app = wrap.querySelector('img[data-wbs-avatar-app]');
          if (!app) {
            app = document.createElement('img');
            app.setAttribute('data-wbs-avatar-app', '1');
            wrap.appendChild(app);
          }
          // 强制全覆盖（兼容旧版残留的 32px 固定尺寸）
          app.style.width = '100%';
          app.style.height = '100%';
          app.style.borderRadius = '50%';
          app.style.position = 'absolute';
          app.style.inset = '0';
          app.style.objectFit = 'cover';
          if (app.getAttribute('src') !== target) app.setAttribute('src', target);
        } else {
          var app2 = wrap.querySelector('img[data-wbs-avatar-app]');
          if (app2) app2.remove();
        }
      }
      // 面板内头像预览（始终显示：官方 logo 或自定义）
      if (pv) {
        if (target) { pv.setAttribute('src', target); pv.style.display = 'block'; }
        else { pv.style.display = 'none'; pv.removeAttribute('src'); }
      }
    }
    // 头像上传按钮/文件输入位于主题 pane（构建后由 wireThemePane 事件委托处理）
    // 定时保持：WorkBuddy 渲染/切会话会重置头像 src，2s 检查一次（无条件运行，不依赖按钮）
    avatarTimer = setBuildInterval(applyAvatar, 2000);
    setBuildTimeout(applyAvatar, 800);

    // ===== 自定义图片生成皮肤（WBSS 方案：压缩 webp + HSL 取色 -> theme.json + 背景图）=====
    // 上传按钮/文件输入位于主题 pane（构建后由 wireThemePane 事件委托处理）
    // 替换当前主题背景图（保持主题配色不变，不再生成新主题——避免 reload 后被"切回最早背景图"）
    function replaceThemeBg(dataUrl) {
      var img = new Image();
      img.onload = function () {
        try {
          var scale = Math.min(1, 1600 / Math.max(img.width, img.height));
          var full = document.createElement('canvas');
          full.width = Math.round(img.width * scale);
          full.height = Math.round(img.height * scale);
          full.getContext('2d').drawImage(img, 0, 0, full.width, full.height);
          var compressed = full.toDataURL('image/webp', 0.82);
          // 目标主题：当前选中的主题；若是 default 则用内置默认深色主题 nebula
          var target = themeSelectValue();
          api('/api/theme-bg', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: target, dataUrl: compressed }),
          }).then(function (d) {
            if (!d || !d.ok) throw new Error((d && d.error) || '替换背景图失败');
            toast('已应用壁纸「' + target + '」', false, root);
            loadThemes();
            
            // 自定义背景图预览
            var preview = root.querySelector('#wbs-bg-preview');
            if (preview) { preview.src = compressed; preview.style.display = 'block'; }
          }).catch(function (e) {
            toast('替换背景图失败: ' + (e.message || e), true, root);
          });
        } catch (e) {
          toast('图片处理失败: ' + String(e).slice(0, 60), true, root);
        }
      };
      img.onerror = function () { toast('图片读取失败', true, root); };
      img.src = dataUrl;
    }
    function hexOf(r, g, b) {
      return '#' + [r, g, b].map(function (v) { return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'); }).join('');
    }
    function mixArr(a, b, t) { return a.map(function (v, i) { return v + (b[i] - v) * t; }); }
    function extractPalette(canvas) {
      var ctx = canvas.getContext('2d');
      var px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      var buckets = new Map();
      var lumSum = 0, count = 0;
      for (var i = 0; i < px.length; i += 4) {
        var r = px[i], g = px[i + 1], b = px[i + 2];
        var max = Math.max(r, g, b), min = Math.min(r, g, b);
        var lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        lumSum += lum; count += 1;
        var sat = max === 0 ? 0 : (max - min) / max;
        if (sat < 0.18 || lum < 24 || lum > 245) continue;
        var d = max - min || 1;
        var h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
        var bucket = Math.round(h) % 6 * 2 + (sat > 0.55 ? 1 : 0);
        var entry = buckets.get(bucket) || { w: 0, r: 0, g: 0, b: 0, h: h * 60 };
        var weight = sat * sat;
        entry.w += weight; entry.r += r * weight; entry.g += g * weight; entry.b += b * weight;
        buckets.set(bucket, entry);
      }
      var avgLum = count ? lumSum / count : 128;
      var ranked = Array.from(buckets.values()).sort(function (a, b2) { return b2.w - a.w; })
        .map(function (e) { return { rgb: [e.r / e.w, e.g / e.w, e.b / e.w], h: e.h, w: e.w }; });
      var accent = ranked[0] ? ranked[0].rgb : [36, 201, 215];
      var second = null;
      for (var k = 0; k < ranked.length; k++) {
        if (Math.abs(ranked[k].h - (ranked[0] ? ranked[0].h : 0)) > 50) { second = ranked[k].rgb; break; }
      }
      second = second || mixArr(accent, [255, 255, 255], 0.35);
      var light = avgLum > 128;
      var surface = light ? mixArr(accent, [252, 252, 255], 0.92) : mixArr(accent, [12, 12, 18], 0.86);
      var text = light ? mixArr(accent, [16, 24, 40], 0.82) : mixArr(accent, [244, 246, 252], 0.85);
      return { accent: hexOf.apply(null, accent), secondary: hexOf.apply(null, second), surface: hexOf.apply(null, surface), text: hexOf.apply(null, text) };
    }
    function imageToTheme(dataUrl, name) {
      return new Promise(function (resolve, reject) {
        var img = new Image();
        img.onload = function () {
          try {
            // 压缩到最长边 1600，webp 0.8
            var scale = Math.min(1, 1600 / Math.max(img.width, img.height));
            var full = document.createElement('canvas');
            full.width = Math.round(img.width * scale);
            full.height = Math.round(img.height * scale);
            full.getContext('2d').drawImage(img, 0, 0, full.width, full.height);
            var sample = document.createElement('canvas');
            sample.width = 48; sample.height = Math.max(1, Math.round(48 * img.height / img.width));
            sample.getContext('2d').drawImage(img, 0, 0, sample.width, sample.height);
            var palette = extractPalette(sample);
            var compressed = full.toDataURL('image/webp', 0.8);
            var dark = !palette.surface || (function () {
              var m = /^#([0-9a-f]{6})$/i.exec(palette.surface);
              if (!m) return false;
              var v = parseInt(m[1], 16);
              return (0.299 * ((v >> 16) & 255) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255)) <= 140;
            })();
            // 生成主题（全量变量：以官方浅/深色板为基 + 提取色覆盖核心变量）
            // 注意：上传图片与保存主题必须用同一个 id，否则图片目录与主题文件对不上（背景图加载失败）
            var themeId = 'custom-' + Date.now().toString(36);
            api('/api/theme-image', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ id: themeId, dataUrl: compressed }),
            }).then(function (up) {
              if (!up || !up.ok) throw new Error((up && up.error) || '上传图片失败');
              var id = themeId;
              var surface = palette.surface, accent = palette.accent, text = palette.text;
              var bgVar = dark ? '#121016' : '#f7f7f9';
              var fgVar = dark ? '#e8e8ea' : '#1f1f1f';
              var colors = {};
              ['--wb-bg-primary', '--wb-bg-secondary', '--wb-bg-popover', '--wb-bg-modal', '--wb-bg-card', '--wb-bg-content',
               '--wb-main-area-background', '--wb-home-bg-secondary', '--wb-home-composer-card-bg',
               '--vscode-editor-background', '--vscode-panel-background', '--vscode-tab-activeBackground',
               '--vscode-sideBar-background', '--vscode-activityBar-background', '--vscode-editorGroupHeader-tabsBackground',
               '--cb-colleagues-dashboard-bg', '--wb-sidebar-bg', '--wb-home-bg-primary'].forEach(function (k) {
                colors[k] = dark ? (k.indexOf('sidebar') >= 0 ? '#16131f' : '#121016') : (k.indexOf('sidebar') >= 0 ? '#ece7f4' : '#f7f7f9');
              });
              ['--wb-text-strong', '--wb-color-text-primary', '--wb-color-text-solid', '--wb-voice-input-text-primary',
               '--vscode-editor-foreground', '--vscode-sideBar-foreground', '--vscode-activityBar-foreground', '--vscode-foreground'].forEach(function (k) {
                colors[k] = fgVar;
              });
              colors['--wb-color-text-secondary'] = dark ? 'rgba(232,232,234,0.7)' : 'rgba(31,31,31,0.7)';
              colors['--wb-border-default'] = dark ? 'rgba(232,232,234,0.14)' : 'rgba(31,31,31,0.12)';
              colors['--wb-border-strong'] = dark ? '#2c2c33' : '#e2e2e2';
              colors['--wb-border-subtle'] = dark ? '#1e1e24' : '#e9e9ec';
              colors['--wb-button-primary-bg'] = accent;
              colors['--wb-button-primary-fg'] = (function () {
                var m = /^#([0-9a-f]{6})$/i.exec(accent);
                if (!m) return '#fff';
                var v = parseInt(m[1], 16);
                return (0.299 * ((v >> 16) & 255) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255)) > 150 ? '#1a1a1a' : '#ffffff';
              })();
              colors['--wb-button-primary-bg-hover'] = accent;
              colors['--wb-status-success'] = '#2ee59d'; colors['--wb-status-warning'] = '#ffb03a';
              colors['--wb-status-error'] = '#ff6b6b'; colors['--wb-status-info'] = '#3fd6c0';
              return api('/api/theme-save', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ id: id, name: name || '我的图片皮肤', author: 'wbs', dark: dark, image: 'background.webp', colors: colors }),
              }).then(function (sv) {
                if (!sv || !sv.ok) throw new Error((sv && sv.error) || '保存主题失败');
                loadThemes();

                return applyTheme(id);
              });
            }).then(function (r) {
              toast('已用图片生成皮肤并应用', false, root);
              resolve(r);
            }).catch(function (e) {
              toast('生成皮肤失败: ' + (e.message || e), true, root);
              reject(e);
            });
          } catch (e) { reject(e); }
        };
        img.onerror = function () { reject(new Error('图片读取失败')); };
        img.src = dataUrl;
      });
    }

    // ===== 决策弹窗开关（全局自定义指令，默认开启） =====
    // daemon 写入 ~/.workbuddy/settings.json 的 personalization.customPrompt，
    // WorkBuddy 会把它渲染进每个会话的 <user_custom_instructions>（MUST follow）。
    var askSwitch = null; // 增强 pane 构建后由 wireEnhancePane 赋值
    function syncAskSwitch() {
      api('/api/ask-mode')
        .then(function (d) {
          if (askSwitch && d && typeof d.enabled === 'boolean') askSwitch.checked = d.enabled;
        })
        .catch(function () {});
    }
    var displaySleepSwitch = null; // 允许显示器休眠开关（电脑 pane，wirePcPane 赋值）
    var sleepMode = 'allow'; // 当前休眠模式（内存缓存，syncSleepState 更新）
    var sleepUntilDoneCheck = null; // until-done 模式下的空闲检测定时器

    /* ===== 免打扰模块（No-Disturb）===== */
    var ndAutoObserver = null; // 弹窗自动点允许的 MutationObserver
    var ndScanTimer = null;
    var ndEnabledCount = 0;
    // 开关定义：id/配置名/确认弹窗文案（开启时弹窗，红字确认）
    var ND_DEFS = [
      {
        id: 'wbs-nd-outside', name: 'outsideWrite',
        confirmTitle: '开启「外写文件免确认」？',
        confirmBody: '开启后，AI 可直接读写工作区外的任意文件，不再逐次询问。<b>风险：误改文件时不会提醒。</b>',
        confirmAction: '开启',
      },
      {
        id: 'wbs-nd-commands', name: 'commands',
        confirmTitle: '开启「常用命令行免确认」？',
        confirmBody: '开启后，npm、git、curl、python3 等命令可直接在本机执行，不再经过沙箱或逐次确认。<b>风险：命令执行不再受沙箱保护。</b>',
        confirmAction: '开启',
      },
      {
        id: 'wbs-nd-bulk', name: 'bulkDelete',
        confirmTitle: '开启「大批量删除免确认」？',
        confirmBody: '开启后，AI 批量删除文件时不再询问，文件会直接进入废纸篓/回收站，可恢复。<b>彻底删除仍需你明确操作。</b>',
        confirmAction: '开启，移入回收站',
      },
      {
        id: 'wbs-nd-systools', name: 'systemTools',
        confirmTitle: '开启「系统级工具放行」？',
        confirmBody: '开启后，wsl、reg、sc、schtasks 等系统命令可直接执行，不再经过确认或沙箱。<b>风险：可直接修改系统配置，风险最高。</b>',
        confirmAction: '开启',
      },
      {
        id: 'wbs-nd-auto', name: 'autoApprove',
        confirmTitle: '开启「弹窗自动点允许」？',
        confirmBody: '开启后，插件会自动点击出现的「允许」按钮，避免任务中断。<b>风险：所有确认将失去人工把关。</b>',
        confirmAction: '开启',
      },
    ];

    function ndEl() {
      return enhancePane && enhancePane.querySelector('#wbs-nd-count');
    }
    function ndRefreshCount() {
      var el = ndEl();
      if (el) el.textContent = '已开启 ' + ndEnabledCount + ' / ' + ND_DEFS.length;
    }
    function ndSwitchEl(id) {
      return enhancePane && enhancePane.querySelector('#' + id);
    }

    /** 免打扰开关绑定（wireEnhancePane 调用） */
    function wireNoDisturbPane() {
      for (var i = 0; i < ND_DEFS.length; i++) {
        (function (def) {
          var sw = ndSwitchEl(def.id);
          if (!sw) return;
          sw.addEventListener('change', function () {
            var enabled = this.checked;
            if (!enabled) {
              setNoDisturb(def.name, false);
              return;
            }
            // 开启前弹确认（红字确认键）
            showNoDisturbConfirm(def, function () { setNoDisturb(def.name, true); }, function () {
              sw.checked = false;
            });
          });
        })(ND_DEFS[i]);
      }
      // 批量开关：一键全开（需二次确认）/ 全关
      var allSw = enhancePane && enhancePane.querySelector('#wbs-nd-all');
      if (allSw) {
        allSw.addEventListener('change', function () {
          var enabled = this.checked;
          if (!enabled) {
            bulkNoDisturb(false);
            return;
          }
          showNoDisturbConfirm({
            confirmTitle: '开启「全部免打扰」？',
            confirmBody: '将一次性开启下面所有开关：外写文件免确认、常用命令免确认、大批量删除免确认、系统级工具放行、弹窗自动点允许。开启后 AI 执行将不再打扰，所有删除仍先进废纸篓可恢复。<b>仅在你信任当前工作和本机时使用。</b>',
            confirmAction: '全部开启',
          }, function () { bulkNoDisturb(true); }, function () {
            allSw.checked = false;
          });
        });
      }
      syncNoDisturb();
    }

    /** 批量开/关：串行逐个应用（开需要已弹过确认；关直接执行） */
    function bulkNoDisturb(enabled) {
      var chain = Promise.resolve();
      var pending = [];
      for (var i = 0; i < ND_DEFS.length; i++) pending.push(ND_DEFS[i]);
      var failed = false;
      pending.forEach(function (def) {
        chain = chain.then(function () {
          if (failed) return;
          return api('/api/no-disturb-set', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: def.name, enabled: enabled }),
          }).then(function (d) {
            if (!d || !d.ok) throw new Error((d && d.error) || 'daemon 未确认');
          }).catch(function (e) {
            failed = true;
            throw e;
          });
        });
      });
      chain
        .then(function () {
          toast(enabled ? '已全部开启免打扰' : '已全部关闭免打扰', false, root);
          syncNoDisturb();
        })
        .catch(function (e) {
          toast('批量设置失败: ' + (e.message || e), true, root);
          syncNoDisturb();
          var allSw = enhancePane && enhancePane.querySelector('#wbs-nd-all');
          if (allSw) allSw.checked = false;
        });
    }

    /** 统一开关设置入口：POST daemon → 回写 UI 状态 → 联动 autoApprove observer */
    function setNoDisturb(name, enabled) {
      api('/api/no-disturb-set', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name, enabled: enabled }),
      })
        .then(function (d) {
          if (!d || !d.ok) throw new Error((d && d.error) || 'daemon 未确认');
          applyNoDisturbState(d.switches || {});
          toast(enabled ? '已开启：' + ndTitle(name) : '已关闭：' + ndTitle(name), false, root);
        })
        .catch(function (e) {
          toast('设置失败: ' + (e.message || e), true, root);
          syncNoDisturb();
        });
    }
    function ndTitle(name) {
      for (var i = 0; i < ND_DEFS.length; i++) if (ND_DEFS[i].name === name) return ND_DEFS[i].confirmTitle.replace(/[「」？]/g, '');
      return name;
    }

    /** 开启确认弹窗：动态 modal，红字确认按钮（复用 .wbs-modal-* 体系）；
     *  挂载到面板容器（.wbs-panel）内并 absolute 覆盖，弹窗居中于面板而不是整个 WorkBuddy 窗口 */
    function showNoDisturbConfirm(def, onOk, onCancel) {
      var mask = document.createElement('div');
      mask.className = 'wbs-modal-mask wbs-modal-mask-panel';
      mask.style.display = 'flex';
      mask.innerHTML =
        '<div class="wbs-modal">' +
        '<div class="wbs-modal-title">' + def.confirmTitle + '</div>' +
        '<div class="wbs-modal-body" style="white-space:pre-line">' + def.confirmBody + '</div>' +
        '<div class="wbs-modal-actions">' +
        '<button class="wbs-modal-btn" type="button" data-nd-act="cancel">再想想</button>' +
        '<button class="wbs-modal-btn wbs-modal-danger" type="button" data-nd-act="ok">' + def.confirmAction + '</button>' +
        '</div></div>';
      function cleanup() {
        mask.removeEventListener('click', onClick);
        if (mask.parentNode) mask.parentNode.removeChild(mask);
      }
      function onClick(e) {
        if (e.target === mask) { cleanup(); onCancel && onCancel(); return; }
        var act = e.target.getAttribute && e.target.getAttribute('data-nd-act');
        if (act === 'cancel') { cleanup(); onCancel && onCancel(); }
        else if (act === 'ok') { cleanup(); onOk && onOk(); }
      }
      mask.addEventListener('click', onClick);
      // 面板容器：弹窗只覆盖面板区域（面板中间），不盖住 WorkBuddy 窗口
      var panel = root && root.querySelector('.wbs-panel');
      (panel || root || document.body).appendChild(mask);
    }

    /** 从 daemon 拉开关状态并同步 UI（含自动点允许 observer 启停） */
    function syncNoDisturb() {
      api('/api/no-disturb')
        .then(function (d) {
          if (d && d.ok && d.switches) applyNoDisturbState(d.switches);
        })
        .catch(function () {});
    }
    function applyNoDisturbState(switches) {
      if (!switches || typeof switches !== 'object') return;
      var n = 0;
      for (var i = 0; i < ND_DEFS.length; i++) {
        var def = ND_DEFS[i];
        var sw = ndSwitchEl(def.id);
        var on = !!switches[def.name];
        if (sw) sw.checked = on;
        if (on) n++;
      }
      ndEnabledCount = n;
      ndRefreshCount();
      // 批量总开关：全部开启时才为 true
      var allSw = enhancePane && enhancePane.querySelector('#wbs-nd-all');
      if (allSw) allSw.checked = n === ND_DEFS.length;
      if (switches.autoApprove) startNoDisturbAutoApprove();
      else stopNoDisturbAutoApprove();
    }

    /* —— 弹窗自动点允许（兜底，默认关）—— */
    function startNoDisturbAutoApprove() {
      if (ndAutoObserver) return;
      var doc = (window && window.document) || document;
      if (!doc || !doc.body) return;
      ndAutoObserver = new MutationObserver(function () { scheduleNdScan(); });
      ndAutoObserver.observe(doc.body, { childList: true, subtree: true });
      scheduleNdScan();
    }
    function stopNoDisturbAutoApprove() {
      if (ndAutoObserver) { ndAutoObserver.disconnect(); ndAutoObserver = null; }
      if (ndScanTimer) { clearTimeout(ndScanTimer); ndScanTimer = null; }
    }
    function scheduleNdScan() {
      if (ndScanTimer) clearTimeout(ndScanTimer);
      ndScanTimer = setTimeout(scanNoDisturbApproval, 120);
    }
    function ndVisible(el) {
      return !!(el && el.getClientRects && el.getClientRects().length && el.offsetParent !== null);
    }
    // 仅在确认类弹窗容器内自动点，宁可漏点也不错点。语境判定两通道：
    //  A. 关键词语境（老客户端 + 沙箱外执行命令兜底文案），向上至多 8 层
    //  B. 结构化语境（WorkBuddy AI 拦截卡）：近层容器（≤3 层）内同时存在
    //     「精确 once 允许选项」（允许/Allow/同意/…）+「拒绝选项」（拒绝/Deny），
    //     且容器不含积分/资费等扣费弹窗文案（图片/视频生成等确认弹窗绝不自动点——
    //     它们只有「确认/始终允许/拒绝」，没有独立「允许」选项，天然不命中）。
    //  注意（1.0.16）：WorkBuddy AI 拦截卡选项按钮文本带序号前缀（如「1允许」「2本次会话内始终允许」），
    //  once 匹配必须先规范化（去序号）；文件拦截文案是「检测到受保护文件修改」等，已补进关键词表。
    var ND_CONFIRM_PATTERN = /批量删除|沙箱|越界|越权|系统级工具|系统工具|权限|允许访问|将运行|需要你确认|需要你的确认|确认允许|检测到|受保护|敏感|凭据|黑名单|sandbox|approval|permission/i;
    var ND_CREDIT_PATTERN = /积分|信用|credit|消耗|付费|支付|费用|金额|余额|扣费/i;
    var ND_DENY_WORD = /拒绝|Deny/i;
    var ND_ONCE_LABEL = /^(允许|允许一次|Allow|Yes|同意|批准|确认允许)$/i;
    function ndNormalizeLabel(t) {
      return String(t || '').trim().replace(/^\d+\s*/g, '');
    }
    // 容器是否构成「允许+拒绝」决策组：含 ≥2 个按钮，且其中一个是精确 once 允许选项
    function ndIsDecisionGroup(box) {
      var opts = box.querySelectorAll('button');
      if (!opts || opts.length < 2 || opts.length > 12) return false;
      for (var i = 0; i < opts.length; i++) {
        if (ND_ONCE_LABEL.test(ndNormalizeLabel(opts[i].textContent || ''))) return true;
      }
      return false;
    }
    function scanNoDisturbApproval() {
      var doc = (window && window.document) || document;
      if (!doc) return;
      var btns = doc.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        var b = btns[i];
        if (b.getAttribute('data-nd-auto')) continue; // 已处理过
        if (!ndVisible(b)) continue;
        if (b.disabled || b.getAttribute('aria-disabled') === 'true') continue; // 禁用按钮不点
        var t = ndNormalizeLabel(b.textContent || '');
        var kind = null;
        if (/始终允许|Always\s*allow/i.test(t)) kind = 'session';
        else if (ND_ONCE_LABEL.test(t)) kind = 'once';
        else if (/^Yes/i.test(t) && t.length < 24) kind = 'once';
        if (!kind) continue;
        // 向上找确认容器（至多 8 层），验证语境：关键词命中，或近层命中「允许+拒绝」决策组（且无扣费文案）
        var box = b;
        var hit = false;
        var creditSeen = false;
        for (var c = 0; c < 8 && box; c++) {
          box = box.parentElement;
          if (!box) break;
          var txt = box.textContent || '';
          if (txt.length > 500) txt = txt.slice(0, 500);
          if (ND_CONFIRM_PATTERN.test(txt)) { hit = true; break; }
          if (ND_CREDIT_PATTERN.test(txt)) creditSeen = true;
          if (c < 3 && !creditSeen && ND_DENY_WORD.test(txt) && ndIsDecisionGroup(box)) { hit = true; break; }
        }
        if (!hit) continue;
        b.setAttribute('data-nd-auto', '1');
        toNdAudit(kind, t);
        try { if (b.click) b.click(); } catch (e) {}
        return; // 每轮只确认一个，避免连环误触
      }
    }
    function toNdAudit(kind, matched) {
      api('/api/no-disturb-audit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'approve', matched: kind + ':' + matched }), // eslint-disable-line no-unused-vars
      }).catch(function () {});
    }

    function getSleepMode() {
      var r = pcPane && pcPane.querySelector('input[name="wbs-sleep-mode"]:checked');
      return r ? r.value : sleepMode;
    }
    // POST 休眠设置（模式 + 显示器开关）
    function postSleepMode(mode, displaySleep) {
      return api('/api/sleep-mode', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: mode, displaySleep: displaySleep }),
      }).then(function (d) {
        var map = { allow: '允许电脑休眠（系统默认）', keep: '持续禁止休眠（保持唤醒）', 'until-done': '所有任务结束后允许休眠（暂禁休眠）' };
        toast('休眠模式已切换为「' + (map[mode] || mode) + '」' + (displaySleep ? '，显示器可单独休眠' : ''), false, root);
        syncSleepState();
        return d;
      }).catch(function (e) {
        toast('设置失败: ' + (e.message || e), true, root);
        syncSleepState();
      });
    }
    // AI 是否正在生成回复（用于 until-done 模式检测"所有任务结束"）：存在停止/生成中按钮则忙碌
    function isAiBusy() {
      try {
        // 停止按钮：操作栏圆形按钮 aria-label 含"停止"或 class 含 stop
        var row = findActionRow();
        if (row) {
          var kids = row.children;
          for (var i = 0; i < kids.length; i++) {
            var k = kids[i];
            var al = (k.getAttribute && k.getAttribute('aria-label')) || '';
            if (/停止|stop/i.test(al)) return true;
            var cls = (k.className && k.className.toString()) || '';
            if (/cb-stop|_stop_/i.test(cls)) return true;
          }
        }
        // 兜底：reasoning streaming 存在
        var secs = document.querySelectorAll('section[class*=_assistantReasoning_][class*=_streaming_]');
        return secs.length > 0;
      } catch (e) { return false; }
    }
    // until-done 模式：轮询检测任务是否全部结束，结束后自动恢复 allow
    function startUntilDoneCheck() {
      if (sleepUntilDoneCheck) return;
      sleepUntilDoneCheck = setBuildInterval(function () {
        if (!alive) { stopUntilDoneCheck(); return; }
        if (sleepMode !== 'until-done') { stopUntilDoneCheck(); return; }
        if (!isAiBusy()) {
          // 连续空闲：任务已结束，自动恢复允许休眠
          stopUntilDoneCheck();
          api('/api/sleep-mode', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mode: 'allow', displaySleep: false }),
          }).then(function () {
            toast('所有 AI 任务已完成，已自动恢复「允许电脑休眠」', false, root);
            syncSleepState();
          }).catch(function () { syncSleepState(); });
        }
      }, 5000);
    }
    function stopUntilDoneCheck() {
      if (sleepUntilDoneCheck) { clearInterval(sleepUntilDoneCheck); sleepUntilDoneCheck = null; }
    }
    // 同步防休眠状态：三模式 radio + 显示器开关 + 状态文字 + 悬浮按钮角标（daemon 重启/状态变化后保持一致）
    function syncSleepState() {
      api('/api/sleep-mode')
        .then(function (d) {
          if (d && d.mode) {
            sleepMode = d.mode;
            var preventing = d.preventing === true || d.mode === 'keep' || d.mode === 'until-done';
            if (pcPane) {
              var r = pcPane.querySelector('input[name="wbs-sleep-mode"][value="' + d.mode + '"]');
              if (r) r.checked = true;
              if (displaySleepSwitch) displaySleepSwitch.checked = !!d.displaySleep;
              var drow = pcPane.querySelector('#wbs-display-sleep-row');
              if (drow) drow.style.display = preventing ? '' : 'none';
            }
            var dot = root.querySelector('.wbs-fab-sleep-dot');
            if (dot) {
              var on = preventing;
              // 允许电脑休眠（allow）：完全不显示角标；禁止休眠时才亮起
              dot.style.display = on ? '' : 'none';
              dot.classList.toggle('on', on);
              dot.classList.toggle('until-done', d.mode === 'until-done');
              var t = '允许电脑休眠（默认）';
              var antiLock = d.antiLock === true; // daemon 是否已启用防锁屏（UserIsActive 断言）
              if (d.mode === 'keep') t = '持续禁止休眠：电脑/显示器保持唤醒' + (antiLock ? '，已防锁屏' : '');
              if (d.mode === 'keep' && d.displaySleep) t = '持续禁止休眠：仅阻止系统睡眠，显示器可黑屏（可能锁屏）';
              if (d.mode === 'until-done') t = '任务结束后允许休眠：AI 回复期间保持唤醒' + (antiLock ? '，已防锁屏' : '');
              if (d.mode === 'until-done' && d.displaySleep) t = '任务结束后允许休眠：暂禁中，显示器可黑屏（可能锁屏）';
              dot.title = t;
            }
            var fab = root.querySelector('.wbs-fab');
            if (fab) fab.setAttribute('title', WBS_BRAND);
            // until-done 模式：开启任务空闲检测；其他模式关闭
            if (d.mode === 'until-done') startUntilDoneCheck(); else stopUntilDoneCheck();
          }
        })
        .catch(function () {});
    }
    // 决策开关绑定迁移到 wireEnhancePane()（元素位于增强 pane）

    // 渲染账号列表
    function fmtDateTime(ts) {
      if (!ts) return '-';
      var d = new Date(ts);
      var p = function (n) { return String(n).padStart(2, '0'); };
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }

    function fmtCredits(value) {
      if (value === null || value === undefined || value === '') return '-';
      var n = Number(value);
      if (!isFinite(n)) return '-';
      return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function fmtCreditExpiry(ts) {
      if (!ts) return '有效期未知';
      var diff = Number(ts) - Date.now();
      if (diff <= 0) return '已过期';
      var minute = 60 * 1000;
      var hour = 60 * minute;
      var day = 24 * hour;
      if (diff < hour) return '剩余 ' + Math.max(1, Math.ceil(diff / minute)) + ' 分钟';
      if (diff < day) return '剩余 ' + Math.ceil(diff / hour) + ' 小时';
      if (diff < 30 * day) return '剩余 ' + Math.ceil(diff / day) + ' 天';
      return '剩余 ' + Math.ceil(diff / day) + ' 天';
    }

    function creditTone(ts) {
      var day = 24 * 3600 * 1000;
      if (!ts || Number(ts) - Date.now() > 30 * day) return 'safe';
      var diff = Number(ts) - Date.now();
      if (diff <= day) return 'within1';
      if (diff <= 3 * day) return 'within3';
      if (diff <= 7 * day) return 'within7';
      if (diff <= 15 * day) return 'within15';
      return 'within30';
    }

    function creditTip(segment) {
      var amount = fmtCredits(segment.remaining) + ' 积分';
      var source = segment.source === 'meter' ? '基础用量'
        : segment.source === 'package' ? '赠送与加量包'
        : segment.source;
      var expiry = fmtCreditExpiry(segment.expiresAt);
      var expiryLine = segment.expiresAt
        ? '到期时间 ' + fmtDateTime(segment.expiresAt) + '（' + expiry + '）'
        : '到期时间（' + expiry + '）';
      return (source || '积分') + '\n' + amount + '\n' + expiryLine;
    }

    function creditBarHtml(credits, segments) {
      var list = Array.isArray(segments) ? segments.filter(function (s) { return s && Number(s.remaining) > 0; }) : [];
      if (!list.length && Number(credits) > 0) {
        list = [{ remaining: Number(credits), total: Number(credits), expiresAt: null, source: '积分' }];
      }
      if (!list.length) return Number(credits) === 0 ? '' : '<div class="wbs-credit-empty">暂无可用积分</div>';
      var total = list.reduce(function (sum, s) { return sum + Math.max(0, Number(s.remaining) || 0); }, 0) || 1;
      var cells = list.map(function (segment) {
        var amount = Math.max(0, Number(segment.remaining) || 0);
        var weight = Math.max(0.008, amount / total);
        var tip = creditTip(segment);
        var attrTip = esc(tip).replace(/"/g, '&quot;');
        return '<span class="wbs-credit-segment ' + creditTone(segment.expiresAt) + '" style="flex:' + weight.toFixed(4) + ' 1 0" data-tip="' + attrTip + '" aria-label="' + attrTip + '"></span>';
      }).join('');
      return '<div class="wbs-credit-bar" role="img" aria-label="积分到期分布">' + cells + '</div>';
    }

    function creditBlockHtml(credits, segments, account) {
      if (isIdentityExpired(account)) return '';
      var checkin = checkinHtml(account);
      if (credits === undefined) return '<div class="wbs-credit-block"><div class="wbs-credit-line"><div class="wbs-credit-label"><span class="wbs-lbl">剩余积分</span>' + checkin + '</div><span class="wbs-credit-loading">读取中…</span></div></div>';
      if (credits === null) return '<div class="wbs-credit-block"><div class="wbs-credit-line"><div class="wbs-credit-label"><span class="wbs-lbl">剩余积分</span>' + checkin + '</div><span class="wbs-credit-na">-</span></div></div>';
      return '<div class="wbs-credit-block">' +
        '<div class="wbs-credit-line"><div class="wbs-credit-label"><span class="wbs-lbl">剩余积分</span>' + checkin + '</div><span class="wbs-credit-total">' + CREDIT_ICON + '<b>' + fmtCredits(credits) + '</b></span></div>' +
        creditBarHtml(credits, segments) +
        '</div>';
    }

    function nearestCreditExpiry(account) {
      var segments = account && Array.isArray(account.creditSegments) ? account.creditSegments : [];
      var nearest = Infinity;
      segments.forEach(function (segment) {
        if (!segment || Number(segment.remaining) <= 0) return;
        if (segment.expiresAt === null || segment.expiresAt === undefined || segment.expiresAt === '') return;
        var expiresAt = Number(segment.expiresAt);
        if (isFinite(expiresAt) && expiresAt < nearest) nearest = expiresAt;
      });
      return nearest;
    }

    function sortAccountsByCreditExpiry() {
      state.accounts = state.accounts.map(function (account, index) {
        return { account: account, index: index, expiresAt: nearestCreditExpiry(account) };
      }).sort(function (a, b) {
        if (a.expiresAt !== b.expiresAt) return a.expiresAt - b.expiresAt;
        return a.index - b.index;
      }).map(function (item) { return item.account; });
    }

    function reorderAccountCards() {
      var list = accountsPane.querySelector('.wbs-acct-list');
      if (!list) return;
      var cards = {};
      list.querySelectorAll('.wbs-card').forEach(function (card) {
        cards[card.getAttribute('data-uid')] = card;
      });
      state.accounts.forEach(function (account) {
        var card = cards[account.uid];
        if (card) list.appendChild(card);
      });
    }

    function pollAutoCopyJob(jobId, accountName) {
      if (!jobId) return;
      var attempts = 0;
      var poll = function () {
        attempts++;
        api('/api/sessions/auto-copy/status?id=' + encodeURIComponent(jobId)).then(function (d) {
          var job = d && d.job;
          if (!job) return;
          if (job.status === 'queued' || job.status === 'running') {
            if (attempts < 120) setBuildTimeout(poll, 700);
            return;
          }
          if (job.status === 'done') {
            toast('已切换到「' + accountName + '」，已复制 ' + job.total + ' 个会话', false, root);
          } else if (job.status === 'partial') {
            toast('已切换到「' + accountName + '」，复制完成，' + job.failed + ' 项失败', true, root);
          } else {
            toast('已切换到「' + accountName + '」，自动复制失败', true, root);
          }
          setBuildTimeout(refresh, 900);
        }).catch(function () {
          if (attempts < 120) setBuildTimeout(poll, 1000);
        });
      };
      setBuildTimeout(poll, 700);
    }

    // token 过期状态：< 7 天 / 已过期 -> 红字高亮
    function tokenState(expiresAt, account) {
      if (isIdentityExpired(account) && expiresAt) return { warn: true, expired: true, label: '已过期 ' + fmtDateTime(expiresAt) };
      if (!expiresAt) return { warn: false, label: '-' };
      var diff = expiresAt - Date.now();
      if (diff < 0) return { warn: true, expired: true, label: '已过期 ' + fmtDateTime(expiresAt) };
      if (diff < 24 * 3600 * 1000) return { warn: true, label: '即将过期 ' + fmtDateTime(expiresAt) };
      if (diff < 7 * 24 * 3600 * 1000) return { warn: true, label: fmtDateTime(expiresAt) };
      return { warn: false, label: fmtDateTime(expiresAt) };
    }

    function render(data) {
      state.accounts = data.accounts || [];
      state.current = data.current;
      state.creditRemaining = state.accounts.length;
      updateAccountSummary();
      var list = accountsPane.querySelector('.wbs-acct-list');
      if (!list) { list = el('div', 'wbs-acct-list'); accountsPane.insertBefore(list, accountsPane.firstChild); }
      list.innerHTML = '';
      if (!state.accounts.length) {
        list.appendChild(el('div', 'wbs-empty', '还没有备份账号。打开/登录一次 WorkBuddy 后会自动备份，稍后再来查看。'));
        return;
      }
      state.accounts.forEach(function (a) {
        var isCur = state.current && a.uid === state.current.uid;
        var ts = tokenState(a.tokenExpiresAt, a);
        var credits = a.credits;
        var card = el('div', 'wbs-card' + (isCur ? ' cur' : ''));
        card.setAttribute('data-uid', a.uid);
        var badge = isCur ? '<span class="wbs-badge">当前</span>' : '';
        // 当前登录账号隐藏切换操作；认证已过期的账号保留删除，但隐藏切换，避免进入登录页。
        // 同步按钮：所有账号（含当前账号）均展示，用于把该账号登录态同步到其他端。
        var expired = isIdentityExpired(a);
        var syncBtnHtml =
          '<button class="wbs-icon-btn wbs-sync" type="button" title="同步" data-uid="' + a.uid + '" data-name="' + (a.nickname || '未命名') + '">' + SYNC_SVG + '</button>';
        var ops = isCur
          ? '<div class="wbs-ops">' + syncBtnHtml + '</div>'
          : '<div class="wbs-ops">' + syncBtnHtml +
            (expired ? '' : '<button class="wbs-icon-btn wbs-acc-switch" type="button" title="切换" data-uid="' + a.uid + '" data-name="' + (a.nickname || '未命名') + '">' + SWITCH_SVG + '</button>') +
            '<button class="wbs-icon-btn wbs-del" type="button" title="删除" data-uid="' + a.uid + '" data-name="' + (a.nickname || '未命名') + '">' + TRASH_SVG + '</button>' +
            '</div>';
        // 国际版没有手机号：用 UIN（账号唯一数字标识）替代展示；国内版仍显示手机。
        // wbs-uin-cell 用于 UIN 模式下补齐标签与取值之间的间距（wbs-phone-cell 默认 gap:0 过于紧凑）。
        var isUinMode = !a.phone;
        var idLbl = a.phone ? '手机' : (a.uin ? 'UIN' : '账号');
        var idVal = a.phone ? esc(a.phone) : (a.uin ? esc(a.uin) : '-');
        card.innerHTML =
          '<div class="wbs-info">' +
          '<div class="wbs-row1"><div class="wbs-name-group"><span class="wbs-name">' + (a.nickname || '(未命名)') + '</span>' + badge + '</div>' + ops + '</div>' +
          '<div class="wbs-meta wbs-secondary-row">' +
          '<div class="wbs-mi wbs-phone-cell' + (isUinMode ? ' wbs-uin-cell' : '') + '"><span class="wbs-lbl">' + idLbl + '</span><span class="wbs-val">' + idVal + '</span></div>' +
          '<div class="wbs-mi wbs-token-cell"><span class="wbs-lbl">有效期至</span><span class="wbs-val' + (ts.warn ? ' wbs-warn' : '') + '">' + ts.label + '</span></div>' +
          '</div>' +
          '<div class="wbs-credit-cell' + (isIdentityExpired(a) ? ' wbs-credit-hidden' : '') + '">' + creditBlockHtml(credits, a.creditSegments, a) + '</div>' +
          '</div>';
        list.appendChild(card);
      });
      // 切换按钮：两击确认（第一次点击进入确认态，3s 内再点才真正切换，防止误触）
      list.querySelectorAll('.wbs-acc-switch').forEach(function (btn) {
        var armed = false;
        var armedTimer = null;
        btn.addEventListener('click', function () {
          if (btn.disabled) return;
          if (!armed) {
            armed = true;
            btn.classList.add('armed');
            btn.setAttribute('title', '再次点击确认切换');
            toast('再次点击确认切换为「' + btn.dataset.name + '」', false, root);
            clearTimeout(armedTimer);
            armedTimer = setBuildTimeout(function () {
              armed = false;
              btn.classList.remove('armed');
              btn.setAttribute('title', '切换');
            }, 3000);
            return;
          }
          clearTimeout(armedTimer);
          armed = false;
          btn.classList.remove('armed');
          btn.disabled = true;
          var prevTitle = btn.getAttribute('title');
          btn.setAttribute('title', '切换中…');
          api('/api/switch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uid: btn.dataset.uid, reload: true }),
          })
            .then(function (r) {
              var autoCopy = r && r.autoCopy;
              toast(
                r.reloaded
                  ? (autoCopy && autoCopy.jobId ? '已切换为「' + (r.nickname || r.uid) + '」，正在复制已标记会话…' : '已切换为「' + (r.nickname || r.uid) + '」，开始领取积分…')
                  : '已切换为「' + (r.nickname || r.uid) + '」，重启后生效',
                false,
                root
              );
              if (autoCopy && autoCopy.jobId) pollAutoCopyJob(autoCopy.jobId, r.nickname || r.uid);
              setBuildTimeout(refresh, 1500);
            })
            .catch(function (e) { toast('切换失败: ' + e.message, true, root); })
            .finally(function () { btn.disabled = false; btn.setAttribute('title', prevTitle || '切换'); });
        });
      });
      // 删除按钮：二次确认（永久删除本地备份）
      list.querySelectorAll('.wbs-del').forEach(function (btn) {
        var armed = false;
        btn.addEventListener('click', function () {
          if (btn.disabled) return;
          if (!armed) {
            armed = true;
            btn.classList.add('armed');
            btn.setAttribute('title', '确认永久删除');
            toast('将永久删除「' + btn.dataset.name + '」的本地备份，不可恢复', true, root);
            setBuildTimeout(function () {
              armed = false;
              btn.classList.remove('armed');
              btn.setAttribute('title', '删除');
            }, 3000);
            return;
          }
          btn.disabled = true;
          api('/api/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uid: btn.dataset.uid }),
          })
            .then(function () {
              toast('已永久删除「' + btn.dataset.name + '」的备份', false, root);
              refresh();
            })
            .catch(function (e) { toast('删除失败: ' + e.message, true, root); })
            .finally(function () {
              btn.disabled = false;
              btn.classList.remove('armed');
              btn.setAttribute('title', '删除');
              armed = false;
            });
        });
      });
      // 同步按钮：打开同步目标选择弹窗（plugin 目标已接入后端；桌面端/CLI 待接入）
      list.querySelectorAll('.wbs-sync').forEach(function (btn) {
        btn.addEventListener('click', function () {
          if (btn.disabled) return;
          openSyncModal(btn.dataset.name || '未命名', btn.dataset.uid || '');
        });
      });
    }

    function refresh() {
      if (!CAPS.accounts) {
        if (sessionsPane && !sessionsPane.dataset.built) buildSessionsPane();
        return;
      }
      stopCheckinPolling();
      state.creditRunId++;
      api('/api/accounts')
        .then(function (data) {
          render(data);
          watchCheckin(data.checkin);
          fetchCreditsForAccounts();
        })
        .catch(function (e) {
          var msg = '<div class="wbs-empty">无法连接本地服务: ' + e.message + '<br>请确认守护进程已运行</div>';
          accountsPane.innerHTML = msg;
        });
    }

    function updateAccountSummary() {
      var count = accountsPane.querySelector('#wbs-acct-count');
      var total = accountsPane.querySelector('#wbs-acct-total');
      if (!count || !total) return;
      count.textContent = String(state.accounts.length);
      if (!state.accounts.length) {
        state.creditSummaryValue = 0;
        total.textContent = fmtCredits(0);
        return;
      }
      // 初次打开时如果接口带有缓存积分，先把它作为已知值；后续刷新期间始终保留上一次完整结果。
      if (state.creditSummaryValue === null) {
        var cachedSum = 0;
        var cachedCount = 0;
        state.accounts.forEach(function (a) {
          if (typeof a.credits === 'number' && isFinite(a.credits)) {
            cachedSum += a.credits;
            cachedCount++;
          }
        });
        if (cachedCount) state.creditSummaryValue = cachedSum;
      }
      total.textContent = state.creditSummaryValue === null ? '查询中…' : fmtCredits(state.creditSummaryValue);
    }

    function updateCheckinCells(accounts) {
      var cards = accountsPane.querySelectorAll('.wbs-card');
      var byUid = {};
      (accounts || []).forEach(function (a) { if (a && a.uid) byUid[a.uid] = a; });
      (accounts || []).forEach(function (a) {
        for (var j = 0; j < state.accounts.length; j++) {
          if (state.accounts[j].uid === a.uid) { state.accounts[j].checkin = a.checkin; break; }
        }
      });
      for (var i = 0; i < cards.length; i++) {
        var uid = cards[i].getAttribute('data-uid');
        var account = byUid[uid];
        if (!account) continue;
        var cell = cards[i].querySelector('.wbs-credit-cell');
        var status = cell && cell.querySelector('.wbs-checkin-tag');
        if (status) status.outerHTML = checkinHtml(account);
        if (cell) {
          var hidden = isIdentityExpired(account);
          cell.classList.toggle('wbs-credit-hidden', hidden);
          if (hidden) cell.innerHTML = '';
          var switchBtn = cards[i].querySelector('.wbs-acc-switch');
          if (switchBtn) switchBtn.style.display = hidden ? 'none' : '';
        }
      }
    }

    function stopCheckinPolling() {
      if (state.checkinPollId !== null) {
        clearTimeout(state.checkinPollId);
        state.checkinPollId = null;
      }
    }

    function watchCheckin(status) {
      stopCheckinPolling();
      if (!status || !status.running || !state.open) return;
      var startedAt = Date.now();
      function poll() {
        state.checkinPollId = null;
        if (!state.open || Date.now() - startedAt > 45000) return;
        api('/api/accounts?checkinStatus=1')
          .then(function (data) {
            updateCheckinCells(data.accounts || []);
            if (data.checkin && data.checkin.running && state.open) {
              state.checkinPollId = setBuildTimeout(poll, 800);
            } else if (state.open) {
              // 签到请求完成后再查询积分，避免第一次打开面板显示签到前余额。
              fetchCreditsForAccounts();
            }
          })
          .catch(function () {
            if (state.open) state.checkinPollId = setBuildTimeout(poll, 1200);
          });
      }
      state.checkinPollId = setBuildTimeout(poll, 500);
    }

    // 积分查询按 200ms 节奏发起，允许请求重叠，避免前一个账号的慢接口阻塞后续账号。
    function fetchCreditsForAccounts() {
      if (!state.open || !state.accounts || !state.accounts.length) return;
      var runId = ++state.creditRunId;
      var accounts = state.accounts.slice();
      state.creditRemaining = accounts.length;
      function settleBatch() {
        if (runId !== state.creditRunId || state.creditRemaining !== 0) return;
        sortAccountsByCreditExpiry();
        reorderAccountCards();
        var sum = 0;
        state.accounts.forEach(function (account) {
          if (typeof account.credits === 'number' && isFinite(account.credits)) sum += account.credits;
        });
        state.creditSummaryValue = sum;
        updateAccountSummary();
      }
      function requestCredit(uid) {
        return new Promise(function (resolve, reject) {
          var settled = false;
          var timer = setTimeout(function () {
            if (settled) return;
            settled = true;
            reject(new Error('积分查询超时'));
          }, 20000);
          api('/api/credits', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uid: uid }),
          }).then(function (r) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(r);
          }).catch(function (e) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(e);
          });
        });
      }
      function queryAccount(a) {
        if (runId !== state.creditRunId || !state.open) return;
        // 无论成功、HTTP 错误、身份过期还是超时，都必须进入 finally。
        Promise.resolve().then(function () { return requestCredit(a.uid); })
          .then(function (r) {
            if (runId !== state.creditRunId) return;
            var credits = r && typeof r.credits === 'number' && isFinite(r.credits) ? r.credits : null;
            var segments = r && Array.isArray(r.segments) ? r.segments : [];
            for (var i = 0; i < state.accounts.length; i++) {
              if (state.accounts[i].uid === a.uid) { state.accounts[i].credits = credits; state.accounts[i].creditSegments = segments; break; }
            }
            updateCreditCell(a.uid, credits, segments);
          })
          .catch(function () {
            if (runId !== state.creditRunId) return;
            for (var i = 0; i < state.accounts.length; i++) {
              if (state.accounts[i].uid === a.uid) { state.accounts[i].credits = null; state.accounts[i].creditSegments = []; break; }
            }
            updateCreditCell(a.uid, null);
            // 静默失败，不弹 toast；避免面板抖动
          })
          .finally(function () {
            if (runId !== state.creditRunId) return;
            state.creditRemaining = Math.max(0, state.creditRemaining - 1);
            settleBatch();
          });
      }
      accounts.forEach(function (a, idx) {
        setBuildTimeout(function () { queryAccount(a); }, idx * 200);
      });
    }

    function updateCreditCell(uid, credits, segments) {
      var cards = accountsPane.querySelectorAll('.wbs-card');
      var card = null;
      for (var i = 0; i < cards.length; i++) {
        if (cards[i].getAttribute('data-uid') === uid) { card = cards[i]; break; }
      }
      if (!card) return;
      var elCredit = card.querySelector('.wbs-credit-cell');
      if (!elCredit) return;
      var account = null;
      for (var j = 0; j < state.accounts.length; j++) {
        if (state.accounts[j].uid === uid) { account = state.accounts[j]; break; }
      }
      var hidden = isIdentityExpired(account);
      elCredit.classList.toggle('wbs-credit-hidden', hidden);
      elCredit.innerHTML = hidden ? '' : creditBlockHtml(credits, segments || [], account);
    }

    // ===== 调试：暴露内部状态到 window.__wbsDiag（控制台可调） =====
    // Alt+D 切换调试面板可见。诊断期临时功能，确认修复后可移除。
    window.__wbsDiag = {
      findSendButton: findSendButton,
      findComposer: findComposer,
      shouldShowStash: shouldShowStash,
      isSendDisabled: isSendDisabled,
      composerHasContent: composerHasContent,
      syncStash: syncStash,
      insertStash: insertStash,
      removeStash: removeStash,
      get stashCount() { return document.querySelectorAll('.wbs-stash-inline').length; },
      get sendInfo() { var s = findSendButton(); if (!s) return null; var r = s.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), cls: (s.className || '').toString(), dis: !!s.disabled, ariaDis: s.getAttribute('aria-disabled') || '' }; },
      get composerInfo() { var e = findComposer(); if (!e) return null; return { tag: e.tagName, cls: (e.className || '').toString().slice(0, 80), textLen: (e.innerText || e.textContent || '').length }; },
      get sessionHealth() { return { sessionId: sessionHealth.sessionId, observed: sessionHealth.observed, result: sessionHealth.result }; },
    };
    var debugPanel = document.createElement('div');
    debugPanel.id = 'wbs-debug-panel';
    debugPanel.style.cssText = 'display:none;position:fixed;right:8px;top:8px;z-index:2147483647;background:rgba(0,0,0,.86);color:#fff;font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;padding:9px 12px;border-radius:6px;max-width:420px;white-space:pre-wrap;box-shadow:0 6px 18px rgba(0,0,0,.4);border:1px solid rgba(255,255,255,.1);';
    document.body.appendChild(debugPanel);
    function updateDebugPanel() {
      if (!alive) return;
      try {
        var sd = window.__wbsDiag.sendInfo, ed = window.__wbsDiag.composerInfo;
        var should = window.__wbsDiag.shouldShowStash();
        var cnt = window.__wbsDiag.stashCount;
        var sendDis = window.__wbsDiag.isSendDisabled(findSendButton());
        debugPanel.textContent =
          '[WBS DEBUG  Alt+D 切换]\n' +
          'shouldShowStash = ' + should + '   stashInDOM = ' + cnt + '\n' +
          'send:    x=' + (sd ? sd.x : '-') + '  dis=' + sd.dis + '  ariaDis=' + sd.ariaDis + '\n' +
          '         cls=' + (sd ? sd.cls.slice(0, 60) : 'null') + '\n' +
          'sendDisabled = ' + sendDis + '\n' +
          'editor:  tag=' + (ed ? ed.tag : '-') + '  textLen=' + (ed ? ed.textLen : '-') + '\n' +
          '         cls=' + (ed ? ed.cls : '-');
      } catch (e) { debugPanel.textContent = 'DEBUG ERR: ' + e.message; }
    }
    function onDebugKey(e) {
      if (e.altKey && (e.key === 'd' || e.key === 'D')) {
        debugPanel.style.display = debugPanel.style.display === 'block' ? 'none' : 'block';
        if (debugPanel.style.display === 'block') updateDebugPanel();
      }
    }
    listen(window, 'keydown', onDebugKey);
    debugTimer = setBuildInterval(updateDebugPanel, 500);
    setBuildTimeout(updateDebugPanel, 250);
    function markHealthGeneration() {
      sessionHealth.observed = true;
      sessionHealth.manualStop = false;
      sessionHealth.generationAt = Date.now();
      sessionHealth.lastBusyAt = Date.now();
      var baseline = readAssistantHealth();
      sessionHealth.baselineAssistantNode = baseline.node;
      sessionHealth.baselineAssistantTextLength = baseline.assistantTextLength;
    }
    function isHealthStopControl(button) {
      if (!button || !button.getAttribute) return false;
      var text = [button.innerText, button.getAttribute('aria-label'), button.getAttribute('title'), button.className].join(' ');
      return /(停止生成|停止|stop|cancel generation)/i.test(text);
    }
    function isHealthSendControl(button) {
      if (!button || !button.getAttribute || (button.closest && button.closest('.wbs-root'))) return false;
      var official = findSendButton();
      if (official && official === button) return true;
      var text = [button.innerText, button.getAttribute('aria-label'), button.getAttribute('title'), button.className].join(' ');
      return /(发送|send|提交)/i.test(text) && !/(重试|retry)/i.test(text);
    }
    listen(document, 'click', function (e) {
      var button = e.target && e.target.closest ? e.target.closest('button,[role="button"]') : null;
      if (!button) return;
      if (isHealthStopControl(button) && sessionHealth.observed) {
        sessionHealth.manualStop = true;
        return;
      }
      if (isHealthSendControl(button)) markHealthGeneration();
    }, true);
    listen(document, 'keydown', function (e) {
      if (!e || e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
      var composer = findComposer();
      if (composer && e.target && (e.target === composer || (e.target.closest && e.target.closest('[contenteditable="true"]') === composer))) {
        markHealthGeneration();
      }
    }, true);
    // The one-second poll is intentional here: observing the whole WorkBuddy body made
    // conversation-heavy pages pay for every React class mutation.
    // —— 会话健康检测已禁用（用户反馈误报「会话疑似异常停止」，见 2026-08-24 记录）：
    //     保留代码与元素，需要时恢复下面两行即可。
    // sessionHealthTimer = setBuildInterval(scanSessionHealth, 1000);
    // setBuildTimeout(scanSessionHealth, 250);
    // 初始同步防休眠状态（悬浮角标）
    syncSleepState();
    // 定期同步（30s）：daemon 重启或外部状态变化后角标保持一致
    sleepSyncTimer = setBuildInterval(syncSleepState, 30000);
    // 免打扰：启动即同步开关状态（若「弹窗自动点允许」已开启则挂上观察者，无需打开增强页）
    setBuildTimeout(syncNoDisturb, 1200);
    // 更新顶部红色角标：build 完成、send/editor/stash 状态（200ms 后写，等 syncStash 节流跑完）
    try {
      var badgeTimer = setBuildTimeout(function () {
        try {
          var badge = document.getElementById('wbs-diag-badge');
          if (!badge) return;
          var sd = window.__wbsDiag && window.__wbsDiag.sendInfo ? window.__wbsDiag.sendInfo : null;
          var ed = window.__wbsDiag && window.__wbsDiag.composerInfo ? window.__wbsDiag.composerInfo : null;
          var cnt = document.querySelectorAll('.wbs-stash-inline').length;
          badge.textContent = '[WBS-INJECT ' + new Date().toISOString().slice(11, 19) + '] build OK · stash=' + cnt + ' send=' + (sd ? 'Y' : 'N') + ' editor=' + (ed ? 'Y' : 'N');
        } catch (_) {}
      }, 220);
    } catch (_) {}

    var buildDiag = window.__wbsDiag;
    registerDisposer(function () {
      if (sendObserver) { try { sendObserver.disconnect(); } catch (e) {} sendObserver = null; }
      if (rowObserver) { try { rowObserver.disconnect(); } catch (e) {} rowObserver = null; }
      if (bodyObserver) { try { bodyObserver.disconnect(); } catch (e) {} bodyObserver = null; }
      sessionHealthTimer = null;
    });
    registerDisposer(function () {
      stopInspect();
      var inspector = document.getElementById('wbs-inspector');
      if (inspector) inspector.remove();
    });
    registerDisposer(function () {
      restoreAvatarDom();
      if (blurStyleEl) { blurStyleEl.remove(); blurStyleEl = null; }
      root.remove();
      stashBtn.remove();
      debugPanel.remove();
      var tags = document.querySelectorAll('.wbs-queue-tag');
      Array.prototype.forEach.call(tags, function (tag) { tag.remove(); });
      if (css) css.remove();
      if (window.__wbsDiag === buildDiag) {
        try { delete window.__wbsDiag; } catch (e) { window.__wbsDiag = null; }
      }
    });

    return { destroy: lifecycle.destroy, alive: lifecycle.alive };
  }

  function registerBuild(instance) {
    if (!instance) return null;
    currentBuild = instance;
    window.__wbsBuilds = window.__wbsBuilds || [];
    window.__wbsBuilds.push(instance);
    return instance;
  }

  var pendingReady = null;
  function start() {
    if (currentBuild && currentBuild.alive && currentBuild.alive()) return currentBuild;
    if (document.body) return registerBuild(build());
    if (pendingReady) return null;
    pendingReady = function onReady() {
      document.removeEventListener('DOMContentLoaded', onReady);
      pendingReady = null;
      if (!currentBuild) registerBuild(build());
    };
    document.addEventListener('DOMContentLoaded', pendingReady);
    return null;
  }

  function destroyWidget() {
    if (pendingReady) {
      document.removeEventListener('DOMContentLoaded', pendingReady);
      pendingReady = null;
    }
    if (currentBuild) {
      var doomedBuild = currentBuild;
      currentBuild = null;
      doomedBuild.destroy();
      if (window.__wbsBuilds && window.__wbsBuilds.filter) {
        window.__wbsBuilds = window.__wbsBuilds.filter(function (instance) { return instance !== doomedBuild; });
      }
    }
    if (css && css.parentNode) css.remove();
    try { delete window.__wbsWidget; } catch (e) { window.__wbsWidget = null; }
  }

  // 样式：参考 WorkBuddy 个人中心菜单（@image#1）——纯白卡片、圆润、简洁分区、灰色副文案
  var css = document.createElement('style');
  css.id = 'wbs-style';
  css.textContent = [
    '.wbs-root{position:fixed;right:22px;bottom:22px;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;font-size:13px;color:#1f1f1f;-webkit-font-smoothing:antialiased}',
    '.wbs-root.wbs-no-stash .wbs-stash-inline{display:none !important}',
    /* 机器人悬浮按钮（bitter-dragon-16 移植）：静态版 0.5 倍 · 无头顶尖角 · 眼睛双眨 */
    '.wbs-fab{position:fixed;right:22px;bottom:22px;z-index:2147483647;transform:scale(0.5);transform-origin:bottom right;cursor:pointer}',
    '.wbs-fab-sleep-dot{position:absolute;top:-4px;right:-4px;width:18px;height:18px;border-radius:50%;background:rgba(126,128,138,.55);border:2px solid #141416;box-shadow:0 1px 3px rgba(0,0,0,.5);transition:background .25s,box-shadow .25s;z-index:3}',
    '.wbs-fab-health-dot{position:absolute;top:-5px;left:-5px;width:14px;height:14px;border-radius:50%;background:#8b8f98;border:2px solid #141416;box-shadow:0 1px 3px rgba(0,0,0,.5);z-index:3}',
    '.wbs-fab-health-dot.running{background:#4da3ff}.wbs-fab-health-dot.blocked{background:#ffb03a}.wbs-fab-health-dot.error{background:#ef6262}.wbs-fab-health-dot.suspected{background:#f08a3c}.wbs-fab-health-dot.stopped{background:#9ca3af}',
    '.wbs-health-status{display:none;align-items:center;min-height:18px;padding:2px 7px;border-radius:999px;font-size:10px;line-height:14px;white-space:nowrap;color:var(--wb-color-text-secondary,#666);background:var(--wb-bg-tertiary,#f2f2f2)}',
    '.wbs-health-status.running,.wbs-health-status.blocked,.wbs-health-status.error,.wbs-health-status.suspected,.wbs-health-status.stopped{display:inline-flex}',
    '.wbs-health-status.running{color:#2369a8;background:rgba(77,163,255,.14)}.wbs-health-status.blocked{color:#9a5b00;background:rgba(255,176,58,.18)}.wbs-health-status.error{color:#a52828;background:rgba(239,98,98,.16)}.wbs-health-status.suspected{color:#9a4d0a;background:rgba(240,138,60,.17)}.wbs-health-status.stopped{color:var(--wb-color-text-secondary,#666)}',
    'html.cb-dark .wbs-health-status.running,html[data-theme="dark"] .wbs-health-status.running{color:#b9dcff;background:rgba(77,163,255,.22)}html.cb-dark .wbs-health-status.blocked,html[data-theme="dark"] .wbs-health-status.blocked{color:#ffd58d;background:rgba(255,176,58,.24)}html.cb-dark .wbs-health-status.error,html[data-theme="dark"] .wbs-health-status.error{color:#ffb3b3;background:rgba(239,98,98,.25)}html.cb-dark .wbs-health-status.suspected,html[data-theme="dark"] .wbs-health-status.suspected{color:#ffc18d;background:rgba(240,138,60,.24)}',
    '.wbs-fab-sleep-dot.on{background:#2ee59d;border-color:#0e3d2a;box-shadow:0 0 8px 1px rgba(46,229,157,.8);animation:wbs-sleep-pulse 2.2s ease-in-out infinite}',
    '.wbs-fab-sleep-dot.on.until-done{background:#ffb03a;border-color:#5c3a08;box-shadow:0 0 8px 1px rgba(255,176,58,.85);animation:wbs-sleep-pulse-amber 2.2s ease-in-out infinite}',
    '@keyframes wbs-sleep-pulse{0%,100%{box-shadow:0 0 5px 1px rgba(46,229,157,.6)}50%{box-shadow:0 0 13px 4px rgba(46,229,157,.95)}}',
    '@keyframes wbs-sleep-pulse-amber{0%,100%{box-shadow:0 0 5px 1px rgba(255,176,58,.6)}50%{box-shadow:0 0 13px 4px rgba(255,176,58,.95)}}',
    '.wbs-fab.hidden{display:none}',
    '.wbs-fab .click{position:relative}',
    '.wbs-fab .click > span:not(.wbs-fab-antenna):not(.wbs-fab-ear){display:none}',
    '.wbs-fab .button.shadow{display:none}',
    '.wbs-fab .button{position:relative;left:0;top:0;transform:none;cursor:pointer;border:solid 4px rgba(255,255,255,0);background-color:#141416;font-size:20px;color:#fff;border-color:rgba(255,255,255,0);box-shadow:0 4px 14px rgba(0,0,0,.45);border-radius:50px;display:flex;align-items:center;justify-content:center;width:100px;height:48px;box-sizing:content-box;padding:0;margin:0;outline:none;transition:background-color .2s,color .2s}',
    /* 贴消息队列时（queue 上方）保持纯色背景（与默认黑色一致，逻辑保留） */
    '.wbs-fab.fab--solid .button{background:#141416;box-shadow:0 4px 14px rgba(0,0,0,.45)}',
    '.wbs-fab .button:before,.wbs-fab .button:after{display:none}',
    '.wbs-fab .button.up{z-index:2}',
    '.wbs-fab-antenna{position:absolute;left:50%;top:-20px;width:4px;height:18px;transform:translateX(-50%);background:#141416;border-radius:3px;z-index:1;pointer-events:none}',
    '.wbs-fab-antenna-dot{position:absolute;left:50%;top:-7px;width:14px;height:14px;transform:translateX(-50%);border-radius:50%;background:#141416}',
    '.wbs-fab-ear{position:absolute;top:50%;width:20px;height:30px;transform:translateY(-50%);border-radius:58% 38% 38% 58% / 50%;background:#141416;overflow:hidden;z-index:1;pointer-events:none}',
    '.wbs-fab-ear::before{content:"";position:absolute;top:4px;left:4px;width:12px;height:22px;border-radius:58% 38% 38% 58% / 50%;background:#141416}',
    '.wbs-fab-ear::after{content:"";position:absolute;top:10px;left:8px;width:4px;height:10px;border-radius:50%;background:#141416}',
    '.wbs-fab-ear-left{left:-11px;transform:translateY(-50%) rotate(-8deg)}',
    '.wbs-fab-ear-right{right:-11px;transform:translateY(-50%) rotate(8deg);border-radius:38% 58% 58% 38% / 50%}',
    '.wbs-fab-ear-right::before{left:4px;border-radius:38% 58% 58% 38% / 50%}',
    '.wbs-fab .click .button .speak~.speak{display:none}',
    '.wbs-fab .speak{position:relative;z-index:2;font-size:15px}',
    '.wbs-fab .wrap{position:relative;width:100px;height:40px;margin:0 2rem;color:#fff;line-height:40px;font-size:2rem;text-align:center;font-weight:400;margin-bottom:0;display:flex;gap:5px}',
    '.wbs-fab .eye{position:relative;margin:auto;top:0;bottom:0;background:#fff;width:40px;height:40px;border-radius:50%;display:inline-block;animation:wbs-cc-double-blink 4s cubic-bezier(0.785,0.135,0.15,0.86) infinite;overflow:hidden}',
    '@keyframes wbs-cc-double-blink{0%,8%{height:40px}10%,12%{height:10px}13%{height:40px}14%,16%{height:0}18%,100%{height:40px}}',
    '.wbs-fab .eye:before{content:"";position:absolute;margin:auto;width:10px;height:10px;left:0;right:0;top:0;bottom:0;border-radius:50%;background:#141416}',
    '.wbs-fab .down:before{animation:wbs-cc-downb 4s cubic-bezier(0.785,0.135,0.15,0.86) infinite}',
    '@keyframes wbs-cc-downb{0%,10%{top:0;left:-10px}20%,40%{top:50%;left:-10px}50%,100%{top:0;left:-10px}}',
    '.wbs-fab .right-blink:before{animation:wbs-cc-rightb 4s cubic-bezier(0.785,0.135,0.15,0.86) infinite}',
    '@keyframes wbs-cc-rightb{0%,10%{top:0;left:50%}20%,40%{top:50%;left:50%}50%,100%{top:0;left:50%}}',
    '.wbs-fab .up-blink:before{animation:wbs-cc-upb 4s cubic-bezier(0.785,0.135,0.15,0.86) infinite}',
    '@keyframes wbs-cc-upb{0%,10%{top:0;left:0%}20%,40%{top:-50%;left:0%}50%,100%{top:0;left:0%}}',
    '.wbs-fab:hover{transform:scale(0.5)}',
    '.wbs-fab:active{transform:scale(0.5) translate(2px,2px)}',
    /* 面板：毛玻璃主题（半透明 + 模糊，背景图透出） */
    '.wbs-panel{position:absolute;right:0;bottom:0;width:520px;max-width:94vw;height:650px;max-height:650px;background:color-mix(in srgb,var(--wb-bg-popover,#fff) 72%,transparent);border:1px solid var(--wb-border-subtle,#f0f0f0);border-radius:18px;box-shadow:0 20px 60px rgba(0,0,0,.28);display:none;flex-direction:column;overflow:hidden;backdrop-filter:blur(28px) saturate(1.25);-webkit-backdrop-filter:blur(28px) saturate(1.25)}',
    '.wbs-panel.show{display:flex}',
    '.wbs-head{display:flex;align-items:center;justify-content:space-between;padding:16px 18px 12px;border-bottom:1px solid var(--wb-border-subtle,#f0f0f0);background:color-mix(in srgb,var(--wb-bg-secondary,#fff) 30%,transparent)}',
    '.wbs-head-left{display:flex;align-items:center;gap:9px;min-width:0}',
    '.wbs-title{font-size:16px;font-weight:700;color:var(--wb-color-text-primary,#1f1f1f);letter-spacing:.3px;cursor:default;user-select:none}',
    '.wbs-ghbtn{display:flex;align-items:center;justify-content:center;width:24px;height:24px;flex-shrink:0;color:var(--wb-icon-tertiary,#999);border-radius:6px;text-decoration:none;transition:color .15s,background .15s}',
    '.wbs-ghbtn:hover{color:var(--wb-color-text-primary,#1f1f1f);background:var(--wb-bg-hover,#f5f5f5)}',
    '.wbs-ghbtn svg{display:block}',
    '.wbs-btn-close{border:none;background:none;color:var(--wb-icon-tertiary,#999);font-size:16px;cursor:pointer;padding:4px 6px;border-radius:6px;line-height:1}',
    '.wbs-btn-close:hover{color:var(--wb-color-text-primary,#1f1f1f);background:var(--wb-bg-hover,#f5f5f5)}',
    '.wbs-body{overflow-y:auto;padding:10px 10px 6px;flex:1;min-height:0;height:calc(650px - 170px);max-height:none}',
    /* 账号卡片：头像 + 信息 + 右侧操作 */
    '.wbs-card{display:block;padding:10px 12px;border-radius:12px;margin-bottom:4px;transition:background .12s}',
    '.wbs-card:hover{background:var(--wb-bg-hover,#f7f8fa)}',
    '.wbs-card.cur{background:var(--wb-bg-hover,#f5f5f5)}',
    '.wbs-ava{width:34px;height:34px;border-radius:50%;background:var(--wb-bg-tertiary,#f0f0f0);color:var(--wb-icon-secondary,#555);display:flex;align-items:center;justify-content:center;font-weight:600;flex-shrink:0;font-size:14px}',
    '.wbs-info{min-width:0}',
    '.wbs-row1{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:7px;min-height:26px}',
    '.wbs-name-group{display:flex;align-items:center;gap:6px;min-width:0}',
    '.wbs-name{font-size:14px;font-weight:600;color:var(--wb-color-text-primary,#1f1f1f)}',
    '.wbs-meta{display:flex;flex-direction:column;gap:2px}',
    '.wbs-secondary-row{flex-direction:row;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px}',
    '.wbs-mi{display:flex;align-items:center;gap:6px;font-size:12px;line-height:1.4}',
    '.wbs-phone-cell,.wbs-token-cell{flex:1;min-width:0}',
    '.wbs-phone-cell{gap:0}',
    // UIN 模式（国际版无手机号时用 UIN 替代）：标签与数字之间保留正常间距
    '.wbs-phone-cell.wbs-uin-cell{gap:8px}',
    '.wbs-token-cell{justify-content:flex-end}',
    '.wbs-phone-cell .wbs-lbl,.wbs-token-cell .wbs-lbl,.wbs-credit-label .wbs-lbl{width:auto}',
    '.wbs-phone-cell .wbs-val,.wbs-token-cell .wbs-val{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.wbs-lbl{color:var(--wb-icon-tertiary,#999);flex-shrink:0;width:60px;white-space:nowrap}',
    '.wbs-val{color:var(--wb-color-text-primary,#1f1f1f);font-variant-numeric:tabular-nums;word-break:break-all}',
    '.wbs-warn{color:#f53f3f;font-weight:600}',
    /* 积分到期分布：每个色块代表一个独立额度，悬浮显示额度与到期时间 */
    '.wbs-credit-cell{display:block!important;width:100%;min-width:0}',
    '.wbs-credit-hidden{display:none!important}',
    '.wbs-credit-block{width:100%;min-width:0}',
    '.wbs-credit-line{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}',
    '.wbs-credit-label{display:inline-flex;align-items:center;gap:8px;min-width:0}',
    '.wbs-credit-total{display:inline-flex;align-items:center;gap:4px;color:var(--wb-color-text-primary,#1f1f1f);font-size:12px;font-variant-numeric:tabular-nums}',
    '.wbs-credit-total b{font-weight:700}',
    '.wbs-credit-bar{display:flex;align-items:stretch;gap:2px;width:100%;height:5px;min-height:5px;border-radius:0;overflow:visible;background:color-mix(in srgb,var(--wb-bg-tertiary,#e8e8eb) 70%,transparent)}',
    '.wbs-credit-segment{position:relative;display:block;min-width:3px;height:5px;border-radius:0;background:#19191c;border:1px solid rgba(255,255,255,.16);cursor:default;transition:filter .15s,transform .15s}',
    '.wbs-credit-segment:first-child{border-radius:3px 0 0 3px}',
    '.wbs-credit-segment:last-child{border-radius:0 3px 3px 0}',
    '.wbs-credit-segment:first-child:last-child{border-radius:3px}',
    '.wbs-credit-segment:hover{z-index:3;filter:brightness(1.12);transform:scaleY(1.35)}',
    /* 官方 WorkBuddy 主题：绿色梯度；越接近到期透明度越高，1 天内只保留很轻的颜色痕迹 */
    '.wbs-credit-segment.safe{background:rgba(34,197,94,.78);border-color:rgba(34,197,94,.78)}',
    '.wbs-credit-segment.within30{background:rgba(34,197,94,.62);border-color:rgba(34,197,94,.62)}',
    '.wbs-credit-segment.within15{background:rgba(34,197,94,.46);border-color:rgba(34,197,94,.46)}',
    '.wbs-credit-segment.within7{background:rgba(34,197,94,.32);border-color:rgba(34,197,94,.32)}',
    '.wbs-credit-segment.within3{background:rgba(34,197,94,.20);border-color:rgba(34,197,94,.20)}',
    '.wbs-credit-segment.within1{background:rgba(34,197,94,.10);border-color:rgba(34,197,94,.10)}',
    /* WorkDaddy 主题：蓝紫色梯度，保持深色背景上的柔和对比 */
    'html.cb-dark .wbs-credit-segment.safe{background:rgba(126,134,255,.82);border-color:rgba(126,134,255,.82)}',
    'html.cb-dark .wbs-credit-segment.within30{background:rgba(126,134,255,.68);border-color:rgba(126,134,255,.68)}',
    'html.cb-dark .wbs-credit-segment.within15{background:rgba(126,134,255,.54);border-color:rgba(126,134,255,.54)}',
    'html.cb-dark .wbs-credit-segment.within7{background:rgba(126,134,255,.40);border-color:rgba(126,134,255,.40)}',
    'html.cb-dark .wbs-credit-segment.within3{background:rgba(126,134,255,.25);border-color:rgba(126,134,255,.25)}',
    'html.cb-dark .wbs-credit-segment.within1{background:rgba(126,134,255,.12);border-color:rgba(126,134,255,.12)}',
    '.wbs-credit-tooltip{display:none;position:fixed;z-index:2147483647;min-width:170px;max-width:260px;padding:8px 10px;border-radius:7px;background:#151518;color:#fff;font-size:11px;font-weight:500;line-height:1.55;white-space:pre-line;box-shadow:0 8px 22px rgba(0,0,0,.28);pointer-events:none}',
    '.wbs-credit-empty{height:5px;border-radius:0;background:color-mix(in srgb,var(--wb-bg-tertiary,#e8e8eb) 70%,transparent);color:var(--wb-icon-tertiary,#999);font-size:10px;line-height:5px;text-align:center}',
    '.wbs-credit-icon{width:14px;height:14px;vertical-align:middle;flex-shrink:0}',
    '.wbs-credit-loading{color:var(--wb-icon-tertiary,#999);font-size:12px}',
    '.wbs-credit-na{color:var(--wb-icon-tertiary,#999);font-size:12px}',
    '.wbs-ck{font-size:11px;font-weight:600}',
    '.wbs-checkin-tag{display:inline-flex;align-items:center;min-height:18px;padding:1px 7px;border-radius:999px;white-space:nowrap}',
    '.wbs-checkin-tag.pending{background:var(--wb-bg-tertiary,#f0f0f0);color:var(--wb-icon-tertiary,#999)}',
    '.wbs-checkin-tag.ok{background:#edf9ef;border:1px solid #b9e8c0;color:#28753a;box-shadow:inset 0 0 0 1px rgba(255,255,255,.55)}',
    'html.cb-dark .wbs-checkin-tag.ok{background:rgba(19,24,33,.78);border-color:rgba(214,220,232,.24);color:#f3f5fa;box-shadow:inset 0 0 0 1px rgba(255,255,255,.06)}',
    '.wbs-checkin-tag.fail{background:rgba(239,68,68,.1);color:#dc2626}',
    '.wbs-ck.ok{color:var(--wb-color-text-primary,#1f1f1f)}',
    '.wbs-ck.pending{color:var(--wb-icon-tertiary,#999)}',
    '.wbs-ck.fail{color:#f53f3f}',
    /* 右侧操作图标按钮：更轻量 */
    '.wbs-ops{display:flex;flex-direction:row;gap:6px;flex-shrink:0;margin-left:4px}',
    '.wbs-icon-btn{width:26px;height:26px;border-radius:7px;display:flex;align-items:center;justify-content:center;cursor:pointer;border:1px solid transparent;padding:0;transition:all .15s;background:var(--wb-bg-hover,#f7f8fa);color:var(--wb-icon-secondary,#555)}',
    '.wbs-icon-btn svg{width:16px;height:16px;flex-shrink:0}', // 图标保持 16x16
    /* 账号切换按钮（wbs-acc-switch，与开关 .wbs-switch 区分）：与删除按钮同尺寸同风格 */
    '.wbs-acc-switch:hover{background:var(--wb-bg-hover,#e8e9eb);color:var(--wb-color-text-primary,#1f1f1f)}',
    '.wbs-acc-switch.armed{background:#141416;color:#fff}',
    /* 删除按钮：与切换按钮同风格（灰底图标），hover/armed 才显红 */
    '.wbs-del{background:var(--wb-bg-hover,#f7f8fa);color:var(--wb-icon-secondary,#555);border-color:transparent}',
    '.wbs-del:hover{background:#ffecec;color:#f53f3f;border-color:transparent}',
    '.wbs-del.armed{background:#f53f3f;color:#fff;border-color:#f53f3f}',
    '.wbs-icon-btn:disabled{opacity:.5;cursor:not-allowed}',
    /* 「当前」标签 */
    '.wbs-badge{display:inline-flex;align-items:center;font-size:10px;line-height:1;padding:2px 7px;border-radius:999px;background:#1f1f1f;color:#fff;flex-shrink:0;font-weight:600}',
    '.wbs-empty{text-align:center;color:var(--wb-icon-tertiary,#999);padding:28px 12px;font-size:13px;line-height:1.8}',
    /* 底部 */
    '.wbs-foot{padding:12px 14px;border-top:1px solid var(--wb-border-subtle,#f0f0f0);display:flex;flex-direction:column;gap:9px;background:color-mix(in srgb,var(--wb-bg-secondary,#fff) 30%,transparent)}',
    '.wbs-logout-btn{width:100%;border:1px solid color-mix(in srgb,#f53f3f 35%,transparent);background:color-mix(in srgb,#f53f3f 8%,transparent);color:#f53f3f;border-radius:10px;padding:9px 10px;font-size:13px;cursor:pointer;transition:all .15s;font-weight:600;display:inline-flex;align-items:center;justify-content:center;gap:6px}',
    '.wbs-logout-btn:hover{background:color-mix(in srgb,#f53f3f 14%,transparent)}',
    '.wbs-logout-btn.armed{background:#f53f3f;border-color:#f53f3f;color:#fff}',
    '.wbs-logout-btn:disabled{opacity:.5;cursor:not-allowed}',
    '.wbs-logout-btn svg{flex-shrink:0}',
    '.wbs-theme-row{display:flex;align-items:center;gap:8px}',
    '.wbs-theme-label{font-size:12px;color:var(--wb-icon-tertiary,#888);flex-shrink:0;font-weight:500}',
    '.wbs-theme-select{flex:1;min-width:0;padding:7px 10px;border:1px solid var(--wb-border-default,#e5e5e5);border-radius:9px;background:var(--wb-bg-popover,#fff);color:var(--wb-color-text-primary,#1f1f1f);font-size:12px;outline:none;cursor:pointer;transition:border-color .15s}',
    '.wbs-theme-select:focus{border-color:var(--wb-border-strong,#bbb)}',
    '.wbs-theme-upload{flex-shrink:0;padding:7px 12px;border:1px solid var(--wb-border-default,#e5e5e5);border-radius:9px;background:var(--wb-bg-popover,#fff);color:var(--wb-icon-secondary,#555);font-size:12px;cursor:pointer;line-height:1;transition:all .15s}',
    '.wbs-theme-upload:hover{background:var(--wb-bg-hover,#f5f5f5);color:var(--wb-color-text-primary,#1f1f1f);border-color:var(--wb-border-strong,#bbb)}',
    '.wbs-theme-inspect{flex-shrink:0;padding:7px 10px;border:1px solid var(--wb-border-default,#e5e5e5);border-radius:9px;background:var(--wb-bg-popover,#fff);color:var(--wb-icon-secondary,#555);font-size:12px;cursor:pointer;line-height:1;transition:all .15s}',
    '.wbs-theme-inspect:hover{background:var(--wb-bg-hover,#f5f5f5);color:var(--wb-color-text-primary,#1f1f1f);border-color:var(--wb-border-strong,#bbb)}',
    '.wbs-theme-inspect.active{background:#22d3ee;color:#04222b;border-color:#22d3ee}',
    '.wbs-theme-devtools{flex-shrink:0;padding:7px 10px;border:1px solid var(--wb-border-default,#e5e5e5);border-radius:9px;background:var(--wb-bg-popover,#fff);color:var(--wb-icon-secondary,#555);font-size:11px;cursor:pointer;line-height:1;transition:all .15s}',
    '.wbs-theme-devtools:hover{background:var(--wb-bg-hover,#f5f5f5);color:var(--wb-color-text-primary,#1f1f1f);border-color:var(--wb-border-strong,#bbb)}',
    /* 元素检查器浮层 */
    '.wbs-inspector{position:fixed;right:16px;top:16px;width:360px;max-height:calc(100vh - 40px);overflow:auto;background:var(--wb-bg-popover,#fff);border:1px solid var(--wb-border-default,#e5e5e5);border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.18);z-index:2147483647;font-size:12px;color:var(--wb-color-text-primary,#1f1f1f);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}',
    '.wbs-ins-head{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-bottom:1px solid #eee;font-weight:600;position:sticky;top:0;background:var(--wb-bg-popover,#fff);z-index:1;word-break:break-all}',
    '.wbs-ins-btns{display:flex;gap:6px;flex-shrink:0;margin-left:8px}',
    '.wbs-ins-btns button{border:1px solid #ddd;background:var(--wb-bg-popover,#fff);border-radius:6px;padding:3px 8px;font-size:11px;cursor:pointer;color:var(--wb-icon-secondary,#555);line-height:1}',
    '.wbs-ins-btns button:hover{background:var(--wb-bg-hover,#f5f5f5)}',
    '.wbs-ins-btns .wbs-ins-copy{background:#22d3ee;border-color:#22d3ee;color:#04222b;font-weight:600}',
    '.wbs-ins-btns .wbs-ins-copy:hover{background:#67e8f9;border-color:#67e8f9}',
    '.wbs-ins-sec{padding:8px 12px 2px;font-size:11px;color:var(--wb-icon-tertiary,#888);font-weight:600}',
    '.wbs-ins-row{display:flex;justify-content:space-between;gap:8px;padding:3px 12px;align-items:center}',
    '.wbs-ins-row span{color:#666;flex-shrink:0;white-space:nowrap}',
    '.wbs-ins-row span em{font-style:normal;color:#aaa;font-size:10px;margin-left:4px;font-family:ui-monospace,Menlo,monospace}',
    '.wbs-ins-row code{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:#1a7f37;word-break:break-all;text-align:right}',
    '.wbs-ins-rule{font-family:ui-monospace,Menlo,monospace;font-size:10px;color:var(--wb-icon-secondary,#555);background:#f7f7f7;border-radius:4px;margin:2px 12px;padding:3px 6px;word-break:break-all}',
    '.wbs-ins-path{font-family:ui-monospace,Menlo,monospace;font-size:10px;color:#0a5fd0;background:#f2f7ff;border-radius:4px;margin:0 12px 4px;padding:5px 8px;word-break:break-all;line-height:1.5}',
    '.wbs-ins-rule.muted{color:var(--wb-icon-tertiary,#999)}',
    '.wbs-ins-tip{padding:8px 12px;font-size:10px;color:var(--wb-icon-tertiary,#999);border-top:1px solid #eee;line-height:1.6}',
    '#wbs-inspect-tip{position:fixed;left:50%;top:12px;transform:translateX(-50%);background:rgba(34,211,238,.95);color:#04222b;padding:6px 16px;border-radius:20px;font-size:12px;z-index:2147483647;box-shadow:0 4px 12px rgba(0,0,0,.15);pointer-events:none;white-space:nowrap}',
    /* 决策弹窗开关（iOS 风格 switch，跟随主题按钮色） */
    '.wbs-ask-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px}',
    '.wbs-ask-label{display:flex;align-items:baseline;gap:6px;font-size:12px;color:var(--wb-color-text-secondary,#444);font-weight:600;min-width:0;line-height:1.3}',
    '.wbs-ask-hint{font-size:11px;color:#9a9a9a;font-weight:400}',
    '.wbs-switch{position:relative;display:inline-block;width:36px;height:20px;flex-shrink:0;cursor:pointer}',
    '.wbs-switch input{opacity:0;width:0;height:0}',
    '.wbs-switch-slider{position:absolute;inset:0;border-radius:20px;background:rgba(255,255,255,.16);box-shadow:inset 0 0 0 1px rgba(255,255,255,.22);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);transition:background .18s}',
    '.wbs-switch-slider:before{content:"";position:absolute;width:16px;height:16px;left:2px;top:2px;border-radius:50%;background:var(--wb-bg-popover,#fff);transition:transform .18s;box-shadow:0 1px 2px rgba(0,0,0,.2)}',
    '.wbs-switch input:checked + .wbs-switch-slider{background:#f2f2f4;box-shadow:inset 0 0 0 1px rgba(255,255,255,.35)}',
    '.wbs-switch input:checked + .wbs-switch-slider:before{background:#111113;box-shadow:0 1px 3px rgba(0,0,0,.35)}',
    '.wbs-switch input:checked + .wbs-switch-slider:before{transform:translateX(16px)}',
    /* 背景毛玻璃开关 + 模糊度进度条 */
    '.wbs-blur-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px}',
    '.wbs-blur-label{display:flex;align-items:baseline;gap:6px;font-size:12px;color:var(--wb-color-text-secondary,#444);font-weight:600;min-width:0;line-height:1.3;white-space:nowrap}',
    '.wbs-blur-hint{font-size:11px;color:#9a9a9a;font-weight:400}',
    '.wbs-blur-ctrl{display:flex;align-items:center;gap:8px;margin-top:6px;padding-left:2px}',
    '.wbs-blur-ctrl input[type=range]{flex:1;min-width:0;accent-color:#f2f2f4;height:4px;cursor:pointer}',
    '.wbs-blur-val{font-size:11px;color:var(--wb-icon-tertiary,#888);flex-shrink:0;min-width:22px;text-align:right;font-variant-numeric:tabular-nums}',
    /* 所见即所得定制器浮层 */
    /* 暂存提示词：position: fixed 用 right 锚定（left:auto），hover 时 width 增大 → 左边向左展开（参考 wbs-fab）；默认隐藏，JS 控制 display */
    '.wbs-stash-inline{position:fixed;left:auto;display:flex;align-items:center;justify-content:flex-start;gap:0;width:32px;height:32px;border-radius:50%;background:var(--wb-button-primary-bg);cursor:pointer;flex-shrink:0;color:var(--wb-button-primary-fg);box-shadow:0 1px 3px rgba(0,0,0,.2);overflow:hidden;padding:0 8px;transition:width .18s,border-radius .18s,padding .15s,background .15s;z-index:auto;top:0;right:0}',
    // AI 端内联进操作栏按钮组（flex）：取消 fixed 参与布局，保持与其他按钮一致的圆形
    '.wbs-stash-inline.wbs-stash-inline-inline{position:static;left:auto;right:auto;top:auto;border-radius:50%;box-shadow:none}',
    '.wbs-stash-inline.wbs-stash-inline-inline:hover{width:113px;border-radius:40px}',
    '.wbs-stash-inline .wbs-stash-ico{display:flex;align-items:center;justify-content:center;flex-shrink:0}',
    '.wbs-stash-inline .wbs-stash-ico svg{width:16px;height:16px;display:block}',
    '.wbs-stash-inline .wbs-stash-txt{opacity:0;max-width:0;overflow:hidden;white-space:nowrap;font-size:13px;font-weight:500;margin-left:0;transition:opacity .2s,max-width .25s,margin-left .25s}',
    '.wbs-stash-inline:hover{width:113px;border-radius:40px;padding-right:5px}',
    '.wbs-stash-inline:hover .wbs-stash-txt{opacity:1;max-width:76px;margin-left:7px}',
    '.wbs-stash-inline:active{background:var(--wb-button-primary-bg)}',
    /* 队列消息「暂存提示词」标签：入队的暂存消息在操作按钮最左侧 */
    '.wbs-queue-tag{display:inline-flex;align-items:center;gap:3px;background:color-mix(in srgb,var(--wb-bg-primary) 72%,transparent);color:var(--wb-color-text-primary);border-radius:999px;font-size:11px;line-height:1;padding:3px 8px 3px 6px;margin-right:6px;font-weight:600;user-select:none;vertical-align:middle;white-space:nowrap;box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--wb-border-subtle) 60%,transparent)}',
    '.wbs-queue-tag svg{flex-shrink:0}',
    /* 暂存项禁拖 + 隐藏拖拽图标：data-wbs-stash 由 syncQueueTags 幂等标记，普通项不受影响 */
    '.cb-message-queue-item[data-wbs-stash="1"]{cursor:default}',
    '.cb-message-queue-item[data-wbs-stash="1"] .cb-message-queue-item-left .prompt-icon{visibility:hidden}',
    /* 暂存消息：拖拽把手置灰 + 不可拖拽 */
    '.wbs-stash-item{cursor:default}',
    '.wbs-stash-item .cb-message-queue-item-left .prompt-icon{opacity:.28;cursor:default;filter:grayscale(1)}',
    '.wbs-stash-item .cb-message-queue-item-left .content{opacity:.55}',
    '.wbs-spin{display:inline-block;width:13px;height:13px;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:wbs-spin-rotate .8s linear infinite;vertical-align:-2px}',
    '@keyframes wbs-spin-rotate{to{transform:rotate(360deg)}}',
    '.wbs-toast{position:fixed;left:50%;bottom:100px;transform:translateX(-50%);background:#1f1f1f;color:#fff;padding:9px 16px;border-radius:10px;font-size:12px;z-index:2147483647;opacity:1;transition:opacity .3s;max-width:80vw;pointer-events:none;box-shadow:0 6px 20px rgba(0,0,0,.18)}',
    '.wbs-toast.err{background:#f53f3f}',
    '.wbs-toast.out{opacity:0}',
    /* ===== 新版 Tab 布局（账号/主题/增强）===== */
    '.wbs-tabs{display:flex;gap:6px;padding:10px 14px 0;background:color-mix(in srgb,var(--wb-bg-secondary,#fff) 25%,transparent)}',
    '.wbs-tab{flex:1;display:flex;align-items:center;justify-content:center;gap:6px;padding:8px 0;border:none;border-radius:10px;background:transparent;color:var(--wb-icon-secondary,#666);font-size:13px;font-weight:600;cursor:pointer;transition:all .18s;font-family:inherit}',
    '.wbs-tab-ico{font-size:14px;line-height:1}',
    '.wbs-tab:hover{background:var(--wb-bg-hover,#f5f5f5);color:var(--wb-color-text-primary,#1f1f1f)}',
    '.wbs-tab.active{background:var(--wb-button-primary-bg,#1f1f1f);color:var(--wb-button-primary-fg,#fff);box-shadow:0 2px 10px color-mix(in srgb,var(--wb-button-primary-bg,#1f1f1f) 30%,transparent)}',
    '.wbs-pane{display:none;padding:2px 2px 6px}',
    '.wbs-pane.active{display:flex;flex-direction:column;height:100%;min-height:0}',
    /* 分组卡片（主题/增强 tab） */
    '.wbs-pcard{background:color-mix(in srgb,var(--wb-bg-secondary,#fff) 18%,transparent);border:1px solid var(--wb-border-subtle,#f0f0f0);border-radius:14px;padding:10px 12px;margin-bottom:8px;backdrop-filter:blur(16px) saturate(1.2);-webkit-backdrop-filter:blur(16px) saturate(1.2)}',
    '.wbs-pcard-title{display:flex;align-items:baseline;gap:8px;font-size:13px;font-weight:700;color:var(--wb-color-text-primary,#1f1f1f);margin-bottom:8px}',
    '.wbs-pcard-sub{font-size:11px;color:var(--wb-icon-tertiary,#999);font-weight:400}',
    /* 免打扰：标题行右置批量开关 + 三列 grid 对齐（标题/小标题/开关，所有小标题左对齐） */
    '.wbs-nd-head{display:flex;align-items:center;gap:6px}',
    '.wbs-nd-head #wbs-nd-count{margin-left:2px}',
    '.wbs-nd-head .wbs-nd-all-wrap{margin-left:auto;display:flex;align-items:center;gap:5px;cursor:pointer}',
    '.wbs-nd-all-label{font-size:11px;color:var(--wb-color-text-secondary,#444)}',
    '.wbs-nd-row{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:8px;padding:7px 0;border-top:1px solid var(--wb-border-subtle,#f0f0f0)}',
    '.wbs-nd-row:first-of-type{border-top:none}',
    '.wbs-nd-title{font-size:12px;font-weight:600;color:var(--wb-color-text-primary,#1f1f1f);white-space:nowrap}',
    '.wbs-nd-hint{font-size:11px;color:var(--wb-icon-tertiary,#999);text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    /* 会话页：筛选 + 批量 + 列表 + 迁移/删除弹窗 */
    '.wbs-sess-filters{display:flex;flex-direction:column;gap:8px;margin-bottom:10px}',
    '.wbs-sess-filter-row{display:flex;align-items:center;gap:8px}',
    '.wbs-sess-flabel{font-size:12px;color:var(--wb-icon-tertiary,#999);flex-shrink:0;width:28px}',
    /* 账号筛选：Select 下拉（尺寸参考主题页「更换头像」按钮） */
    '.wbs-sess-select{flex:1;min-width:0;padding:7px 10px;border:1px solid var(--wb-border-default,#e5e5e5);border-radius:9px;background:var(--wb-bg-popover,#fff);color:var(--wb-color-text-primary,#1f1f1f);font-size:12px;cursor:pointer;transition:all .15s;font-family:inherit;line-height:1.2}',
    '.wbs-sess-select:hover{border-color:var(--wb-border-strong,#bbb)}',
    '.wbs-sess-select:focus{outline:none;border-color:var(--wb-accent-blue,#4f86ff)}',
    /* 时间筛选：Segment 组件（容器灰底 + 激活黑块，与主题页 segmented 一致） */
    '.wbs-sess-seg{display:flex;flex:1;min-width:0;background:var(--wb-bg-tertiary,#f0f0f0);border-radius:10px;padding:3px;gap:3px}',
    '.wbs-sess-seg-btn{flex:1;padding:6px 4px;border:none;border-radius:8px;background:transparent;color:var(--wb-icon-secondary,#666);font-size:12px;font-weight:600;cursor:pointer;transition:all .15s;font-family:inherit;white-space:nowrap}',
    '.wbs-sess-seg-btn:hover{color:var(--wb-color-text-primary,#1f1f1f)}',
    '.wbs-sess-seg-btn.active{background:var(--wb-button-primary-bg,#1f1f1f);color:var(--wb-button-primary-fg,#fff);box-shadow:0 1px 4px rgba(0,0,0,.2)}',
    '.wbs-sess-toolbar{display:flex;align-items:center;gap:6px;margin-bottom:8px}',
    '.wbs-sess-refresh{display:flex;align-items:center;justify-content:center;flex-shrink:0;padding:7px;border:1px solid var(--wb-border-default,#e5e5e5);border-radius:9px;background:var(--wb-bg-popover,#fff);color:var(--wb-icon-secondary,#555);font-size:12px;cursor:pointer;line-height:1;transition:all .15s}',
    '.wbs-sess-refresh:hover{background:var(--wb-bg-hover,#f5f5f5);color:var(--wb-color-text-primary,#1f1f1f)}',
    '.wbs-sess-bbtn{display:inline-flex;align-items:center;justify-content:center;gap:4px;padding:7px 12px;border:1px solid var(--wb-border-default,#e5e5e5);border-radius:9px;background:var(--wb-bg-popover,#fff);color:var(--wb-icon-secondary,#555);font-size:12px;cursor:pointer;line-height:1;transition:all .15s}',
    '.wbs-sess-bbtn:hover{background:var(--wb-bg-hover,#f5f5f5);color:var(--wb-color-text-primary,#1f1f1f)}',
    '.wbs-sess-bbtn.active{background:#fff;color:#1f1f1f;border-color:#fff}',
    '.wbs-sess-batchbar{display:flex;align-items:center;gap:6px;margin-bottom:8px;flex-wrap:wrap;padding:7px 8px;border:1px solid var(--wb-border-default,#e5e5e5);border-radius:10px;background:color-mix(in srgb,var(--wb-bg-secondary,#fff) 15%,transparent)}',
    '.wbs-sess-done{margin-left:auto;color:#fff;background:#141416;border-color:#141416}',
    '.wbs-sess-done:hover{background:#2a2a2e;color:#fff}',
    /* 删除按钮：图标按钮，尺寸与兄弟一致；点击后变警告色（armed） */
    '.wbs-sess-delbtn{padding:7px;color:var(--wb-icon-secondary,#555)}',
    '.wbs-sess-delbtn:hover{color:#ff6b6b;border-color:color-mix(in srgb,#ff6b6b 45%,transparent);background:color-mix(in srgb,#ff6b6b 8%,transparent)}',
    '.wbs-sess-delbtn.armed{color:#fff;background:#ff6b6b;border-color:#ff6b6b}',
    '.wbs-sess-count{display:flex;align-items:center;gap:5px;margin-left:auto;min-width:0}',
    '.wbs-sess-summary-tag{display:inline-flex;align-items:center;min-height:22px;padding:0 8px;border:1px solid var(--wb-border-default,#e5e5e5);border-radius:999px;background:color-mix(in srgb,var(--wb-bg-tertiary,#f0f0f0) 70%,transparent);color:var(--wb-icon-secondary,#666);font-size:11px;white-space:nowrap}',
    '.wbs-sess-summary-auto{border-color:color-mix(in srgb,var(--wb-button-primary-bg,#1f1f1f) 24%,var(--wb-border-default,#e5e5e5));color:var(--wb-button-primary-bg,#1f1f1f);background:color-mix(in srgb,var(--wb-button-primary-bg,#1f1f1f) 8%,transparent)}',
    '.wbs-sess-summary-selected{font-size:11px;color:var(--wb-icon-tertiary,#999);white-space:nowrap}',
    '.wbs-model-card{display:flex;flex:1;flex-direction:column;min-height:0;padding:10px 12px 12px}',
    '.wbs-model-tabs{display:flex;gap:4px;padding:3px;margin-bottom:10px;border-radius:10px;background:var(--wb-bg-tertiary,#f0f0f0)}',
    '.wbs-model-tab{display:flex;align-items:center;justify-content:center;gap:7px;flex:1;min-width:0;padding:9px 8px;border:0;border-radius:8px;background:transparent;color:var(--wb-icon-secondary,#666);font-size:14px;font-weight:650;line-height:1;font-family:inherit;cursor:pointer;transition:background .15s,color .15s}',
    '.wbs-model-tab:hover{color:var(--wb-color-text-primary,#1f1f1f)}',
    '.wbs-model-tab.active{background:var(--wb-button-primary-bg,#1f1f1f);color:var(--wb-button-primary-fg,#fff);box-shadow:0 1px 4px rgba(0,0,0,.16)}',
    '.wbs-model-tab-count{font-size:12px;opacity:.72;font-variant-numeric:tabular-nums}',
    '.wbs-model-toolbar{display:flex;align-items:center;gap:6px;min-height:28px;margin-bottom:7px}',
    '.wbs-model-toolbar-spacer{flex:1}',
    '.wbs-model-imports{display:flex;align-items:center;gap:5px;flex-wrap:wrap}',
    '.wbs-model-import:disabled{opacity:.5;cursor:not-allowed}',
    '.wbs-model-count{font-size:13px;color:var(--wb-icon-tertiary,#888)}',
    '.wbs-model-batchbar{display:flex;align-items:center;gap:6px;margin-bottom:7px;padding:6px 8px;border:1px solid var(--wb-border-default,#e5e5e5);border-radius:9px;background:color-mix(in srgb,var(--wb-bg-secondary,#fff) 18%,transparent)}',
    '.wbs-model-batch-count{font-size:11px;color:var(--wb-icon-tertiary,#999)}',
    '.wbs-model-batch-action{margin-left:auto}',
    '.wbs-model-batchbar .wbs-sess-done{margin-left:0}',
    '.wbs-model-batch-action:disabled{opacity:.45;cursor:not-allowed}',
    '.wbs-model-list{display:flex;flex:1;min-height:0;flex-direction:column;gap:6px;max-height:none;overflow-y:auto;scrollbar-width:thin;scrollbar-color:transparent transparent}',
    '.wbs-model-list:hover{scrollbar-color:rgba(128,128,128,.45) transparent}',
    '.wbs-model-list::-webkit-scrollbar{width:6px}',
    '.wbs-model-list::-webkit-scrollbar-thumb{background:transparent;border-radius:3px}',
    '.wbs-model-list:hover::-webkit-scrollbar-thumb{background:rgba(128,128,128,.45)}',
    '.wbs-model-row{display:flex;align-items:flex-start;box-sizing:border-box;width:100%;gap:10px;padding:10px 8px;border:0;border-radius:10px;background:transparent;transition:background .15s}',
    '.wbs-model-row:hover{background:var(--wb-bg-hover,#f5f5f5)}',
    '.wbs-model-main{min-width:0;flex:1}',
    // 第一行：自定义名（左）+ 操作按钮组（右，占流固定；hover/focus cell 时由透明变不透明）
    '.wbs-model-title-row{display:flex;align-items:center;gap:9px;min-width:0;margin-bottom:6px}',
    '.wbs-model-name{min-width:0;flex:0 1 auto;font-size:14px;font-weight:650;color:var(--wb-color-text-primary,#1f1f1f);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.wbs-model-details{display:flex;flex-direction:column;gap:4px;min-width:0}',
    // 第二行：vendor 标签 + 模型 id 标签
    '.wbs-model-tag-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-width:0;margin-bottom:6px}',
    '.wbs-model-tag{display:inline-flex;align-items:center;max-width:100%;padding:2px 8px;border:1px solid color-mix(in srgb,var(--wb-border-default,#e5e5e5) 85%,transparent);border-radius:999px;background:var(--wb-bg-tertiary,#f0f0f0);color:var(--wb-icon-secondary,#555);font-size:11px;font-weight:500;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.wbs-model-tag-id{color:var(--wb-icon-secondary,#666);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
    '.wbs-model-field{display:grid;grid-template-columns:52px minmax(0,1fr);align-items:center;gap:6px;min-width:0;font-size:12px;line-height:1.35}',
    '.wbs-model-field span{min-width:0;color:var(--wb-icon-tertiary,#999);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
    '.wbs-model-field strong{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--wb-icon-secondary,#666);font-weight:500;text-align:left}',
    // url 与 apiKey：完整展示，允许换行，不做省略截断（批量/悬浮切换不影响宽度与行高）
    '.wbs-model-field strong.wbs-model-url,.wbs-model-field strong.wbs-model-key{white-space:normal;overflow-wrap:anywhere;word-break:break-all}',
    '.wbs-model-key{letter-spacing:.2px}',
    // 按钮组占流于标题行右侧，位置恒定；仅 hover/focus cell 时透明度 0→1
    '.wbs-model-actions{display:flex;align-items:center;gap:4px;flex:0 0 auto;margin-left:auto;opacity:0;transition:opacity .15s}',
    '.wbs-model-row:hover .wbs-model-actions,.wbs-model-row:focus-within .wbs-model-actions{opacity:1}',
    '.wbs-model-action{display:inline-flex;align-items:center;justify-content:center;gap:4px;flex:0 0 auto;min-height:28px;padding:6px 10px;border:1px solid var(--wb-border-default,#e5e5e5);border-radius:8px;background:var(--wb-bg-popover,#fff);color:var(--wb-icon-secondary,#555);font-size:11px;font-weight:600;line-height:1;font-family:inherit;cursor:pointer;transition:background .15s,color .15s,border-color .15s}',
    '.wbs-model-action:hover{background:var(--wb-button-primary-bg,#1f1f1f);border-color:var(--wb-button-primary-bg,#1f1f1f);color:var(--wb-button-primary-fg,#fff)}',
    '.wbs-model-icon-action{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:1px solid transparent;border-radius:7px;background:var(--wb-bg-hover,#f7f8fa);color:var(--wb-icon-secondary,#555);cursor:pointer;transition:background .15s,color .15s,border-color .15s}',
    '.wbs-model-icon-action:hover{background:color-mix(in srgb,var(--wb-button-primary-bg,#1f1f1f) 12%,transparent);border-color:transparent;color:var(--wb-color-text-primary,#1f1f1f)}',
    '.wbs-model-icon-action:disabled{opacity:.45;cursor:wait}',
    '.wbs-model-danger-action{background:var(--wb-bg-hover,#f7f8fa);color:var(--wb-icon-secondary,#555)}',
    '.wbs-model-danger-action:hover{background:#ffecec;color:#f53f3f;border-color:transparent}',
    '.wbs-model-enable{color:var(--wb-color-text-primary,#1f1f1f);background:var(--wb-bg-tertiary,#f0f0f0)}',
    '.wbs-model-enable:hover{background:var(--wb-button-primary-bg,#1f1f1f);border-color:var(--wb-button-primary-bg,#1f1f1f);color:var(--wb-button-primary-fg,#fff)}',
    '.wbs-model-enable-icon{display:inline-flex;align-items:center}',
    '.wbs-model-group{display:flex;flex-direction:column;gap:3px}',
    // 备选模型组与组之间：浅色细分隔线（仅出现在组间，首个组无）
    '.wbs-model-group + .wbs-model-group{border-top:1px solid color-mix(in srgb,var(--wb-border-default,#e5e5e5) 55%,transparent);padding-top:9px}',
    '.wbs-model-group-head{display:flex;align-items:center;gap:7px;padding:5px 4px 4px}',
    '.wbs-model-group-title{display:inline-flex;align-items:center;max-width:calc(100% - 30px);padding:3px 9px;border-radius:999px;background:var(--wb-bg-tertiary,#f0f0f0);color:var(--wb-icon-secondary,#555);font-size:12px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.wbs-model-group-count{margin-left:auto;flex:0 0 auto;padding:2px 7px;border-radius:999px;background:var(--wb-bg-tertiary,#f0f0f0);color:var(--wb-icon-tertiary,#999);font-size:11px}',
    '.wbs-model-check{margin:0;accent-color:var(--wb-button-primary-bg,#1f1f1f);flex:0 0 auto}',
    // 小贴士：tips 通知条样式（圆角浅底 + 灯泡图标 + 标题）
    '.wbs-model-tip{display:flex;align-items:center;gap:8px;margin:0 0 8px;padding:7px 11px;border:1px solid color-mix(in srgb,var(--wb-border-default,#e5e5e5) 82%,transparent);border-radius:10px;background:var(--wb-bg-tertiary,#f0f0f0);color:var(--wb-icon-tertiary,#777);font-size:11px;line-height:1.5;box-shadow:0 1px 3px rgba(0,0,0,.05)}',
    '.wbs-model-tip-ico{display:inline-flex;align-items:center;flex:0 0 auto;color:var(--wb-icon-secondary,#555)}',
    '.wbs-model-tip strong{flex:0 0 auto;color:var(--wb-color-text-secondary,#555);font-weight:650}',
    '.wbs-model-tip span{min-width:0}',
    '.wbs-model-edit-modal{width:min(390px,calc(100vw - 36px))}',
    '.wbs-model-edit-form{display:flex;flex-direction:column;gap:11px;margin-bottom:20px}',
    '.wbs-model-edit-field{display:flex;flex-direction:column;gap:5px;font-size:11px;color:var(--wb-icon-secondary,#666)}',
    '.wbs-model-edit-field input{box-sizing:border-box;width:100%;min-height:32px;padding:6px 9px;border:1px solid var(--wb-border-default,#e5e5e5);border-radius:8px;background:var(--wb-bg-secondary,#fff);color:var(--wb-color-text-primary,#1f1f1f);font:inherit;outline:none}',
    '.wbs-model-edit-field input:focus{border-color:var(--wb-button-primary-bg,#1f1f1f);box-shadow:0 0 0 2px color-mix(in srgb,var(--wb-button-primary-bg,#1f1f1f) 16%,transparent)}',
    '.wbs-secret-wrap,.wbs-model-secret-wrap{position:relative;display:block}',
    '.wbs-model-secret-wrap input{padding-right:34px}',
    '.wbs-model-eye{position:absolute;right:4px;top:3px;width:27px;height:27px;display:flex;align-items:center;justify-content:center;border:0;border-radius:6px;background:transparent;color:var(--wb-icon-tertiary,#888);cursor:pointer}',
    '.wbs-model-eye:hover{background:var(--wb-bg-hover,#f5f5f5);color:var(--wb-color-text-primary,#1f1f1f)}',
    '.wbs-model-edit-field small{font-size:10px;color:var(--wb-icon-tertiary,#999)}',
    '.wbs-sess-list{max-height:320px;overflow-y:auto;display:flex;flex-direction:column;gap:6px;margin-bottom:8px;scrollbar-width:thin;scrollbar-color:transparent transparent}',
    '.wbs-sess-list:hover{scrollbar-color:rgba(128,128,128,.45) transparent}',
    '.wbs-sess-list::-webkit-scrollbar{width:6px}',
    '.wbs-sess-list::-webkit-scrollbar-thumb{background:transparent;border-radius:3px}',
    '.wbs-sess-list:hover::-webkit-scrollbar-thumb{background:rgba(128,128,128,.45)}',
    '.wbs-sess-list::-webkit-scrollbar-thumb:hover{background:rgba(128,128,128,.7)}',
    '.wbs-sess-group{border:1px solid var(--wb-border-default,#e5e5e5);border-radius:10px;padding:6px 8px;background:color-mix(in srgb,var(--wb-bg-secondary,#fff) 20%,transparent)}',
    '.wbs-sess-group-head{display:flex;align-items:center;gap:6px;padding:2px 2px 6px;border-bottom:1px dashed var(--wb-border-subtle,#eee);margin-bottom:4px}',
    '.wbs-sess-group-head input{accent-color:#fff;flex-shrink:0}',
    '.wbs-sess-group-name{font-size:12px;font-weight:700;color:var(--wb-color-text-primary,#1f1f1f);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}',
    '.wbs-sess-group-type{flex-shrink:0;font-size:10px;font-weight:600;color:var(--wb-icon-secondary,#666);background:var(--wb-bg-tertiary,#f0f0f0);border-radius:5px;padding:2px 6px;margin-right:6px;letter-spacing:.5px}',
    '.wbs-sess-group-count{font-size:10px;color:var(--wb-icon-tertiary,#999);background:var(--wb-bg-tertiary,#f0f0f0);border-radius:9px;padding:1px 7px}',
    '.wbs-sess-more{width:100%;padding:5px 8px;margin-top:4px;border:1px dashed var(--wb-border-default,#e5e5e5);border-radius:8px;background:transparent;color:var(--wb-icon-secondary,#555);font-size:11px;cursor:pointer;transition:all .15s;line-height:1}',
    '.wbs-sess-more:hover{border-color:var(--wb-border-strong,#bbb);color:var(--wb-color-text-primary,#1f1f1f)}',
    '.wbs-sess-row{display:flex;align-items:flex-start;gap:8px;padding:6px 8px;border:1px solid transparent;border-radius:8px;cursor:pointer;transition:background .15s}',
    '.wbs-sess-row:hover{background:var(--wb-bg-hover,#f5f5f5)}',
    '.wbs-sess-tasks .wbs-sess-row{cursor:default}',
    '.wbs-sess-row:has(input:checked){border-color:#fff;background:color-mix(in srgb,#fff 10%,transparent)}',
    '.wbs-sess-row input{margin:2px 0 0;accent-color:#fff;flex-shrink:0}',
    '.wbs-sess-main{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}',
    '.wbs-sess-title{font-size:12px;font-weight:600;color:var(--wb-color-text-primary,#1f1f1f);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.wbs-sess-meta{font-size:11px;color:var(--wb-icon-tertiary,#999)}',
    '.wbs-sess-auto{display:inline-flex;align-items:center;justify-content:flex-end;gap:6px;flex:0 0 auto;min-width:76px;height:26px;margin-top:-2px;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--wb-icon-tertiary,#999);cursor:pointer;padding:0 3px 0 5px;transition:background .15s,color .15s,opacity .15s;font:inherit}',
    '.wbs-sess-auto:hover{background:var(--wb-bg-hover,#f5f5f5);color:var(--wb-color-text-primary,#1f1f1f)}',
    '.wbs-sess-auto.active{color:var(--wb-button-primary-bg,#1f1f1f)}',
    '.wbs-sess-auto.inherited{color:var(--wb-button-primary-bg,#1f1f1f);opacity:.62;cursor:default}',
    '.wbs-sess-auto:disabled{cursor:default}',
    '.wbs-sess-auto-label{font-size:11px;line-height:1;white-space:nowrap}',
    '.wbs-sess-auto-switch{position:relative;display:inline-flex;align-items:center;width:24px;height:14px;flex:0 0 24px;border-radius:999px;background:var(--wb-bg-tertiary,#dedede);transition:background .15s}',
    '.wbs-sess-auto-switch span{width:10px;height:10px;margin-left:2px;border-radius:50%;background:var(--wb-bg-popover,#fff);box-shadow:0 1px 2px rgba(0,0,0,.18);transition:transform .15s}',
    '.wbs-sess-auto-switch.on{background:var(--wb-button-primary-bg,#1f1f1f)}',
    '.wbs-sess-auto-switch.on span{transform:translateX(10px);background:var(--wb-button-primary-fg,#fff)}',
    '.wbs-sess-actions{display:flex;gap:8px;justify-content:flex-end;padding-top:2px}',
    '.wbs-sess-del{flex-shrink:0;padding:7px 12px;border:1px solid #ff6b6b;border-radius:9px;background:color-mix(in srgb,#ff6b6b 10%,transparent);color:#ff6b6b;font-size:12px;cursor:pointer;line-height:1;transition:all .15s}',
    '.wbs-sess-del:hover{background:#ff6b6b;color:#fff}',
    '.wbs-modal-mask{position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center}',
    /* 免打扰确认弹窗：挂载在面板容器内，仅覆盖面板区域（弹窗居中于面板，不盖住 WorkBuddy 窗口） */
    '.wbs-modal-mask.wbs-modal-mask-panel{position:absolute;inset:0;z-index:2147483645;border-radius:18px}',
    '.wbs-modal{width:300px;max-width:88vw;background:var(--wb-bg-popover,#fff);border-radius:14px;padding:16px;box-shadow:0 10px 40px rgba(0,0,0,.25);color:var(--wb-color-text-primary,#1f1f1f)}',
    /* 弹窗文字主题适配：body 继承 .wbs-root 硬编码深色字，暗色下必须显式覆盖为浅色 */
    'html.cb-dark .wbs-modal,html.cb-dark .wbs-modal-title,html.cb-dark .wbs-modal-body,html[data-theme="dark"] .wbs-modal,html[data-theme="dark"] .wbs-modal-title,html[data-theme="dark"] .wbs-modal-body{color:#e6e6e9}',
    'html.cb-dark .wbs-modal-btn,html[data-theme="dark"] .wbs-modal-btn{color:#d5d5d9;border-color:rgba(232,232,234,0.16);background:rgba(255,255,255,0.05)}',
    'html.cb-dark .wbs-modal-btn:hover,html[data-theme="dark"] .wbs-modal-btn:hover{background:rgba(255,255,255,0.12)}',
    /* 高危红色确认按钮在暗色下保持红色风格（略提亮更醒目） */
    'html.cb-dark .wbs-modal-btn.wbs-modal-danger,html[data-theme="dark"] .wbs-modal-btn.wbs-modal-danger{color:#fff;background:#e03d3d;border-color:#e03d3d}',
    'html.cb-dark .wbs-modal-btn.wbs-modal-danger:hover,html[data-theme="dark"] .wbs-modal-btn.wbs-modal-danger:hover{background:#f04a4a}',
    'html.cb-dark .wbs-modal-mask,html[data-theme="dark"] .wbs-modal-mask{background:rgba(0,0,0,.55)}',
    '.wbs-modal-title{font-size:13px;font-weight:700;color:var(--wb-color-text-primary,#1f1f1f);margin-bottom:10px}',
    '.wbs-modal-body{display:flex;flex-direction:column;gap:6px;max-height:280px;overflow-y:auto;margin-bottom:12px}',
    '.wbs-modal-action{display:block;width:100%;text-align:left;padding:8px 10px;border:1px solid var(--wb-border-default,#e5e5e5);border-radius:9px;background:var(--wb-bg-popover,#fff);color:var(--wb-color-text-primary,#1f1f1f);font-size:12px;cursor:pointer;line-height:1;transition:all .15s}',
    '.wbs-modal-action:hover{border-color:var(--wb-border-strong,#bbb);background:var(--wb-bg-hover,#f5f5f5)}',
    '.wbs-modal-action.danger{color:#ff6b6b;border-color:color-mix(in srgb,#ff6b6b 40%,transparent)}',
    '.wbs-modal-action.danger:hover{background:#ff6b6b;color:#fff}',
    '.wbs-modal-action:disabled{opacity:.4;cursor:not-allowed}',
    '.wbs-modal-row{display:flex;align-items:flex-start;gap:8px;padding:6px 4px;cursor:pointer}',
    '.wbs-modal-row input{margin:2px 0 0;accent-color:#fff;flex-shrink:0}',
    '.wbs-modal-main{display:flex;flex-direction:column;gap:1px;font-size:12px;color:var(--wb-color-text-primary,#1f1f1f)}',
    '.wbs-modal-sub{font-size:11px;color:var(--wb-icon-tertiary,#999)}',
    '.wbs-modal-warn{font-size:12px;color:#ff6b6b;line-height:1.6}',
    '.wbs-modal-actions{display:flex;gap:8px;justify-content:flex-end}',
    /* 会话弹窗按钮：取消=次级白底、确定=深色主按钮（与面板主按钮风格一致） */
    '.wbs-modal-btn{padding:7px 12px;border:1px solid var(--wb-border-default,#e5e5e5);border-radius:9px;background:var(--wb-bg-popover,#fff);color:var(--wb-icon-secondary,#555);font-size:12px;cursor:pointer;line-height:1;transition:all .15s;font-family:inherit}',
    '.wbs-modal-btn:hover{background:var(--wb-bg-hover,#f5f5f5);color:var(--wb-color-text-primary,#1f1f1f);border-color:var(--wb-border-strong,#bbb)}',
    '.wbs-modal-btn.wbs-modal-ok{color:#fff;background:#141416;border-color:#141416}',
    '.wbs-modal-btn.wbs-modal-ok:hover{background:#2a2a2e;color:#fff}',
    /* 免打扰确认弹窗：红字确认按钮（高危操作，用红色警示） */
    '.wbs-modal-btn.wbs-modal-danger{color:#fff;background:#c62828;border-color:#c62828}',
    '.wbs-modal-btn.wbs-modal-danger:hover{background:#b71c1c}',
    '.wbs-modal-actions .wbs-theme-devtools{background:var(--wb-bg-popover,#fff)}',
    /* 电脑休眠三模式选择 */
    '.wbs-sleep-modes{display:flex;flex-direction:column;gap:6px;margin-bottom:8px}',
    '.wbs-sleep-mode{display:flex;align-items:center;gap:8px;padding:7px 10px;border:1px solid var(--wb-border-default,#e5e5e5);border-radius:10px;cursor:pointer;background:color-mix(in srgb,var(--wb-bg-secondary,#fff) 30%,transparent);transition:all .15s}',
    '.wbs-sleep-mode:hover{border-color:var(--wb-border-strong,#bbb)}',
    '.wbs-sleep-mode:has(input:checked){border-color:var(--wb-button-primary-bg,#1f1f1f);background:color-mix(in srgb,var(--wb-button-primary-bg,#1f1f1f) 8%,transparent)}',
    '.wbs-sleep-mode input{accent-color:var(--wb-button-primary-bg,#1f1f1f);margin:0;flex-shrink:0}',
    '.wbs-sleep-mode-name{font-size:12px;font-weight:600;color:var(--wb-color-text-primary,#1f1f1f);white-space:nowrap}',
    '.wbs-sleep-mode-hint{font-size:11px;color:var(--wb-icon-tertiary,#999);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    /* 关于页：项目信息卡（名字/标语/原理徽章/介绍 + 支持项目入口 + 版本） */
    '.wbs-about-hero{display:flex;flex-direction:column;align-items:center;gap:8px;padding:20px 16px 16px}',
    '.wbs-about-name{font-size:18px;font-weight:700;letter-spacing:.3px;color:var(--wb-color-text-primary,#1f1f1f)}',
    '.wbs-about-tag{font-size:12.5px;color:var(--wb-icon-tertiary,#888);text-align:center;line-height:1.5}',
    '.wbs-about-badge{font-size:11px;font-weight:600;color:var(--wb-button-primary-bg,#1f1f1f);background:rgba(0,0,0,.05);border:1px solid rgba(0,0,0,.08);padding:3px 10px;border-radius:999px;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}',
    '.wbs-about-desc{font-size:11.5px;line-height:1.6;color:var(--wb-icon-tertiary,#777);text-align:center;padding:2px 6px 0}',
    '.wbs-about-desc b{color:var(--wb-color-text-primary,#1f1f1f);font-weight:600}',
    '.wbs-about-support{display:flex;align-items:center;justify-content:center;gap:9px;width:100%;max-width:360px;box-sizing:border-box;margin-top:3px;padding:9px 10px;border-top:1px solid var(--wb-border-default,rgba(0,0,0,.08));border-bottom:1px solid var(--wb-border-default,rgba(0,0,0,.08))}',
    '.wbs-about-support-text{min-width:0;flex:1 1 auto;font-size:11.5px;line-height:1.55;color:var(--wb-icon-tertiary,#777);text-align:left}',
    '.wbs-about-foot{display:flex;align-items:center;justify-content:center;gap:10px;margin-top:10px}',
    '.wbs-about-ver{font-family:ui-monospace,SF Mono,Menlo,monospace;font-size:11px;font-weight:500;color:var(--wb-icon-tertiary,#999);letter-spacing:.3px}',
    '.wbs-about-feedback{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:600;color:var(--wb-button-primary-bg,#1f1f1f);background:rgba(0,0,0,.05);padding:5px 12px;border-radius:999px;text-decoration:none;transition:background .15s}',
    '.wbs-about-feedback:hover{background:rgba(0,0,0,.1)}',
    '.wbs-about-ghbtn{width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.06);color:var(--wb-color-text-primary,#1f1f1f);text-decoration:none;transition:background .15s,transform .15s;flex:0 0 32px}',
    '.wbs-about-ghbtn:hover{background:rgba(0,0,0,.1);transform:translateY(-1px)}',
    /* 自动更新：tab 红点 + 更新卡片 */
    '.wbs-tab{position:relative}',
    '.wbs-tab-dot::after{content:"";position:absolute;top:6px;right:9px;width:7px;height:7px;border-radius:50%;background:#e24b4a;box-shadow:0 0 0 2px var(--wb-bg-primary,#fff)}',
    '.wbs-about-update{border:1px solid rgba(226,75,74,.35);background:rgba(226,75,74,.06);padding:12px 14px;margin-bottom:10px}',
    '.wbs-update-head{display:flex;align-items:center;gap:8px;margin-bottom:6px}',
    '.wbs-update-dot{width:8px;height:8px;border-radius:50%;background:#e24b4a;flex-shrink:0}',
    '.wbs-update-title{font-size:13px;font-weight:600;color:var(--wb-color-text-primary,#1f1f1f)}',
    '.wbs-update-notes{font-size:11.5px;line-height:1.6;color:var(--wb-icon-tertiary,#777);white-space:pre-wrap;overflow:visible;overflow-wrap:anywhere;margin-bottom:10px}',
    '.wbs-update-actions{display:flex;align-items:center;gap:10px;min-width:0}',
    '.wbs-update-btn{font-size:12px;font-weight:600;color:var(--wb-button-primary-fg,#fff);background:var(--wb-button-primary-bg,#1f1f1f);border:none;padding:6px 10px;border-radius:8px;cursor:pointer;transition:opacity .15s;flex:0 0 112px;min-width:112px;box-sizing:border-box;white-space:nowrap}',
    '.wbs-update-btn:hover{opacity:.85}',
    '.wbs-update-btn:disabled{opacity:.5;cursor:default}',
    '.wbs-update-progress{display:block;box-sizing:border-box;margin-top:8px;max-height:126px;overflow-y:auto;padding:7px 8px;border:1px solid rgba(226,75,74,.2);border-radius:8px;background:rgba(226,75,74,.045);font-size:10.5px;color:var(--wb-icon-tertiary,#888);line-height:1.5;overflow-wrap:anywhere;scrollbar-width:thin}',
    '.wbs-update-log-line{white-space:normal;word-break:break-word;padding:1px 0}',
    /* 官方壁纸网格 */
    '.wbs-wallpapers{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}',
    '.wbs-wp{border-radius:10px;overflow:hidden;cursor:pointer;border:2px solid transparent;transition:all .15s;position:relative}',
    '.wbs-wp:hover{transform:translateY(-2px);border-color:var(--wb-border-hover,#bbb)}',
    '.wbs-wp.active{border-color:var(--wb-button-primary-bg,#1f1f1f)}',
    '.wbs-wp-thumb{aspect-ratio:3/2;background:var(--wb-bg-tertiary,#f0f0f0)}',
    '.wbs-wp-thumb img{width:100%;height:100%;object-fit:cover;display:block}',
    '.wbs-wp-badge{position:absolute;top:4px;right:4px;min-width:18px;height:18px;padding:0 4px;border-radius:9px;background:rgba(0,0,0,.55);color:#fff;font-size:10px;font-weight:700;line-height:18px;text-align:center;backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px)}',
    '.wbs-wp.active .wbs-wp-badge{background:#fff;color:#0a0a0a}',
    '.wbs-wp-loading{padding:20px 0;text-align:center;color:var(--wb-icon-tertiary,#999);font-size:12px;grid-column:1/-1}',
    '.wbs-wp.busy{opacity:.6;pointer-events:none}',
    /* 主题切换 segmented（默认主题 / WorkDaddy 主题）：样式与下方壁纸来源切换按钮统一 */
    '.wbs-theme-seg{display:flex;background:var(--wb-bg-tertiary,#f0f0f0);border-radius:10px;padding:3px;gap:3px;margin-bottom:8px}',
    '.wbs-theme-opt{flex:1;padding:6px 4px;border:none;border-radius:8px;background:transparent;color:var(--wb-icon-secondary,#666);font-size:12px;font-weight:600;cursor:pointer;transition:all .15s;font-family:inherit;white-space:nowrap}',
    '.wbs-theme-opt:hover{color:var(--wb-color-text-primary,#1f1f1f)}',
    '.wbs-theme-opt.active{background:var(--wb-button-primary-bg,#1f1f1f);color:var(--wb-button-primary-fg,#fff);box-shadow:0 1px 4px rgba(0,0,0,.2)}',
    /* 背景图来源切换（WorkDaddy 壁纸 / 自定义背景图） */
    '.wbs-bg-source{display:flex;background:var(--wb-bg-tertiary,#f0f0f0);border-radius:10px;padding:3px;gap:3px;margin-bottom:8px}',
    '.wbs-bg-src{flex:1;padding:6px 4px;border:none;border-radius:8px;background:transparent;color:var(--wb-icon-secondary,#666);font-size:12px;font-weight:600;cursor:pointer;transition:all .15s;font-family:inherit;white-space:nowrap}',
    '.wbs-bg-src:hover{color:var(--wb-color-text-primary,#1f1f1f)}',
    '.wbs-bg-src.active{background:var(--wb-button-primary-bg,#1f1f1f);color:var(--wb-button-primary-fg,#fff);box-shadow:0 1px 4px rgba(0,0,0,.2)}',
    '.wbs-bg-panel{margin-bottom:10px}',
    '.wbs-bg-upload{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:22px 12px;border:1.5px dashed var(--wb-border-strong,#ccc);border-radius:12px;color:var(--wb-icon-secondary,#666);font-size:13px;font-weight:600;cursor:pointer;transition:all .15s;text-align:center;background:color-mix(in srgb,var(--wb-bg-tertiary,#f0f0f0) 40%,transparent)}',
    '.wbs-bg-upload:hover,.wbs-bg-upload.drag{border-color:var(--wb-accent-blue,#4f86ff);color:var(--wb-color-text-primary,#1f1f1f);background:color-mix(in srgb,var(--wb-accent-blue,#4f86ff) 8%,transparent)}',
    '.wbs-bg-upload-ico{width:30px;height:30px;border-radius:50%;background:var(--wb-bg-hover,#e8e9eb);display:flex;align-items:center;justify-content:center;font-size:18px;line-height:1;font-weight:400}',
    '.wbs-bg-upload-hint{font-size:11px;color:var(--wb-icon-tertiary,#999);font-weight:400}',
    '.wbs-bg-preview{display:none;width:100%;max-height:140px;object-fit:cover;border-radius:10px;margin-top:8px;border:1px solid var(--wb-border-subtle,#eee)}',
    '.wbs-avatar-preview{width:32px;height:32px;border-radius:50%;object-fit:cover;border:1px solid var(--wb-border-subtle,#eee);display:none;flex-shrink:0;background:var(--wb-bg-tertiary,#f0f0f0);cursor:pointer;transition:transform .15s}',
    '.wbs-avatar-preview:hover{transform:scale(1.08)}',
    /* 背景蒙版滑块（黑色半透明遮罩，0~100%） */
    '.wbs-mask-row{display:flex;align-items:center;gap:8px;margin-top:8px}',
    '.wbs-mask-row input[type=range]{flex:1;min-width:0;accent-color:#f2f2f4;height:4px;cursor:pointer}',
    '.wbs-mask-val{font-size:11px;color:var(--wb-icon-tertiary,#888);flex-shrink:0;min-width:28px;text-align:right;font-variant-numeric:tabular-nums}',
    /* 头像/增强行 */
    '.wbs-avatar-row{display:flex;align-items:center;gap:8px;margin-bottom:10px}',
    '.wbs-tab svg{flex-shrink:0}',
    '.wbs-enh-row{display:flex;gap:8px;margin-bottom:8px}',
    '.wbs-enh-tip{font-size:11px;color:var(--wb-icon-tertiary,#999);line-height:1.5;padding:4px 2px 0}',
    /* 账号列表容器 + 退出按钮 */
    '.wbs-acct-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px 9px;border-bottom:1px solid var(--wb-border-subtle,#f0f0f0);background:color-mix(in srgb,var(--wb-bg-secondary,#fff) 25%,transparent);flex-shrink:0}',
    '.wbs-acct-summary{display:flex;align-items:center;gap:12px;min-width:0}',
    '.wbs-acct-stat{display:flex;align-items:center;gap:5px;white-space:nowrap;line-height:1}',
    '.wbs-acct-stat span,.wbs-acct-stat strong{font-size:13px}',
    '.wbs-acct-stat span{color:var(--wb-icon-tertiary,#999);font-weight:500}',
    '.wbs-acct-stat strong{color:var(--wb-color-text-primary,#1f1f1f);font-weight:700;font-variant-numeric:tabular-nums}',
    '.wbs-acct-stat-divider{width:1px;height:18px;background:var(--wb-border-subtle,#e8e8e8);flex-shrink:0}',
    '.wbs-acct-actions{display:flex;align-items:center;gap:6px;flex-shrink:0}',
    '.wbs-acct-io{display:inline-flex;align-items:center;justify-content:center;gap:4px;padding:5px 8px;border:1px solid var(--wb-border-subtle,#e6e6e6);border-radius:7px;background:var(--wb-bg-tertiary,#fafafa);color:var(--wb-color-text-secondary,#555);font-size:11px;font-weight:600;cursor:pointer;transition:all .15s;font-family:inherit;min-width:0;line-height:1.2}',
    '.wbs-acct-io:hover{background:var(--wb-bg-hover,#f0f0f0);border-color:var(--wb-border-default,#d5d5d5)}',
    '.wbs-acct-io svg{flex-shrink:0}',
    '.wbs-acct-io span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.wbs-acct-list{flex:1;min-height:0;overflow-y:auto;padding-right:2px}',
    '.wbs-logout-btn{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;margin-top:10px;padding:10px 0;border:1px solid var(--wb-border-default,#e5e5e5);border-radius:12px;background:transparent;color:var(--wb-icon-secondary,#666);font-size:13px;font-weight:600;cursor:pointer;transition:all .15s;font-family:inherit;flex-shrink:0}',
    '.wbs-logout-btn:hover{background:var(--wb-bg-hover,#f5f5f5);color:var(--wb-color-text-primary,#1f1f1f);border-color:var(--wb-border-default,#d5d5d5)}',
    '.wbs-logout-btn.armed{background:#f53f3f;color:#fff;border-color:#f53f3f}',
    '.wbs-logout-btn svg{width:15px;height:15px}',
    /* 登录新账号二选一弹窗（方法一 假退出 / 方法二 无感登录） */
    /* 选择登录方式：遮罩限定在 WorkDaddy 面板内部，沿用会话弹窗的层级与按钮风格 */
    '.wbs-pane{position:relative}',
    '@keyframes wbs-modal-in{from{opacity:0}to{opacity:1}}',
    '.wbs-panel-modal-mask{position:absolute;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;padding:14px;background:transparent;pointer-events:auto;animation:wbs-modal-in .16s ease}',
    '.wbs-login-modal{width:min(360px,calc(100% - 28px));box-sizing:border-box;padding:16px;border:1px solid var(--wb-border-default,rgba(0,0,0,.12));border-radius:14px;background:var(--wb-bg-popover,#fff);box-shadow:0 10px 40px rgba(0,0,0,.25)}',
    '.wbs-login-modal-title{font-size:15px;font-weight:700;line-height:1.35;color:var(--wb-color-text-primary,#1f1f1f);margin:0 0 14px}',
    '.wbs-password-modal{width:min(360px,calc(100% - 28px));box-sizing:border-box;padding:16px;border:1px solid var(--wb-border-default,rgba(0,0,0,.12));border-radius:14px;background:var(--wb-bg-popover,#fff);box-shadow:0 10px 40px rgba(0,0,0,.25)}',
    '.wbs-password-field{display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--wb-icon-secondary,#666)}',
    '.wbs-password-field input{box-sizing:border-box;width:100%;min-height:34px;padding:7px 9px;border:1px solid var(--wb-border-default,#e5e5e5);border-radius:8px;background:var(--wb-bg-secondary,#fff);color:var(--wb-color-text-primary,#1f1f1f);font:inherit;outline:none}',
    '.wbs-password-field input:focus{border-color:var(--wb-button-primary-bg,#1f1f1f);box-shadow:0 0 0 2px color-mix(in srgb,var(--wb-button-primary-bg,#1f1f1f) 16%,transparent)}',
    '.wbs-password-hint{margin-top:7px;color:var(--wb-icon-tertiary,#999);font-size:11px;line-height:1.5}',
    /* 账号同步弹窗：灰色不透明遮罩，覆盖范围限定在 WorkDaddy 面板内（wbs-panel-modal-mask 的 absolute 定位） */
    '.wbs-sync-mask{background:#8a8a8a}',
    'html.cb-dark .wbs-sync-mask,html[data-theme="dark"] .wbs-sync-mask{background:#3f3f42}',
    '.wbs-sync-sub{margin:-8px 0 12px;font-size:11.5px;color:var(--wb-icon-secondary,#666);line-height:1.5;word-break:break-all}',
    '.wbs-sync-options{display:flex;flex-direction:column;gap:8px;margin-bottom:14px}',
    '.wbs-modal-btn:disabled{opacity:.45;cursor:not-allowed}',
    '.wbs-icon-btn.wbs-sync:hover{color:var(--wb-button-primary-bg,#1f1f1f)}',
    '.wbs-password-error{min-height:17px;margin-top:4px;color:#d14343;font-size:11px;line-height:1.5}',
    '.wbs-login-body{display:flex;flex-direction:column;gap:9px;margin-bottom:16px}',
    '.wbs-login-option{display:flex;align-items:flex-start;gap:10px;width:100%;box-sizing:border-box;padding:12px 13px;border:1px solid transparent;border-radius:11px;background:var(--wb-bg-popover,#fff);cursor:pointer;text-align:left;transition:border-color .16s,background .16s,box-shadow .16s;font-family:inherit}',
    '.wbs-login-option:hover{border-color:var(--wb-border-strong,#b9b9bd);background:var(--wb-bg-hover,#f5f5f5)}',
    '.wbs-login-option.selected{border-color:var(--wb-button-primary-bg,#1f1f1f);background:color-mix(in srgb,var(--wb-button-primary-bg,#1f1f1f) 7%,var(--wb-bg-popover,#fff));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--wb-button-primary-bg,#1f1f1f) 15%,transparent)}',
    '.wbs-login-option.disabled{opacity:.5;cursor:not-allowed}',
    '.wbs-login-option.disabled:hover{border-color:transparent;background:var(--wb-bg-popover,#fff)}',
    '.wbs-login-option input{width:16px;height:16px;flex:0 0 16px;margin:2px 0 0;accent-color:var(--wb-button-primary-bg,#1f1f1f);cursor:pointer}',
    '.wbs-login-option-copy{display:flex;flex:1;min-width:0;flex-direction:column;gap:4px}',
    '.wbs-login-option-title{font-size:13px;font-weight:700;color:var(--wb-color-text-primary,#1f1f1f);line-height:1.4}',
    '.wbs-login-option-desc{font-size:11.5px;color:var(--wb-icon-secondary,#666);line-height:1.55;font-weight:400}',
    '.wbs-login-status{font-size:12px;color:var(--wb-icon-secondary,#666);line-height:1.7;word-break:break-all;padding:2px 0 10px}',
    '.wbs-login-link{color:var(--wb-accent-blue,#4f86ff);text-decoration:none;font-weight:600}',
    '.wbs-login-link:hover{text-decoration:underline}',
    '.wbs-empty{text-align:center;color:var(--wb-icon-tertiary,#999);padding:28px 10px;font-size:12px}',
    /* body 高度：无底部功能区后最大化 */
    '.wbs-body{max-height:calc(min(78vh,660px) - 118px)}',
  ].join('');
  (document.head || document.documentElement).appendChild(css);
  start();

  window.__wbsWidget = {
    init: start,
    refresh: function () { if (state._refresh) state._refresh(); },
    destroy: destroyWidget,
  };
})();
}
