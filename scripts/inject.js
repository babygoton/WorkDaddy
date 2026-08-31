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

// Auto-Continue must not treat a renderer/provider-lost marker as proof of failure.
// WorkBuddy's normal assistant action row is positive completion evidence; only an
// explicit error or visibly truncated reply should cause an automatic follow-up.
function classifyAutoContinueReply(snapshot) {
  var s = snapshot || {};
  if (!s.observed || s.busy || s.manualStop) {
    return { trigger: false, reason: s.manualStop ? 'manual-stop' : 'not-idle' };
  }
  if (s.error || s.networkFailure) {
    return { trigger: true, reason: s.networkFailure ? 'network-failure' : 'error-ui' };
  }
  if (s.completionMarker || s.hasCompletionActions) {
    return { trigger: false, reason: s.completionMarker ? 'completion-marker' : 'completion-actions' };
  }
  if (s.looksTruncated) return { trigger: true, reason: 'truncated-reply' };
  return { trigger: false, reason: 'no-incomplete-evidence' };
}

// WorkBuddy 新版 ConversationController 把会话运行态与消息时间线放在 store 中。
// 这里保持为纯函数：终局 complete/terminal 等价于旧 DOM 的助手操作区；
// 空闲后仍未 complete 的助手消息才是结构化的“回复中断”证据。
function classifyAutoContinueControllerSnapshot(snapshot) {
  var s = snapshot || {};
  return classifyAutoContinueReply({
    observed: !!s.assistantId,
    busy: !!s.busy,
    manualStop: !!s.manualStop,
    error: !!s.error,
    networkFailure: !!s.networkFailure,
    completionMarker: !!s.completionMarker,
    hasCompletionActions: !!(s.complete || s.terminal),
    looksTruncated: !!s.assistantId && !s.busy && !s.complete && !s.terminal,
  });
}

function autoContinueMessageText(message) {
  var blocks = message && Array.isArray(message.content) ? message.content : [];
  return blocks.filter(function (block) {
    return block && (block.type === 'text' || block.type === 'markdown') && typeof block.text === 'string';
  }).map(function (block) { return block.text; }).join('\n');
}

function autoContinueControllerCompleted(snapshot) {
  var s = snapshot || {};
  return s.terminalKnown ? !!s.terminal : !!s.complete;
}

function selectAutoContinueAssistant(messageState) {
  var state = messageState || {};
  var messages = Array.isArray(state.messages) ? state.messages : [];
  var streamingMessageId = state.streamingMessageId == null ? '' : String(state.streamingMessageId);
  var streamingRequestId = state.streamingRequestId == null ? '' : String(state.streamingRequestId);
  if (streamingMessageId || streamingRequestId) {
    for (var si = messages.length - 1; si >= 0; si--) {
      var streaming = messages[si];
      if (!streaming || streaming.messageType !== 'assistant') continue;
      if ((streamingMessageId && String(streaming.id || '') === streamingMessageId) ||
          (streamingRequestId && String(streaming.requestId || '') === streamingRequestId)) return streaming;
    }
  }
  for (var mi = messages.length - 1; mi >= 0; mi--) {
    var message = messages[mi];
    if (!message || message.messageType !== 'assistant') continue;
    var id = String(message.id || message.requestId || '');
    if (/^timeline:/.test(id)) continue; // context-compaction 等时间线合成项不是一次助手回复
    return message;
  }
  return null;
}

function normalizeQueueText(value) {
  var parts = [];
  if (Array.isArray(value)) {
    value.forEach(function (block) {
      if (block && typeof block.text === 'string' && block.text) parts.push(block.text);
    });
  } else if (value && typeof value === 'object' && Array.isArray(value.contentBlocks)) {
    return normalizeQueueText(value.contentBlocks);
  } else if (typeof value === 'string') {
    parts.push(value);
  }
  return parts.join('\n').replace(/\s+/g, ' ').trim();
}

function parseComposerContentBlock(node) {
  if (!node || !node.getAttribute) return null;
  try {
    var raw = node.getAttribute('data-contentblock') || '';
    return JSON.parse(raw.indexOf('&quot;') >= 0 ? raw.replace(/&quot;/g, '"') : raw);
  } catch (e) {
    return null;
  }
}

// Preserve the DOM order of text and inline content blocks. Reading innerText
// separately from querySelectorAll loses that order when quotes are interleaved.
function composerBlocksFromTree(editor) {
  if (!editor || !editor.childNodes) return [];

  function appendText(output, value) {
    var text = String(value || '').replace(/[\uFEFF\u200B]/g, '');
    if (!text) return;
    var last = output[output.length - 1];
    if (last && last.type === 'text') last.text += text;
    else output.push({ type: 'text', text: text });
  }

  function collect(node, output) {
    if (!node) return;
    if (node.nodeType === 3) {
      appendText(output, node.nodeValue || '');
      return;
    }
    if (node.nodeType !== 1) return;
    if (node.hasAttribute && node.hasAttribute('data-slate-placeholder')) return;
    if (node.hasAttribute && node.hasAttribute('data-contentblock')) {
      var item = parseComposerContentBlock(node);
      if (item && item.type) output.push(item);
      return;
    }
    var children = node.childNodes || [];
    for (var i = 0; i < children.length; i++) collect(children[i], output);
  }

  var blocks = [];
  for (var i = 0; i < editor.childNodes.length; i++) {
    var part = [];
    collect(editor.childNodes[i], part);
    if (!part.length) continue;
    if (blocks.length) appendText(blocks, '\n');
    for (var j = 0; j < part.length; j++) {
      if (part[j].type === 'text') appendText(blocks, part[j].text);
      else blocks.push(part[j]);
    }
  }
  while (blocks.length && blocks[0].type === 'text' && !blocks[0].text) blocks.shift();
  while (blocks.length && blocks[blocks.length - 1].type === 'text' && !blocks[blocks.length - 1].text) blocks.pop();
  return blocks;
}

function composerTextFromTree(editor) {
  return composerBlocksFromTree(editor).filter(function (block) {
    return block && block.type === 'text';
  }).map(function (block) { return block.text; }).join('');
}

function selectionQuoteMeta(meta) {
  if (!meta || meta.selectionQuote !== true) return null;
  var safe = {};
  ['displayAsPhrase', 'displayAsContext', 'displayText', 'selectionQuote', 'mentionType',
   'selectedText', 'title'].forEach(function (key) {
    var value = meta[key];
    if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') safe[key] = value;
  });
  return safe;
}

function contentItemToBlock(it) {
  if (!it || it.type === 'text') return null;
  if (it.type === 'image' && it.imageBase64) {
    return { type: 'image', data: it.imageBase64, mimeType: 'image/png', uri: it.uri || '' };
  }
  if (it.type === 'image') {
    return { type: 'image', data: it.data || '', mimeType: 'image/png', uri: it.uri || '' };
  }
  var block = { type: it.type, name: it.name || '附件', uri: it.uri || '', title: it.title || it.name || '附件' };
  if (it.mimeType) block.mimeType = it.mimeType;
  var quoteMeta = it.type === 'resource_link' ? selectionQuoteMeta(it._meta) : null;
  if (quoteMeta) block._meta = quoteMeta;
  return block;
}

// Convert captured composer data into clone-safe WorkBuddy queue blocks. Selection
// quotes keep their serializable metadata so the official editor can restore the tag.
function contentToBlocks(content) {
  if (content && Array.isArray(content.orderedBlocks)) {
    return content.orderedBlocks.map(function (block) {
      if (block && block.type === 'text') {
        return { type: 'text', text: block.text || '' };
      }
      return contentItemToBlock(block);
    }).filter(function (block) { return !!block; });
  }
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
        var block = contentItemToBlock(it);
        if (block) {
          blocks.push(block);
        }
      }
    } catch (e) {}
  });
  return blocks;
}

// Queue ids are the only authoritative identity. Text is an exact fallback for
// older renderers that did not expose ids; substring matching is deliberately
// forbidden because ordinary prompts commonly contain a stashed prompt.
function isStashQueueItem(item, stashIds, stashTexts) {
  var it = item || {};
  var ids = Array.isArray(stashIds) ? stashIds.map(String) : [];
  var id = it.id == null ? '' : String(it.id);
  if (ids.length) return !!id && ids.indexOf(id) >= 0;
  var text = normalizeQueueText(it.contentBlocks || it.blocks || it.content);
  if (!text) return false;
  var texts = Array.isArray(stashTexts) ? stashTexts : [];
  return texts.some(function (stashText) {
    return normalizeQueueText(stashText) === text;
  });
}

function stashContentSignature(content) {
  var c = content || {};
  var items = Array.isArray(c.items) ? c.items.map(function (item) {
    return [item && item.type || '', item && item.uri || '', item && item.name || ''].join(':');
  }).join('|') : '';
  return normalizeQueueText(c.text || '') + '||' + items;
}

function stashContentMatches(expected, current) {
  return !!expected && !!current && stashContentSignature(expected) === stashContentSignature(current);
}

// Pure approval-label/context gate shared by the renderer fallback and tests.
// Keep this deliberately narrow: a generic "确认" button must never qualify.
function classifyNoDisturbApprovalCandidate(input) {
  var value = input || {};
  var label = String(value.label || '').trim().replace(/^\d+\s*/, '');
  var kind = null;
  if (/始终允许|Always\s*allow/i.test(label)) kind = 'session';
  else if (/^(允许|允许一次|Allow|Yes|同意|批准|确认允许)$/i.test(label) || (/^Yes/i.test(label) && label.length < 24)) kind = 'once';
  if (!kind || value.disabled || value.ariaDisabled) return null;
  var context = String(value.context || '').slice(0, 700);
  if (value.creditSeen || /积分|信用|credit|消耗|付费|支付|费用|金额|余额|扣费/i.test(context)) return null;
  var keywordHit = /批量删除|沙箱|越界|越权|系统级工具|系统工具|权限|允许访问|将运行|需要你确认|需要你的确认|确认允许|检测到|受保护|敏感|凭据|黑名单|sandbox|approval|permission/i.test(context);
  var structuredHit = value.hasDeny === true && value.hasOnce === true && Number(value.buttonCount || 0) >= 2 && Number(value.buttonCount || 0) <= 12;
  return keywordHit || structuredHit ? kind : null;
}

function isSessionMonitorInProgress(snapshot) {
  return !!(snapshot && (snapshot.busy || snapshot.blocked || snapshot.hydrating));
}

var SESSION_MONITOR_ACTIVE_STATUSES = {
  planning: true, preparing: true, connecting: true, working: true, running: true,
  tool_start: true, tool_end: true, handoff: true, summarizing: true,
  waiting_team_members: true, model_requesting: true, model_streaming: true,
  model_done: true, tool_executing: true, await_input: true, awaitinput: true,
  waiting_input: true, waiting_user_input: true,
};
var SESSION_MONITOR_TERMINAL_STATUSES = {
  completed: true, cancelled: true, canceled: true, done: true, failed: true,
  error: true, terminated: true, archived: true, deleted: true, killed: true,
};

function normalizeSessionMonitorStatus(value) {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/[\s-]+/g, '_') : '';
}

function sessionMonitorLifecycleAction(update, exists) {
  if (!update || !update.id) return 'ignore';
  if (update.terminal) return exists ? 'remove' : 'ignore';
  if (!update.active) return exists ? 'update' : 'ignore';
  return exists ? 'update' : 'add';
}

// WorkBuddy's session resource is the authoritative cross-session lifecycle
// source. Prefer any terminal token across status/protocolStatus/state so a
// stale working field cannot mask a newer completed protocol status.
function normalizeSessionMonitorResourceRecord(record, eventName) {
  var value = record && typeof record === 'object' ? record : {};
  var id = String(value.id || value.sessionId || value.conversationId || '').trim();
  if (!id) return null;
  var tokens = [value.protocolStatus, value.status, value.state].map(normalizeSessionMonitorStatus).filter(Boolean);
  if (eventName === 'sessionDeleted') tokens.unshift('deleted');
  var terminalStatus = '';
  for (var i = 0; i < tokens.length; i++) {
    if (SESSION_MONITOR_TERMINAL_STATUSES[tokens[i]]) { terminalStatus = tokens[i]; break; }
  }
  var status = terminalStatus || tokens[0] || '';
  var pendingInputKind = normalizeSessionMonitorStatus(value.pendingInputKind);
  var queueRuntime = value.messageQueueRuntime && typeof value.messageQueueRuntime === 'object' ? value.messageQueueRuntime : null;
  var queueActive = !!(queueRuntime && queueRuntime.paused !== true &&
    (queueRuntime.inflightItemId || Number(queueRuntime.pendingItemCount || 0) > 0 ||
      Number(queueRuntime.sendingItemCount || 0) > 0));
  var promptActive = typeof value.activePromptStartedAt === 'number' && Number.isFinite(value.activePromptStartedAt);
  var active = !terminalStatus && (!!SESSION_MONITOR_ACTIVE_STATUSES[status] ||
    pendingInputKind === 'permission' || pendingInputKind === 'question' || pendingInputKind === 'user_input' ||
    queueActive || promptActive);
  return {
    id: id,
    title: String(value.name || value.title || '').slice(0, 120),
    status: status,
    pendingInputKind: pendingInputKind,
    active: active,
    terminal: !!terminalStatus,
    event: String(eventName || 'sessionUpdated'),
  };
}

function subscribeSessionMonitorResource(resource, listener) {
  if (!resource || typeof resource.on !== 'function' || typeof listener !== 'function') return function () {};
  var subscriptions = [];
  function recordsFromPayload(eventName, payload) {
    if (eventName !== 'sessionsChanged') return [payload];
    if (Array.isArray(payload)) return payload;
    if (!payload || typeof payload !== 'object') return [];
    return payload.agents || payload.sessions || payload.conversations || payload.records || [];
  }
  ['sessionUpdated', 'sessionCreated', 'sessionDeleted', 'sessionsChanged'].forEach(function (eventName) {
    var handler = function (payload) {
      var records = recordsFromPayload(eventName, payload);
      for (var i = 0; i < records.length; i++) {
        var update = normalizeSessionMonitorResourceRecord(records[i], eventName);
        if (update) listener(update);
      }
    };
    try {
      resource.on(eventName, handler);
      subscriptions.push([eventName, handler]);
    } catch (_) {}
  });
  return function () {
    if (typeof resource.off !== 'function') return;
    for (var i = 0; i < subscriptions.length; i++) {
      try { resource.off(subscriptions[i][0], subscriptions[i][1]); } catch (_) {}
    }
    subscriptions = [];
  };
}

// In-memory state for background-session monitors. This deliberately has no
// persistence or daemon transport: the About-page viewer is a live diagnostic
// surface and must not turn conversation activity into a local log file.
function createSessionMonitorRegistry(options) {
  var opts = options || {};
  var maxLogs = Math.max(1, Number(opts.maxLogs || 160));
  var maxSessions = Math.max(1, Number(opts.maxSessions || 64));
  var sessions = Object.create(null);
  var order = [];
  function ensure(id, meta) {
    var key = String(id || '').trim();
    if (!key) return null;
    if (!sessions[key]) {
      if (order.length >= maxSessions) {
        var evicted = order.shift();
        if (evicted) delete sessions[evicted];
      }
      sessions[key] = { id: key, title: '', status: 'unknown', updatedAt: 0, logs: [] };
      order.push(key);
    }
    if (meta) {
      if (meta.title != null) sessions[key].title = String(meta.title).slice(0, 120);
      if (meta.status != null) sessions[key].status = String(meta.status).slice(0, 40);
    }
    sessions[key].updatedAt = Date.now();
    return sessions[key];
  }
  function update(id, patch) {
    var item = ensure(id);
    if (!item) return null;
    var p = patch || {};
    Object.keys(p).forEach(function (key) {
      if (key === 'logs' || key === 'id') return;
      item[key] = p[key];
    });
    item.updatedAt = Date.now();
    return item;
  }
  function append(id, event, detail) {
    var item = ensure(id);
    if (!item) return null;
    var entry = {
      at: Date.now(),
      event: String(event || 'event').slice(0, 80),
      detail: detail && typeof detail === 'object' ? Object.assign({}, detail) : {},
    };
    item.logs.push(entry);
    if (item.logs.length > maxLogs) item.logs.splice(0, item.logs.length - maxLogs);
    item.updatedAt = entry.at;
    return entry;
  }
  function remove(id) {
    var key = String(id || '').trim();
    if (!sessions[key]) return false;
    delete sessions[key];
    var index = order.indexOf(key);
    if (index >= 0) order.splice(index, 1);
    return true;
  }
  function clear() {
    sessions = Object.create(null);
    order = [];
  }
  function list() {
    return order.map(function (key) { return sessions[key]; }).filter(Boolean);
  }
  return { ensure: ensure, update: update, append: append, remove: remove, clear: clear, list: list, get: function (id) { return sessions[String(id || '')] || null; } };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    createBuildLifecycle: createBuildLifecycle,
    classifySessionHealth: classifySessionHealth,
    classifyAutoContinueReply: classifyAutoContinueReply,
    classifyAutoContinueControllerSnapshot: classifyAutoContinueControllerSnapshot,
    autoContinueMessageText: autoContinueMessageText,
    autoContinueControllerCompleted: autoContinueControllerCompleted,
    selectAutoContinueAssistant: selectAutoContinueAssistant,
    composerBlocksFromTree: composerBlocksFromTree,
    composerTextFromTree: composerTextFromTree,
    contentToBlocks: contentToBlocks,
    normalizeQueueText: normalizeQueueText,
    isStashQueueItem: isStashQueueItem,
    stashContentSignature: stashContentSignature,
    stashContentMatches: stashContentMatches,
    classifyNoDisturbApprovalCandidate: classifyNoDisturbApprovalCandidate,
    isSessionMonitorInProgress: isSessionMonitorInProgress,
    normalizeSessionMonitorResourceRecord: normalizeSessionMonitorResourceRecord,
    sessionMonitorLifecycleAction: sessionMonitorLifecycleAction,
    subscribeSessionMonitorResource: subscribeSessionMonitorResource,
    createSessionMonitorRegistry: createSessionMonitorRegistry,
  };
}
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
(function () {
  // 兜底清理：移除任何历史版本注入的残留节点，并清除旧守卫。
  // 关键：必须在守卫判断之前执行，否则旧注册的 window.__wbsWidget 会拦截新代码，
  // 导致“改了文件、重启守护、Command+R 仍跑旧逻辑 / 旧按钮残留”。
  (function () {
    var n;
    if ((n = document.querySelector('.wbs-root'))) n.remove();
    var st = document.querySelectorAll('.wbs-stash-inline, .wbs-stash-btn, .wbs-explore-inline, .wbs-selection-quote-btn');
    for (var i = 0; i < st.length; i++) st[i].remove();
    var nav = document.querySelectorAll('.wbs-message-nav-root');
    for (var ni = 0; ni < nav.length; ni++) nav[ni].remove();
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
    // 队列 adapter 缓存必须一并清除：旧 shim（包装方法齐全但指向失效/错误对象）若不删，
    // findWbsAdapter 的缓存校验会直接复用旧 shim，导致「修好代码重注入后仍跑旧逻辑」。
    try { delete window.__wbsAdapter; } catch (e) { window.__wbsAdapter = null; }
  })();
  // ===== 顶部红色角标已移除（用户要求）；仅保留 console 标记 =====
  try { console.log('[WBS] inject.js 已执行于', location.href, 'body=', !!document.body); } catch (_) {}
  if (window.__wbsWidget) return; // 理论上 cleanup 已清除，保留为兜底
  var API = '__WBS_API__';
  var PROFILE_ID = '__WBS_PROFILE__';
  var CAPS = __WBS_CAPS__;
  var WBS_API_TOKEN = '__WBS_API_TOKEN__';
  var WBS_DIAGNOSTICS_ENABLED = __WBS_DIAGNOSTICS_ENABLED__;
  var WBS_PLATFORM = __WBS_PLATFORM__; // 注入时替换为 JSON 字符串（如 "darwin"/"win32"）
  var WBS_COMPAT = window.__wbsWorkBuddyCompat;
  if (!WBS_COMPAT) throw new Error('WorkBuddy 兼容层未加载');
  // WorkBuddy 基于 Electron，持续会话模块在 macOS/Windows 使用同一套 CDP 逻辑。
  var AC_SUPPORTED = true;
  // 客户端身份只控制真实的 profile 差异；DOM 与队列能力由 WBS_COMPAT 独立判断。
  var WBS_PROFILE_IS_AI = PROFILE_ID === 'workbuddy-ai';
  var WBS_BRAND = WBS_PROFILE_IS_AI ? 'WorkDaddy AI' : 'WorkDaddy';

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
      if (WBS_DIAGNOSTICS_ENABLED) {
        try {
          fetch(API + '/api/breadcrumb', { method: 'POST', headers: { 'content-type': 'application/json', 'X-WorkDaddy-Token': WBS_API_TOKEN }, body: JSON.stringify({ msg: 'crash:' + kind + ':' + msg, extra: { stack: (stack || '').slice(0, 1500) } }) }).catch(function () {});
        } catch (_) {}
      }
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
  // 当前使用中角标：回复/右转箭头（用户指定图形，颜色跟随昵称文字色）
  var CUR_MARK_SVG =
    '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">' +
    '<path fill="currentColor" d="M4.472 4.75c-.597 0-1.293.166-1.862.519c-.58.358-1.11.974-1.11 1.856v9.75c0 .882.53 1.497 1.11 1.856c.57.353 1.265.519 1.862.519H14.77a2.75 2.75 0 0 0 1.92-.781l5.35-5.216a1.75 1.75 0 0 0 0-2.506l-5.35-5.216a2.75 2.75 0 0 0-1.92-.781z"/></svg>';
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

  // 暂存提示词按钮图标：纯色「标签」图标（实心填充风，非线条）；fill 用 currentColor 跟随按钮文字色（主题适配）
  var STASH_SVG =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M21.41 11.58l-9-9C12.05 2.22 11.55 2 11 2H4a2 2 0 0 0-2 2v7c0 .55.22 1.05.59 1.42l9 9c.36.36.86.58 1.41.58.55 0 1.05-.22 1.41-.59l7-7c.37-.36.59-.86.59-1.41 0-.55-.22-1.06-.59-1.42zM5.5 7C4.67 7 4 6.33 4 5.5S4.67 4 5.5 4 7 4.67 7 5.5 6.33 7 5.5 7z"/>' +
    '<circle cx="5.5" cy="5.5" r="1.5" fill="currentColor"/>' +
    '</svg>';

  // 探索菜单按钮图标（对话气泡矢量图，fill 跟随按钮文字色；尺寸与暂存按钮图标一致 16）
  var EXPLORE_SVG =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">' +
    '<path fill="currentColor" d="M19 3a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7.333L4 21.5c-.824.618-2 .03-2-1V6a3 3 0 0 1 3-3h14Zm-8 9H8a1 1 0 1 0 0 2h3a1 1 0 1 0 0-2Zm5-4H8a1 1 0 0 0-.117 1.993L8 10h8a1 1 0 0 0 .117-1.993L16 8Z"/></svg>';
  var EXPLORE_PREMIUM_SVG =
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>';
  var EXPLORE_CHECK_SVG =
    '<svg viewBox="0 0 20 20" width="15" height="15" fill="currentColor"><path d="M16.707 5.293a1 1 0 0 1 0 1.414l-8 8a1 1 0 0 1-1.414 0l-4-4a1 1 0 0 1 1.414-1.414L8 12.586l7.293-7.293a1 1 0 0 1 1.414 0z" clip-rule="evenodd" fill-rule="evenodd"/></svg>';
  var EXPLORE_LOCK_SVG =
    '<svg viewBox="0 0 20 20" width="15" height="15" fill="currentColor"><path d="M5 9V7a5 5 0 0 1 10 0v2a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2zm8-2v2H7V7a3 3 0 1 1 6 0z" clip-rule="evenodd" fill-rule="evenodd"/></svg>';

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

  function esc(t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function escAttr(t) { return esc(t).replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

  function checkinHtml(a) {
    // 国际版不开放签到活动：积分卡上的签到标签整体不展示（CN 版保留完整逻辑）
    if (PROFILE_ID === 'workbuddy-ai') return '';
    var c = a && a.checkin;
    if (!c) return '<span class="wbs-ck wbs-checkin-tag pending">签到中</span>';
    var msg = c.message || '';
    // 国际版/活动空窗期：接口 code 10001 且文案表明「活动未开启/未开始/已过期」时，
    // 并不是“今日已签到”，不应展示绿色成功标签，改为中性「无签到活动」。
    if (c.inactive || (c.ok && /未开启|未开始|未开放|已过期|无.*活动|活动.*(结束|关闭|暂停)/i.test(msg))) {
      return '<span class="wbs-ck wbs-checkin-tag pending">无签到活动</span>';
    }
    // “本轮刚领取”和“今天已领取过”都是成功态，统一展示避免同一页面出现两套文案。
    if (c.ok) return '<span class="wbs-ck wbs-checkin-tag ok">今日已签到✓</span>';
    // 认证类错误（401/未授权）统一显示友好文案（daemon 已产出，缓存残留旧文案时兜底）
    if (/401|Unauthorized|未授权|登录身份过期/.test(msg)) msg = '登录身份过期';
    return '<span class="wbs-ck wbs-checkin-tag fail">' + esc(msg) + '</span>';
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = String(text);
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
      // 新版布局（无 voice-mic-wrap）：输入框特征是 [contenteditable=true]，且位于视口下半部、
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
  // innerText 会包含占位文字；contentblock 的可见标签也不是正文。统一通过
  // composerTextFromTree 跳过这两类装饰子树。
  function composerHasContent(editor) {
    if (!editor) return false;
    var text = composerTextFromTree(editor).replace(/[\uFEFF\u200B\u00A0]/g, '').replace(/\s+/g, '');
    if (text.length > 0) return true;
    if (editor.querySelector && editor.querySelector('[data-contentblock]')) return true;
    return false;
  }
  // 干净地抓取输入框内容：只取 Slate 节点（不受页面装饰干扰）
  function getComposerContent() {
    var editor = findComposer();
    if (!editor) return null;
    var orderedBlocks = composerBlocksFromTree(editor);
    var text = orderedBlocks.filter(function (block) { return block.type === 'text'; })
      .map(function (block) { return block.text; }).join('');
    var items = orderedBlocks.filter(function (block) { return block.type !== 'text'; });
    return {
      text: text,
      textLen: text.replace(/[\uFEFF\u200B]/g, '').trim().length,
      items: items,
      orderedBlocks: orderedBlocks,
      capturedAt: new Date().toISOString(),
    };
  }
  // 尽量拿到当前会话 id（URL / 当前布局选中会话 / 标题兜底）
  function getConversationId() {
    try {
      var u = new URL(location.href);
      var q = u.searchParams.get('conversationId') || u.searchParams.get('conversation_id');
      if (q) return q;
    } catch (_) {}
    var selectedId = WBS_COMPAT.getSelectedConversationId(document);
    if (selectedId) return selectedId;
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
      var t = el('div', 'wbs-toast' + (isErr ? ' err' : ''));
      t.textContent = String(msg == null ? '' : msg);
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
      var looksTruncated = /(\.\.\.|…|正在$|等待$|调用$|执行$|结果如下[:：]?$)/.test(text);
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

    // 根节点（面板保持右下角，按钮拖动后水平回到右侧）
    var root = el('div', 'wbs-root');
    root.setAttribute('data-wbs-profile', PROFILE_ID);
    if (!CAPS.theme) root.classList.add('wbs-no-theme');
    if (!CAPS.stashPrompt) root.classList.add('wbs-no-stash');
    root.innerHTML = [
      '<div class="wbs-fab" title="' + WBS_BRAND + '">',
      '<span class="wbs-fab-health-dot" title="会话状态" style="display:none"></span>',
      '<div class="click">',
      '<span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span>',
      '<button class="button up" type="button" aria-label="WorkDaddy，点击打开面板，可拖动">',
      '<span class="wbs-fab-antenna" aria-hidden="true"></span>',
      '<span class="wbs-fab-antenna-dot" id="wbs-fab-sleep-light" title="允许电脑休眠（默认）"></span>',
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
      '<div class="wbs-title" id="wbs-title" title="WorkDaddy">' + WBS_BRAND + '</div>',
      '<button class="wbs-pick-btn" id="wbs-pick-btn" type="button" style="display:none" title="元素检查">🔍</button>',
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
    // 主题能力由 profile capabilities 统一控制，两个 WorkBuddy 客户端均可使用。
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
    // 防输入框失焦：点击按钮时不把焦点从输入框抢走（退格/打字持续有效）
    stashBtn.addEventListener('mousedown', function (e) { e.preventDefault(); });
    if (!CAPS.stashPrompt) stashBtn.style.display = 'none';

    // 探索菜单按钮：复用暂存提示词按钮的样式类（同款圆钮），hover 不变宽；悬浮弹出菜单
    var exploreBtn = document.createElement('div');
    exploreBtn.className = 'wbs-stash-inline wbs-explore-inline';
    exploreBtn.setAttribute('role', 'button');
    exploreBtn.setAttribute('tabindex', '0');
    exploreBtn.addEventListener('mousedown', function (e) { e.preventDefault(); }); // 防输入框失焦
    exploreBtn.innerHTML =
      '<span class="wbs-explore-ico">' + EXPLORE_SVG + '</span>' +
      '<div class="wbs-explore-pop" role="tooltip">' +
      '<div class="wbs-explore-card">' +
      '<div class="wbs-explore-list" id="wbs-explore-list"></div>' +
      '<div class="wbs-explore-foot">' +
      '<span class="wbs-explore-send-txt">点击后发送</span>' +
      '<a class="wbs-explore-edit" href="#" onclick="return false">编辑 →</a>' +
      '</div>' +
      '</div>' +
      '</div>';
    var exploreSendTxt = exploreBtn.querySelector('.wbs-explore-send-txt');
    if (exploreSendTxt) {
      exploreSendTxt.addEventListener('click', function (e) {
        e.stopPropagation();
        acMenuClose();
        api('/api/auto-continue-send-current', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        }).then(function (d) {
          if (!d || !d.ok) toast('发送失败: ' + ((d && d.error) || 'daemon 未确认'), true, root);
        }).catch(function (e2) { toast('发送失败: ' + (e2.message || e2), true, root); });
      });
    }
    var exploreEditBtn = exploreBtn.querySelector('.wbs-explore-edit');
    if (exploreEditBtn) {
      exploreEditBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        acMenuClose();
        // 唤起 WorkDaddy 面板并聚焦「增强」页（快捷短语管理区）
        try {
          if (!state.open) setOpen(true);
          setTimeout(function () {
            var t = root && root.querySelector('.wbs-tab[data-tab="enhance"]');
            if (t) t.click();
            setTimeout(function () {
              var area = enhancePane && enhancePane.querySelector('#wbs-qp-area');
              if (area && area.scrollIntoView) { try { area.scrollIntoView({ block: 'nearest' }); } catch (_) {} }
            }, 200);
          }, 80);
        } catch (e2) {
          toast('打开面板失败: ' + (e2.message || e2), true, root);
        }
      });
    }
    // 面板关闭/重开：点击选项（发送/编辑/任意项）后关闭面板；重新进入按钮区恢复 hover 可展示
    function acMenuClose() {
      exploreBtn.classList.add('wbs-menu-closed');
    }
    exploreBtn.addEventListener('mouseenter', function () { exploreBtn.classList.remove('wbs-menu-closed'); });
    exploreBtn.addEventListener('mouseleave', function () { exploreBtn.classList.remove('wbs-menu-closed'); });
    if (isWelcomePage()) exploreBtn.style.display = 'none'; // 欢迎页无操作栏，定位没意义；其余情况由 syncStash 常驻显示

    /* ———— 会话模块（session）：暂存提示词、会话消息索引、选中文字引用 & 快捷短语 ————
     * 暂存提示词/快捷短语由 daemon 持久化；消息索引开关保存在渲染器 localStorage。
     * stash 按钮显隐受「暂存提示词」开关影响；explore 按钮与面板选项受「快捷短语」开关/列表影响。 */
    var MESSAGE_NAV_ENABLED_KEY = 'workdaddy.session.messageNavigationEnabled';
    var SELECTION_QUOTE_ENABLED_KEY = 'workdaddy.session.selectionQuoteEnabled';
    function readMessageNavigationEnabled() {
      try { return localStorage.getItem(MESSAGE_NAV_ENABLED_KEY) !== '0'; } catch (_) { return true; }
    }
    function writeMessageNavigationEnabled(enabled) {
      try { localStorage.setItem(MESSAGE_NAV_ENABLED_KEY, enabled ? '1' : '0'); } catch (_) {}
    }
    function readSelectionQuoteEnabled() {
      try { return localStorage.getItem(SELECTION_QUOTE_ENABLED_KEY) !== '0'; } catch (_) { return true; }
    }
    function writeSelectionQuoteEnabled(enabled) {
      try { localStorage.setItem(SELECTION_QUOTE_ENABLED_KEY, enabled ? '1' : '0'); } catch (_) {}
    }
    var sessState = {
      stash: true,
      messageNav: readMessageNavigationEnabled(),
      selectionQuote: readSelectionQuoteEnabled(),
      phrase: true,
      phrases: [],
      qpBatch: false,
      qpSel: {},
    };
    var sessLastExploreSig = ''; // 面板选项渲染签名（内容未变不重建保留 tooltip 状态）
    var sessLastQpSig = ''; // 增强页列表渲染签名（内容/批量模式/选中集未变不重建）
    function applySessionModule(d) {
      if (!d || !d.ok) return;
      sessState.stash = !!d.stashEnabled;
      sessState.phrase = !!d.phraseEnabled;
      sessState.phrases = Array.isArray(d.phrases) ? d.phrases : [];
      // 同步 UI：会话开关 + 快捷短语列表区显隐
      var pane0 = enhancePane;
      var swS = pane0 && pane0.querySelector('#wbs-sess-stash');
      var swN = pane0 && pane0.querySelector('#wbs-sess-message-nav');
      var swQ = pane0 && pane0.querySelector('#wbs-sess-selection-quote');
      var swP = pane0 && pane0.querySelector('#wbs-sess-phrase');
      var area = pane0 && pane0.querySelector('#wbs-qp-area');
      if (swS) swS.checked = !!sessState.stash;
      if (swN) swN.checked = !!sessState.messageNav;
      if (swQ) swQ.checked = !!sessState.selectionQuote;
      if (swP) swP.checked = !!sessState.phrase;
      if (area) area.style.display = sessState.phrase ? '' : 'none';
      renderQpList();
      renderExploreOptions();
      syncStash(); // 刷新输入框两个按钮的显隐（受开关影响）
    }
    function syncSessionModule() {
      api('/api/session-module').then(function (d) {
        if (d && d.ok) applySessionModule(d);
      }).catch(function () {});
    }
    /** 开关切换：写 daemon 并回应用户界（设置失败回滚 UI 状态） */
    function setSessionSwitchWire(name, el) {
      var v = !!el.checked;
      api('/api/session-module-set', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name, enabled: v }),
      }).then(function (d) {
        if (!d || !d.ok) throw new Error((d && d.error) || 'daemon 未确认');
        applySessionModule(d);
      }).catch(function (e) {
        toast('设置失败: ' + (e.message || e), true, root);
        syncSessionModule();
      });
    }

    // 轻量选区引用：只保存当前选中的文字，通过 WorkBuddy 官方 content-block 请求插入输入框。
    // 不复制 Codex 的 locator/回复标注协议，避免依赖脆弱的内部状态。
    var selectionQuoteButton = null;
    var selectionQuotePending = null;
    var selectionQuoteFrame = null;
    var SELECTION_QUOTE_MAX_LENGTH = 12000;
    /* WorkBuddy 的 selection-quote renderer 会通过 InputContextTag 自己渲染消息图标。 */

    function selectionQuoteElement(range) {
      if (!range || !range.commonAncestorContainer) return null;
      var node = range.commonAncestorContainer;
      var element = node.nodeType === 1 ? node : node.parentElement;
      if (!element || !element.closest) return null;
      if (element.closest('.wbs-root,.wbs-selection-quote-btn,textarea,input')) return null;
      var editable = element.closest('[contenteditable="true"]');
      var composer = findComposer();
      if (editable && composer && editable === composer) return null;
      return element.closest(
        '[data-message-id],[data-message-request-id],.cb-message,.cr-message,.cr-message-content,' +
        '[class*="message-content"],[class*="messageContent"],[class*="message-bubble"],[class*="messageBubble"]'
      ) || element.closest('.cr-document[data-root-id]');
    }

    function selectionQuoteBlock(text) {
      return {
        type: 'resource_link',
        name: '引用文本',
        uri: 'selection://document-selection',
        _meta: {
          displayAsPhrase: true,
          displayAsContext: false,
          displayText: '引用文本',
          selectionQuote: true,
          mentionType: 'selection',
          selectedText: text,
          title: '引用文本',
        },
      };
    }

    function hideSelectionQuoteButton() {
      if (selectionQuoteButton) selectionQuoteButton.style.display = 'none';
      selectionQuotePending = null;
    }

    function updateSelectionQuoteButton() {
      selectionQuoteFrame = null;
      if (!alive || !sessState.selectionQuote || !selectionQuoteButton) return;
      var sel = window.getSelection && window.getSelection();
      if (!sel || sel.rangeCount < 1 || sel.isCollapsed) return hideSelectionQuoteButton();
      var range = sel.getRangeAt(0);
      var message = selectionQuoteElement(range);
      var text = String(sel.toString() || '').trim();
      if (!message || !text || text.length > SELECTION_QUOTE_MAX_LENGTH) return hideSelectionQuoteButton();
      var rect = range.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0 || rect.bottom < 0 || rect.top > window.innerHeight) {
        return hideSelectionQuoteButton();
      }
      selectionQuotePending = { text: text, rect: rect };
      selectionQuoteButton.style.display = 'inline-flex';
      var buttonRect = selectionQuoteButton.getBoundingClientRect();
      var left = Math.max(8, Math.min(window.innerWidth - buttonRect.width - 8, rect.right - buttonRect.width));
      var top = rect.top - buttonRect.height - 8;
      if (top < 8) top = Math.min(window.innerHeight - buttonRect.height - 8, rect.bottom + 8);
      selectionQuoteButton.style.left = Math.round(left) + 'px';
      selectionQuoteButton.style.top = Math.round(Math.max(8, top)) + 'px';
    }

    function scheduleSelectionQuoteButton() {
      if (selectionQuoteFrame !== null) return;
      var request = window.requestAnimationFrame || function (callback) { return setTimeout(callback, 40); };
      selectionQuoteFrame = request(updateSelectionQuoteButton);
    }

    function insertSelectionQuote() {
      var pending = selectionQuotePending;
      if (!pending || !pending.text) return;
      hideSelectionQuoteButton();
      var adapter = null;
      try { adapter = window.__wbsAdapter || findWbsAdapter(); } catch (_) {}
      if (!adapter || typeof adapter.requestInsertContentBlocks !== 'function') {
        toast('当前输入框暂不支持引用插入', true, root);
        return;
      }
      var request = { contentBlocks: [selectionQuoteBlock(pending.text)] };
      try {
        Promise.resolve(adapter.requestInsertContentBlocks(request)).then(function () {
          toast('已引用选中文字', false, root);
        }).catch(function () {
          toast('引用插入失败，请重试', true, root);
        });
      } catch (_) {
        toast('引用插入失败，请重试', true, root);
      }
    }

    function setupSelectionQuote() {
      if (!document.body) return;
      if (!sessState.selectionQuote) hideSelectionQuoteButton();
      if (!selectionQuoteButton) {
        selectionQuoteButton = el('button', 'wbs-selection-quote-btn');
        selectionQuoteButton.type = 'button';
        selectionQuoteButton.setAttribute('aria-label', '引用文本');
        selectionQuoteButton.textContent = '引用文本';
        document.body.appendChild(selectionQuoteButton);
        listen(selectionQuoteButton, 'pointerdown', function (event) {
          if (event.preventDefault) event.preventDefault();
          if (event.stopPropagation) event.stopPropagation();
        });
        listen(selectionQuoteButton, 'click', function (event) {
          if (event.preventDefault) event.preventDefault();
          if (event.stopPropagation) event.stopPropagation();
          insertSelectionQuote();
        });
      }
      listen(document, 'selectionchange', scheduleSelectionQuoteButton);
      listen(document, 'mouseup', scheduleSelectionQuoteButton);
      listen(window, 'scroll', scheduleSelectionQuoteButton, true);
      listen(window, 'resize', scheduleSelectionQuoteButton);
      listen(document, 'keydown', function (event) {
        if (event.key === 'Escape') hideSelectionQuoteButton();
      });
      registerDisposer(function () {
        if (selectionQuoteFrame !== null) {
          var cancel = window.cancelAnimationFrame || clearTimeout;
          try { cancel(selectionQuoteFrame); } catch (_) {}
          selectionQuoteFrame = null;
        }
        if (selectionQuoteButton) { selectionQuoteButton.remove(); selectionQuoteButton = null; }
        selectionQuotePending = null;
      });
    }
    /** 增强页快捷短语列表渲染（含批量模式） */
    function renderQpList() {
      var pane1 = enhancePane;
      var listEl = pane1 && pane1.querySelector('#wbs-qp-list');
      if (!listEl) return;
      var phrases = sessState.phrases || [];
      // 签名去重：内容/批量模式/选中集无变化则不重建 DOM（防 hover 闪烁与 checkbox 抖动）
      var sig = (sessState.qpBatch ? 'B' : 'b') + '|' +
        Object.keys(sessState.qpSel).sort().join(',') + '|' +
        (phrases.length ? phrases.map(function (p) { return p.id + ':' + p.text; }).join('|') : 'empty');
      if (sig === sessLastQpSig) return;
      sessLastQpSig = sig;
      var barEl = pane1.querySelector('#wbs-qp-batchbar');
      var countEl = pane1.querySelector('#wbs-qp-batch-count');
      var batchBtn = pane1.querySelector('#wbs-qp-batch');
      var importBtn = pane1.querySelector('#wbs-qp-import');
      var addBtn = pane1.querySelector('#wbs-qp-add');
      var allBtn = pane1.querySelector('#wbs-qp-checkall');
      var selectedCount = Object.keys(sessState.qpSel).length;
      if (barEl) barEl.style.display = sessState.qpBatch ? 'inline-flex' : 'none';
      if (batchBtn) batchBtn.style.display = (sessState.qpBatch || !phrases.length) ? 'none' : '';
      if (importBtn) importBtn.style.display = sessState.qpBatch ? 'none' : '';
      if (addBtn) addBtn.style.display = sessState.qpBatch ? 'none' : '';
      if (countEl) countEl.textContent = '已选 ' + selectedCount;
      if (allBtn) allBtn.textContent = (sessState.qpBatch && phrases.length && selectedCount === phrases.length) ? '取消全选' : '全选';
      ['#wbs-qp-copy', '#wbs-qp-export', '#wbs-qp-batch-del'].forEach(function (selector) {
        var action = pane1.querySelector(selector);
        if (action) action.style.display = selectedCount ? '' : 'none';
      });
      if (!phrases.length) {
        listEl.innerHTML = '<div class="wbs-qp-empty">暂无快捷短语，点击「+ 新增」添加</div>';
        return;
      }
      var html = '';
      for (var i = 0; i < phrases.length; i++) {
        var ph = phrases[i];
        var checked = sessState.qpSel[ph.id] ? ' checked' : '';
        var cb = sessState.qpBatch ? '<input type="checkbox" class="wbs-qp-check" data-id="' + escAttr(ph.id) + '"' + checked + '>' : '';
        html +=
          '<div class="wbs-qp-row" data-id="' + escAttr(ph.id) + '">' +
          cb +
          '<span class="wbs-qp-text" title="' + escAttr(ph.text) + '">' + esc(ph.text) + '</span>' +
          '<span class="wbs-qp-actions">' +
          '<button type="button" class="wbs-qp-icon-btn" data-qp-edit="' + escAttr(ph.id) + '" title="编辑">' + MODEL_EDIT_SVG + '</button>' +
          '<button type="button" class="wbs-qp-icon-btn wbs-qp-del" data-qp-del="' + escAttr(ph.id) + '" title="删除">' + TRASH_SVG + '</button>' +
          '</span>' +
          '</div>';
      }
      listEl.innerHTML = html;
      var checks = listEl.querySelectorAll('.wbs-qp-check');
      for (var c = 0; c < checks.length; c++) {
        checks[c].addEventListener('change', function () {
          var qid = this.getAttribute('data-id');
          if (this.checked) sessState.qpSel[qid] = 1;
          else delete sessState.qpSel[qid];
          renderQpList();
        });
      }
      var edits = listEl.querySelectorAll('[data-qp-edit]');
      for (var e2 = 0; e2 < edits.length; e2++) {
        edits[e2].addEventListener('click', function (ev) { ev.stopPropagation(); openQpEdit(this.getAttribute('data-qp-edit')); });
      }
      var dels = listEl.querySelectorAll('[data-qp-del]');
      for (var d2 = 0; d2 < dels.length; d2++) {
        dels[d2].addEventListener('click', function (ev) { ev.stopPropagation(); confirmQpDelete([this.getAttribute('data-qp-del')]); });
      }
    }
    /** 发送按钮面板选项 = 快捷短语列表；点击项经 CDP 发送该短语（替换式，发完默认关面板） */
    function renderExploreOptions() {
      var listHost = exploreBtn && exploreBtn.querySelector('#wbs-explore-list');
      if (!listHost) return;
      var phrases = sessState.phrases || [];
      // 渲染签名去重：短语内容无变化则不重建 DOM（syncStash 高频调用会摧毁 tooltip 的显示状态/绑定 → 闪烁）
      var sig = phrases.length ? phrases.map(function (p) { return p.id + ':' + p.text; }).join('|') : 'empty';
      if (sig === sessLastExploreSig) return;
      sessLastExploreSig = sig;
      if (!phrases.length) {
        listHost.innerHTML = '<div class="wbs-qp-empty wbs-qp-empty-menu">暂无快捷短语</div>';
        return;
      }
      var html = '';
      for (var i = 0; i < phrases.length; i++) {
        var ph = phrases[i];
        html += '<div class="wbs-explore-item" data-qp-send="' + escAttr(ph.id) + '">' +
          '<span class="wbs-explore-it">' + esc(ph.text) + '</span>' +
          '<span class="wbs-explore-tip"><span class="wbs-explore-tip-body">' + esc(ph.text) + '</span></span>' +
          '</div>';
      }
      listHost.innerHTML = html;
      var items = listHost.querySelectorAll('[data-qp-send]');
      for (var k = 0; k < items.length; k++) {
        (function (itemK) {
          // tooltip 显隐由 JS 管理（mouseenter/mouseleave + 延迟隐藏），保证 选项→气泡 hover 连续，无闪烁
          var tipK = itemK.querySelector('.wbs-explore-tip');
          var hideTimer = null;
          function showTip() {
            if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
            tipK.style.opacity = '1';
            tipK.style.visibility = 'visible';
            tipK.style.pointerEvents = 'auto';
          }
          function hideTip() {
            tipK.style.opacity = '0';
            tipK.style.visibility = 'hidden';
            tipK.style.pointerEvents = 'none';
          }
          function hideTipDelayed() {
            if (hideTimer) clearTimeout(hideTimer);
            hideTimer = setTimeout(hideTip, 120);
          }
          if (tipK) {
            itemK.addEventListener('mouseenter', showTip);
            itemK.addEventListener('mouseleave', hideTipDelayed);
            tipK.addEventListener('mouseenter', function () { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } });
            tipK.addEventListener('mouseleave', hideTipDelayed);
          }
          itemK.addEventListener('click', function (eve) {
            eve.stopPropagation();
            var pid = itemK.getAttribute('data-qp-send');
            var ph2 = null;
            for (var m2 = 0; m2 < sessState.phrases.length; m2++) {
              if (sessState.phrases[m2].id === pid) { ph2 = sessState.phrases[m2]; break; }
            }
            if (!ph2) return;
            acMenuClose();
            api('/api/quick-phrase-send', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ text: ph2.text }),
            }).then(function (d) {
              if (!d || !d.ok) toast('发送失败: ' + ((d && d.error) || 'daemon 未确认'), true, root);
            }).catch(function (e3) { toast('发送失败: ' + (e3.message || e3), true, root); });
          });
        })(items[k]);
      }
    }
    /** 新增/编辑快捷短语弹窗（参考账号导出弹窗；textarea 最多 5 行 / 500 字） */
    function openQpEdit(id) {
      var editing = null;
      if (id) {
        for (var i4 = 0; i4 < sessState.phrases.length; i4++) {
          if (sessState.phrases[i4].id === id) { editing = sessState.phrases[i4]; break; }
        }
      }
      var mask = document.createElement('div');
      mask.className = 'wbs-panel-modal-mask';
      mask.id = 'wbs-qp-edit-modal';
      mask.innerHTML =
        '<div class="wbs-password-modal" role="dialog" aria-modal="true">' +
        '<div class="wbs-login-modal-title">' + (editing ? '编辑快捷短语' : '新增快捷短语') + '</div>' +
        '<label class="wbs-password-field"><textarea class="wbs-qp-textarea" id="wbs-qp-textarea" rows="5" placeholder="请输入快捷短语"></textarea></label>' +
        '<div class="wbs-password-error" id="wbs-qp-error" role="alert"></div>' +
        '<div class="wbs-modal-actions"><button class="wbs-modal-btn" type="button" id="wbs-qp-edit-cancel">取消</button>' +
        '<button class="wbs-modal-btn wbs-modal-ok" type="button" id="wbs-qp-edit-save">保存</button></div>' +
        '</div>';
      (panel || root).appendChild(mask);
      var ta = mask.querySelector('#wbs-qp-textarea');
      var err = mask.querySelector('#wbs-qp-error');
      if (editing) ta.value = editing.text;
      ta.focus();
      function closeQpEdit() { if (mask.parentNode) mask.parentNode.removeChild(mask); }
      mask.querySelector('#wbs-qp-edit-cancel').addEventListener('click', closeQpEdit);
      mask.addEventListener('click', function (ev) { if (ev.target === mask) closeQpEdit(); });
      mask.querySelector('#wbs-qp-edit-save').addEventListener('click', function () {
        var text = ta.value;
        if (!text.trim()) { err.textContent = '短语不能为空'; return; }
        var body = editing
          ? JSON.stringify({ id: editing.id, text: text })
          : JSON.stringify({ text: text });
        api(editing ? '/api/quick-phrase-update' : '/api/quick-phrase-add', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: body,
        }).then(function (d) {
          if (!d || !d.ok) throw new Error((d && d.error) || 'daemon 未确认');
          closeQpEdit();
          applySessionModule(d);
        }).catch(function (e5) { err.textContent = (e5.message || e5); });
      });
    }
    /** 删除二次确认弹窗（支持单选/批量） */
    function confirmQpDelete(ids) {
      var list = Array.isArray(ids) ? ids : [ids];
      if (!list.length) return;
      var mask = document.createElement('div');
      mask.className = 'wbs-modal-mask';
      mask.id = 'wbs-qp-del-modal';
      mask.innerHTML =
        '<div class="wbs-modal">' +
        '<div class="wbs-modal-title">删除快捷短语</div>' +
        '<div class="wbs-modal-body">确定删除' + (list.length > 1 ? '这 ' + list.length + ' 条' : '这条') + '快捷短语吗？删除后不可恢复。</div>' +
        '<div class="wbs-modal-actions"><button class="wbs-modal-btn" type="button" id="wbs-qp-del-cancel">取消</button>' +
        '<button class="wbs-modal-btn wbs-modal-ok" type="button" id="wbs-qp-del-ok">删除</button></div>' +
        '</div>';
      (panel || root).appendChild(mask);
      function closeQpDel() { if (mask.parentNode) mask.parentNode.removeChild(mask); }
      mask.querySelector('#wbs-qp-del-cancel').addEventListener('click', closeQpDel);
      mask.addEventListener('click', function (ev) { if (ev.target === mask) closeQpDel(); });
      mask.querySelector('#wbs-qp-del-ok').addEventListener('click', function () {
        api('/api/quick-phrase-delete', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ids: list }),
        }).then(function (d) {
          if (!d || !d.ok) throw new Error((d && d.error) || 'daemon 未确认');
          closeQpDel();
          if (sessState.qpBatch) { sessState.qpBatch = false; sessState.qpSel = {}; }
          applySessionModule(d);
        }).catch(function (e6) { toast('删除失败: ' + (e6.message || e6), true, root); closeQpDel(); });
      });
    }

    // 定位输入框操作栏（含 voice-mic-wrap 的父容器）
    function findActionRow() {
      var mic = document.querySelector('.voice-mic-wrap');
      if (mic) return mic.parentElement;
      // 新版布局（无 voice-mic-wrap）：从输入框向上找最近的含按钮容器（操作栏），
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
    // 新版输入框右下角按钮组路径：
    // ... > div.conversation-input > div.cr-theme > div.cr-theme.cr-input-box >
    //   div.cr-input-box__main > div.cr-input-container-wrapper > div.cr-input-container >
    //   div.cr-input-toolbar > div.cr-input-toolbar__right
    // cr-input-toolbar__right 即输入框右下角按钮组的父容器（上下文用量/增强/模型/发送）。
    // 新版布局：两个插件按钮（暂存提示词、快捷短语）内联插到该容器最左侧（其他按钮左边）。
    // 老布局兜底：..._input-area-container_ > ... > div._spaceBetween_._inputBottom_ > div._item_._gapLarge_
    //（_inputBottom_ 下有两个按钮组：左侧工具组 class 含 _selector_、右侧发送按钮组 class 含 _gapLarge_，
    //  必须命中右侧 _gapLarge_ 组，排除 _selector_ 组）
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
    // 新版或旧版内联工具栏存在时放进工具栏；带 voice-mic-wrap 的旧布局保持固定定位。
    function insertStash() {
      // 重新注入脚本时先移除旧版按钮（避免旧 SVG 图标/样式残留）
      var oldBtn = document.querySelector('.wbs-stash-inline');
      if (oldBtn && oldBtn !== stashBtn) oldBtn.remove();
      var oldExp = document.querySelector('.wbs-explore-inline');
      if (oldExp && oldExp !== exploreBtn) oldExp.remove();
      var mic0 = document.querySelector('.voice-mic-wrap');
      if (!mic0) {
        var toolbarMatch = WBS_COMPAT.findComposerToolbar(document);
        var row0 = toolbarMatch && toolbarMatch.element;
        if (row0) {
          stashBtn.classList.add('wbs-stash-inline-inline');
          exploreBtn.classList.add('wbs-stash-inline-inline');
          exploreBtn.style.right = 'auto';
          exploreBtn.style.top = 'auto';
          if (stashBtn.parentElement !== row0) row0.insertBefore(stashBtn, row0.firstChild);
          // 探索按钮贴暂存按钮右侧
          if (exploreBtn.parentElement !== row0) row0.insertBefore(exploreBtn, stashBtn.nextSibling);
        } else {
          // 容器暂不可用：回落到 body + fixed 定位
          stashBtn.classList.remove('wbs-stash-inline-inline');
          exploreBtn.classList.remove('wbs-stash-inline-inline');
          if (!stashBtn.parentElement) document.body.appendChild(stashBtn);
          if (!exploreBtn.parentElement) document.body.appendChild(exploreBtn);
          positionStash();
        }
        return;
      }
      if (!stashBtn.parentElement) document.body.appendChild(stashBtn);
      if (!exploreBtn.parentElement) document.body.appendChild(exploreBtn);
      positionStash();
    }
    // 探索菜单按钮：位于暂存提示词按钮右侧（与暂存同款圆钮、发送图标，hover 悬浮菜单弹窗）
    function positionExplore() {
      var wr = parseFloat(stashBtn.style.right || '');
      if (!isFinite(wr)) return;
      exploreBtn.style.right = (wr - 38) + 'px'; // 32=按钮宽，6=gutter（贴暂存按钮右侧）
      exploreBtn.style.top = stashBtn.style.top || '0px';
    }
    // 跟随主题设置按钮颜色（放弃跟随官方按钮）：浅色主题=黑底白图标；深色/WorkDaddy 主题=白底黑图标
    var acThemeObserver = null;
    function acIsDarkTheme() {
      try {
        var de = document.documentElement;
        if (de.classList && de.classList.contains('cb-dark')) return true;
        if (de.getAttribute && de.getAttribute('data-theme') === 'dark') return true;
        var bd = document.body;
        if (bd && bd.getAttribute('data-vscode-theme-name') && /dark/i.test(bd.getAttribute('data-vscode-theme-name') || '')) return true;
        return false;
      } catch (e) { return false; }
    }
    function applyThemeButtonColors() {
      try {
        var useWhite = acIsDarkTheme(); // 深色主题 → 白底；浅色 → 黑底
        var bg = useWhite ? '#ffffff' : '#111111';
        var fg = useWhite ? '#111111' : '#ffffff';
        stashBtn.style.background = bg;
        stashBtn.style.color = fg;
        exploreBtn.style.background = bg;
        exploreBtn.style.color = fg;
      } catch (e) {}
    }
    function watchThemeForButtons() {
      if (acThemeObserver || typeof MutationObserver === 'undefined') return;
      try {
        acThemeObserver = new MutationObserver(function () { applyThemeButtonColors(); });
        acThemeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
      } catch (e) {}
    }
    function positionStash() {
      // 新版布局没有 voice-mic-wrap：操作栏按钮行位于输入框正下方（与输入框同祖先容器）。
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
        positionExplore();
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
      positionExplore();
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
        // 欢迎页强制隐藏
        if (isWelcomePage()) { stashBtn.style.display = 'none'; exploreBtn.style.display = 'none'; return; }
        // 探索按钮常驻（若「快捷短语」开关开着）：不等输入框有内容，只要定位到操作栏就常显
        insertStash();
        exploreBtn.style.display = sessState.phrase ? 'flex' : 'none';
        applyThemeButtonColors(); // 主题色按钮（浅色黑底白图 / 深色白底黑图）
        renderExploreOptions(); // 面板选项 = 快捷短语列表（增删改后同步刷新）
        // 暂存按钮：仍按输入框是否有内容显隐，且「暂存提示词」开关需开着
        if (shouldShowStash() && sessState.stash) {
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

    // 会话消息导航：完整索引来自 controller.messageStore，DOM 仅用于判断当前可见位置。
    function createMessageNavigation() {
      var surface = null;
      var adapter = null;
      var messageStore = null;
      var unsubscribeStore = null;
      var root = null;
      var rail = null;
      var tooltip = null;
      var turns = [];
      var buttons = Object.create(null);
      var activeId = null;
      var resizeObserver = null;
      var scrollElement = null;
      var syncTimer = null;
      var tooltipTimer = null;
      var activeFrame = null;
      var dragPointerId = null;
      var dragLastIndex = -1;
      var suppressPointerClick = false;
      var suppressClickTimer = null;
      var renderedSignature = '';
      var lastMessages = null;
      var lastVersion = null;
      var hidden = true;
      var disposed = false;

      function messageText(message, limit) {
        var content = message && message.content;
        var blocks = Array.isArray(content) ? content : [];
        var parts = [];
        for (var i = 0; i < blocks.length; i++) {
          var block = blocks[i];
          var type = String(block && block.type || '').toLowerCase();
          if (type !== 'text' && type !== 'markdown') continue;
          var text = block && (block.text != null ? block.text : block.content);
          if (typeof text === 'string' && text) parts.push(text);
        }
        var value = parts.join(' ');
        value = value.replace(/\s+/g, ' ').trim();
        if (limit && value.length > limit) return value.slice(0, limit - 1) + '…';
        return value;
      }

      function ensureRoot() {
        if (root && root.isConnected) return;
        root = document.createElement('div');
        root.className = 'wbs-message-nav-root';
        renderedSignature = '';
        root.setAttribute('aria-label', '会话消息导航');
        rail = el('div', 'wbs-message-nav-rail');
        rail.setAttribute('role', 'navigation');
        rail.setAttribute('aria-label', '会话消息索引');
        tooltip = document.createElement('div');
        tooltip.className = 'wbs-message-nav-tooltip';
        tooltip.id = 'wbs-message-nav-tooltip';
        tooltip.setAttribute('role', 'tooltip');
        tooltip.hidden = true;
        root.appendChild(rail);
        root.appendChild(tooltip);
        document.body.appendChild(root);
        listen(root, 'pointerover', onPointerOver);
        listen(root, 'pointerout', onPointerOut);
        listen(root, 'focusin', onFocusIn);
        listen(root, 'focusout', onFocusOut);
        listen(root, 'click', onClick);
        listen(root, 'keydown', onKeyDown);
        listen(root, 'pointerdown', onNavPointerDown);
        listen(root, 'pointermove', onNavPointerMove);
        listen(root, 'pointerup', onNavPointerUp);
        listen(root, 'pointercancel', onNavPointerCancel);
        listen(root, 'lostpointercapture', onNavPointerCancel);
      }

      function position() {
        if (!root || !surface || !surface.scrollElement || hidden) return;
        var rect = surface.scrollElement.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) {
          root.style.display = 'none';
          return;
        }
        root.style.display = 'block';
        var railChrome = 14;
        var desiredRailHeight = Math.max(36, turns.length * 12 + railChrome);
        var railHeight = Math.min(desiredRailHeight, rect.height);
        var markerHeight = Math.max(1, Math.min(12,
          (railHeight - Math.min(railChrome, railHeight)) / Math.max(1, turns.length)));
        root.style.height = railHeight + 'px';
        root.style.top = (rect.top + (rect.height - railHeight) / 2) + 'px';
        var left = rect.left + 12;
        root.style.left = Math.max(8, Math.min(window.innerWidth - 28, left)) + 'px';
        root.style.setProperty('--wbs-message-nav-marker-height', markerHeight + 'px');
        root.style.setProperty('--wbs-message-nav-tooltip-max', Math.max(160, Math.min(320, window.innerWidth * 0.32)) + 'px');
      }

      function setActive(id) {
        activeId = id || null;
        Object.keys(buttons).forEach(function (key) {
          var button = buttons[key];
          if (!button) return;
          if (key === activeId) button.setAttribute('aria-current', 'true');
          else button.removeAttribute('aria-current');
          button.classList.toggle('is-active', key === activeId);
        });
      }

      function hideTooltip(immediate) {
        if (tooltipTimer) { clearTimeout(tooltipTimer); tooltipTimer = null; }
        var close = function () {
          if (!tooltip) return;
          tooltip.hidden = true;
          tooltip.classList.remove('is-visible');
        };
        if (immediate) close();
        else tooltipTimer = setBuildTimeout(close, 90);
      }

      function showTooltip(turn, button) {
        if (!tooltip || !turn || !button) return;
        if (tooltipTimer) { clearTimeout(tooltipTimer); tooltipTimer = null; }
        tooltip.textContent = '';
        var prompt = el('div', 'wbs-message-nav-prompt', messageText(turn.userMessage, 240) || '用户消息');
        tooltip.appendChild(prompt);
        var response = messageText(turn.assistantMessage, 320);
        if (response) tooltip.appendChild(el('div', 'wbs-message-nav-response', response));
        tooltip.hidden = false;
        tooltip.classList.add('is-visible');
        var buttonRect = button.getBoundingClientRect();
        var rootRect = root.getBoundingClientRect();
        var leftSpace = Math.max(0, rootRect.left - 12);
        var rightSpace = Math.max(0, window.innerWidth - rootRect.right - 12);
        var side = rightSpace >= leftSpace ? 'right' : 'left';
        var available = side === 'right' ? rightSpace : leftSpace;
        var preferred = Math.max(160, Math.min(320, window.innerWidth * 0.32));
        tooltip.style.width = Math.max(120, Math.min(preferred, available)) + 'px';
        var top = buttonRect.top - rootRect.top + buttonRect.height / 2;
        var tooltipHeight = tooltip.getBoundingClientRect().height || 80;
        tooltip.style.top = Math.max(tooltipHeight / 2, Math.min(rootRect.height - tooltipHeight / 2, top)) + 'px';
        tooltip.classList.toggle('is-left', side === 'left');
        tooltip.classList.toggle('is-right', side === 'right');
      }

      function render() {
        if (!rail) return;
        rail.textContent = '';
        buttons = Object.create(null);
        for (var i = 0; i < turns.length; i++) {
          var turn = turns[i];
          var button = el('button', 'wbs-message-nav-marker');
          button.type = 'button';
          button.setAttribute('data-wbs-message-nav-id', turn.id);
          button.setAttribute('aria-label', '定位到第 ' + (i + 1) + ' 条用户消息');
          button.setAttribute('aria-describedby', tooltip.id);
          button.appendChild(el('span', 'wbs-message-nav-dot'));
          rail.appendChild(button);
          buttons[turn.id] = button;
        }
        setActive(activeId || (turns[0] && turns[0].id));
      }

      function updateActive() {
        if (!surface || !turns.length) return;
        var viewport = surface.viewportElement.getBoundingClientRect();
        var frames = surface.conversationElement.querySelectorAll('.cr-document__virtual-item[data-index]');
        var visibleMessageIndex = -1;
        var bestDistance = Infinity;
        for (var i = 0; i < frames.length; i++) {
          var rect = frames[i].getBoundingClientRect();
          if (!rect) continue;
          var distance = Math.abs(rect.top - viewport.top - 28);
          if (rect.top <= viewport.bottom + 20 && distance < bestDistance) {
            visibleMessageIndex = Number(frames[i].getAttribute('data-index'));
            bestDistance = distance;
          }
        }
        var best = turns[0];
        for (var ti = 0; ti < turns.length; ti++) {
          if (turns[ti].messageIndex <= visibleMessageIndex) best = turns[ti];
          else break;
        }
        setActive(best && best.id);
      }

      function scheduleActive() {
        if (activeFrame != null) return;
        activeFrame = requestAnimationFrame(function () {
          activeFrame = null;
          updateActive();
        });
      }

      function refreshFromStore(state) {
        if (!sessState.messageNav || !messageStore || disposed) return;
        var messageState = state && Array.isArray(state.messages) ? state : messageStore.getState();
        if (!messageState || !Array.isArray(messageState.messages)) return;
        if (messageState.messages === lastMessages && messageState.version === lastVersion) return;
        lastMessages = messageState.messages;
        lastVersion = messageState.version;
        turns = WBS_COMPAT.collectMessageNavigationTurnsFromMessages(messageState.messages);
        hidden = turns.length <= 1;
        ensureRoot();
        if (hidden) {
          root.style.display = 'none';
          hideTooltip(true);
          return;
        }
        var signature = turns.map(function (turn) { return turn.id; }).join('\u001f');
        if (signature !== renderedSignature) {
          renderedSignature = signature;
          render();
        }
        position();
        scheduleActive();
      }

      function unbindStore() {
        if (unsubscribeStore) {
          try { unsubscribeStore(); } catch (_) {}
        }
        unsubscribeStore = null;
        messageStore = null;
        adapter = null;
        lastMessages = null;
        lastVersion = null;
        turns = [];
        renderedSignature = '';
      }

      function bindAdapter(nextAdapter) {
        var nextStore = nextAdapter && nextAdapter.messageStore;
        if (adapter && nextAdapter && messageStore === nextStore &&
            adapter.controller === nextAdapter.controller &&
            adapter.navigationHandle === nextAdapter.navigationHandle) return;
        unbindStore();
        adapter = nextAdapter;
        messageStore = nextStore || null;
        if (!messageStore) return;
        unsubscribeStore = messageStore.subscribe(function (state, previousState) {
          if (previousState && state && state.messages === previousState.messages &&
              state.version === previousState.version) return;
          refreshFromStore(state);
        });
        refreshFromStore(messageStore.getState());
      }

      function sync() {
        if (disposed || !sessState.messageNav) return;
        if (syncTimer) return;
        syncTimer = setBuildTimeout(function () {
          syncTimer = null;
          if (!sessState.messageNav) return;
          var nextSurface = WBS_COMPAT.findMessageNavigationSurface(document);
          if (!nextSurface) {
            hidden = true;
            surface = null;
            if (root) root.style.display = 'none';
            if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
            if (scrollElement) { scrollElement.removeEventListener('scroll', scheduleActive); scrollElement = null; }
            unbindStore();
            return;
          }
          var conversationChanged = nextSurface.conversationElement !== (surface && surface.conversationElement);
          var scrollChanged = nextSurface.scrollElement !== (surface && surface.scrollElement);
          surface = nextSurface;
          var currentConversationId = surface.conversationElement.getAttribute &&
            surface.conversationElement.getAttribute('data-root-id');
          var boundConversationId = adapter && adapter.controller && adapter.controller.conversationId;
          if (conversationChanged || scrollChanged || !adapter ||
              (currentConversationId && String(currentConversationId) !== String(boundConversationId || ''))) {
            bindAdapter(WBS_COMPAT.findMessageNavigationAdapter(document, surface));
          }
          if (!adapter) {
            hidden = true;
            if (root) root.style.display = 'none';
            return;
          }
          position();
          scheduleActive();
          if ((conversationChanged || scrollChanged) && resizeObserver) {
            resizeObserver.disconnect();
            resizeObserver = null;
          }
          if (typeof ResizeObserver !== 'undefined' && !resizeObserver) {
            resizeObserver = new ResizeObserver(position);
            resizeObserver.observe(surface.scrollElement);
          }
          if (scrollElement !== surface.scrollElement) {
            if (scrollElement) scrollElement.removeEventListener('scroll', scheduleActive);
            scrollElement = surface.scrollElement;
            if (scrollElement) scrollElement.addEventListener('scroll', scheduleActive, { passive: true });
          }
        }, 40);
      }

      function setEnabled(enabled) {
        if (enabled) {
          sync();
          return;
        }
        if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
        if (dragPointerId != null) finishNavDrag({ pointerId: dragPointerId }, true);
        hidden = true;
        hideTooltip(true);
        if (root) root.style.display = 'none';
        if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
        if (scrollElement) { scrollElement.removeEventListener('scroll', scheduleActive); scrollElement = null; }
        unbindStore();
      }

      function turnForButton(button) {
        var id = button && button.getAttribute('data-wbs-message-nav-id');
        for (var i = 0; i < turns.length; i++) if (turns[i].id === id) return turns[i];
        return null;
      }
      function navigateToTurn(turn, preview) {
        if (!turn || !adapter || !adapter.navigationHandle) return false;
        try {
          adapter.navigationHandle.scrollToMessage(turn.messageId, { behavior: 'auto', block: 'start' });
        } catch (_) { return false; }
        setActive(turn.id);
        var button = buttons[turn.id];
        if (preview && button) showTooltip(turn, button);
        else hideTooltip(true);
        return true;
      }
      function dragIndexAt(clientY) {
        if (!rail || !turns.length || !rail.firstElementChild || !rail.lastElementChild) return -1;
        var firstRect = rail.firstElementChild.getBoundingClientRect();
        var lastRect = rail.lastElementChild.getBoundingClientRect();
        var firstCenter = firstRect.top + firstRect.height / 2;
        var lastCenter = lastRect.top + lastRect.height / 2;
        if (lastCenter <= firstCenter) return 0;
        var ratio = (clientY - firstCenter) / (lastCenter - firstCenter);
        ratio = Math.max(0, Math.min(1, ratio));
        return Math.round(ratio * (turns.length - 1));
      }
      function onNavPointerDown(event) {
        if (dragPointerId != null || event.button !== 0) return;
        var button = event.target && event.target.closest ? event.target.closest('.wbs-message-nav-marker') : null;
        var turn = turnForButton(button);
        if (!button || !turn) return;
        dragPointerId = event.pointerId;
        dragLastIndex = Array.prototype.indexOf.call(rail.children, button);
        root.classList.add('is-dragging');
        try { rail.setPointerCapture(event.pointerId); } catch (_) {}
        navigateToTurn(turn, true);
        event.preventDefault();
      }
      function onNavPointerMove(event) {
        if (dragPointerId == null || event.pointerId !== dragPointerId) return;
        var nextIndex = dragIndexAt(event.clientY);
        if (nextIndex < 0 || nextIndex === dragLastIndex) return;
        dragLastIndex = nextIndex;
        navigateToTurn(turns[nextIndex], true);
        event.preventDefault();
      }
      function finishNavDrag(event, cancelled) {
        if (dragPointerId == null || (event.pointerId != null && event.pointerId !== dragPointerId)) return;
        var pointerId = dragPointerId;
        dragPointerId = null;
        dragLastIndex = -1;
        if (root) root.classList.remove('is-dragging');
        try {
          if (rail && rail.hasPointerCapture(pointerId)) rail.releasePointerCapture(pointerId);
        } catch (_) {}
        if (cancelled) {
          suppressPointerClick = false;
          hideTooltip(true);
          return;
        }
        suppressPointerClick = true;
        if (suppressClickTimer) clearTimeout(suppressClickTimer);
        suppressClickTimer = setBuildTimeout(function () {
          suppressPointerClick = false;
          suppressClickTimer = null;
        }, 400);
        hideTooltip(false);
      }
      function onNavPointerUp(event) { finishNavDrag(event, false); }
      function onNavPointerCancel(event) { finishNavDrag(event, true); }
      function onPointerOver(event) {
        if (dragPointerId != null) return;
        var button = event.target && event.target.closest ? event.target.closest('.wbs-message-nav-marker') : null;
        if (button) showTooltip(turnForButton(button), button);
      }
      function onPointerOut(event) {
        if (dragPointerId != null) return;
        var from = event.target && event.target.closest ? event.target.closest('.wbs-message-nav-marker') : null;
        var to = event.relatedTarget && event.relatedTarget.closest ? event.relatedTarget.closest('.wbs-message-nav-marker') : null;
        if (from && from !== to) hideTooltip(false);
      }
      function onFocusIn(event) {
        var button = event.target && event.target.closest ? event.target.closest('.wbs-message-nav-marker') : null;
        if (button) showTooltip(turnForButton(button), button);
      }
      function onFocusOut(event) {
        if (dragPointerId != null) return;
        if (!event.relatedTarget || !root.contains(event.relatedTarget)) hideTooltip(false);
      }
      function onClick(event) {
        if (suppressPointerClick && event.detail !== 0) {
          suppressPointerClick = false;
          if (suppressClickTimer) { clearTimeout(suppressClickTimer); suppressClickTimer = null; }
          event.preventDefault();
          return;
        }
        var button = event.target && event.target.closest ? event.target.closest('.wbs-message-nav-marker') : null;
        var turn = turnForButton(button);
        if (!button || !turn) return;
        navigateToTurn(turn, false);
      }
      function onKeyDown(event) {
        if (event.key === 'Escape') { hideTooltip(true); return; }
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        var current = event.target && event.target.closest ? event.target.closest('.wbs-message-nav-marker') : null;
        if (!current) return;
        var index = Array.prototype.indexOf.call(rail.children, current);
        var next = event.key === 'ArrowDown' ? index + 1 : index - 1;
        if (next >= 0 && next < rail.children.length) { event.preventDefault(); rail.children[next].focus(); }
      }
      function onWindowChange() { position(); scheduleActive(); }

      listen(window, 'resize', onWindowChange);
      listen(window, 'scroll', onWindowChange, true);
      sync();
      registerDisposer(function () {
        disposed = true;
        if (syncTimer) clearTimeout(syncTimer);
        if (tooltipTimer) clearTimeout(tooltipTimer);
        if (suppressClickTimer) clearTimeout(suppressClickTimer);
        if (activeFrame != null) cancelAnimationFrame(activeFrame);
        if (resizeObserver) resizeObserver.disconnect();
        if (scrollElement) scrollElement.removeEventListener('scroll', scheduleActive);
        unbindStore();
        if (root) root.remove();
      });
      return { sync: sync, setEnabled: setEnabled };
    }
    var messageNavigation = createMessageNavigation();
    function onDomChange() {
      if (!alive) return;
      guardSessionChange();
      if (messageNavigation) messageNavigation.sync();
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
    // 暂存项暂停守护：600ms 周期轮询，保证暂存提示词绝不被自动发送（见 guardStashedPause 注释）
    setBuildInterval(guardStashedPause, 600);
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

    // ===== 悬浮按钮位置：拖动时可在窗口内移动，释放后水平吸附右边 =====
    var fabPosPending = false;
    var fabDrag = null;
    var fabDragMoved = false;
    var fabDragSuppressClick = false;
    var fabSnapTimer = null;
    var FAB_DRAG_THRESHOLD = 6;
    var FAB_EDGE_GAP = 22;
    var FAB_POSITION_KEY = 'wbs-fab-bottom-' + PROFILE_ID;

    function readFabBottom() {
      try {
        var value = Number(localStorage.getItem(FAB_POSITION_KEY));
        return isFinite(value) ? value : null;
      } catch (_) { return null; }
    }

    function clampFabBottom(bottom, height) {
      var max = Math.max(FAB_EDGE_GAP, window.innerHeight - height - FAB_EDGE_GAP);
      return Math.max(FAB_EDGE_GAP, Math.min(max, Number(bottom) || FAB_EDGE_GAP));
    }

    function clampFabRight(right, width) {
      var max = Math.max(FAB_EDGE_GAP, window.innerWidth - width - FAB_EDGE_GAP);
      return Math.max(FAB_EDGE_GAP, Math.min(max, Number(right) || FAB_EDGE_GAP));
    }

    function applyFabPosition(fab, right, bottom) {
      if (!fab) return;
      var rect = fab.getBoundingClientRect();
      var nextRight = clampFabRight(right, rect.width || 52);
      var nextBottom = clampFabBottom(bottom, rect.height || 32);
      fab.style.position = 'fixed';
      fab.style.left = 'auto';
      fab.style.top = 'auto';
      fab.style.right = nextRight + 'px';
      fab.style.bottom = nextBottom + 'px';
      return { right: nextRight, bottom: nextBottom };
    }

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
      if (fabDrag) return;
      var saved = readFabBottom();
      applyFabPosition(fab, FAB_EDGE_GAP, saved == null ? FAB_EDGE_GAP : saved);
    }
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
    // 布局代际差异：
    //  - 旧版布局：队列方法直接挂在 props 的 adapter 对象上，
    //    从 voice-mic-wrap/_cbChat_/chat-container 等旧根向上走 fiber。
    //  - 新版布局：官方队列包装方法位于 props.adapter 的原型链，
    //    内部负责 _notifyQueueUpdate 刷新官方队列面板；adapter.sessionsResource 只是底层透传，不能使用。
    //    新布局已无 voice-mic-wrap/_cbChat_/chat-container 旧根 → 用 DFS 全树找 adapter，
    //    包一层与旧接口同名的适配层；会话 id 优先 adapter 字段，再按新版/旧版 DOM 查找。
    var modernOptimisticQueueIds = {};
    function syncModernQueueSnapshot(sessionId, snapshot) {
      if (!WBS_COMPAT.isModernQueueAdapter(window.__wbsAdapter) || !sessionId || !snapshot ||
          (!Array.isArray(snapshot.items) && !snapshot.__wbsOptimistic)) return false;
      try {
        // 新版队列组件订阅 ConversationController.promptQueue store，
        // 不直接订阅 adapter._notifyQueueUpdate。把官方 RPC 返回的真实快照同步给当前会话 store。
        var roots = [
          document.querySelector('.cr-document[data-root-id="' + String(sessionId).replace(/"/g, '\\"') + '"]'),
          document.querySelector('.conversation-shell'),
          document.querySelector('#root > div'),
        ];
        for (var ri = 0; ri < roots.length; ri++) {
          var el = roots[ri];
          if (!el) continue;
          for (var key in el) {
            if (key.indexOf('__reactFiber$') !== 0 && key.indexOf('__reactInternalInstance') !== 0) continue;
            var cur = el[key], seen = 0;
            while (cur && seen++ < 500) {
              var props = cur.memoizedProps;
              var controller = props && props.value;
              if (controller && controller.conversationId === sessionId && controller.promptQueue &&
                  controller.promptQueue.interactionStore &&
                  typeof controller.promptQueue.interactionStore.getState === 'function' &&
                  typeof controller.promptQueue.emitQueueUpdate === 'function') {
                var manager = controller.lifecycle && controller.lifecycle.conv && controller.lifecycle.conv.queueManager;
                var store = controller.promptQueue.interactionStore.getState();
                var currentItems = store && (store.promptQueue || store.items);
                var queueItems = Array.isArray(snapshot.items) ? snapshot.items : null;
                if (snapshot.__wbsOptimistic && Array.isArray(currentItems)) {
                  var optimistic = {
                    id: 'wbs-pending-' + Date.now() + '-' + Math.random().toString(16).slice(2),
                    conversationId: sessionId,
                    contentBlocks: snapshot.__wbsOptimistic.slice(),
                    status: 'pending',
                    order: currentItems.length ? Math.max.apply(null, currentItems.map(function (item) { return Number(item && item.order) || 0; })) + 1 : 0,
                    previewText: normalizeQueueText(snapshot.__wbsOptimistic),
                    __wbsOptimistic: true,
                  };
                  modernOptimisticQueueIds[sessionId] = String(optimistic.id);
                  queueItems = currentItems.concat([optimistic]);
                }
                if (!Array.isArray(queueItems)) return false;
                // 新版 5.4 在 RPC 尚未完成/重连时可能返回不带 runtime/version 的空快照。
                // 这不是“队列已清空”的确认，必须在更新 store 或 manager 镜像前直接丢弃。
                if (queueItems.length === 0 && Array.isArray(currentItems) && currentItems.length > 0 &&
                    snapshot.runtime == null && snapshot.version == null && snapshot.updatedAt == null) {
                  return false;
                }
                if (manager && typeof manager.items === 'function') {
                  // 新版按钮操作走 queueManager.delete/sendNow/move，完成后再由 syncFromConversation()
                  // 读取 manager.items()。只写 promptQueue store 会导致按钮操作后被空的 manager 缓存冲回去，
                  // 因此为当前会话维护与官方 RPC snapshot 一致的镜像，并保留原生 RPC 操作。
                  if (manager.__wbsQueueMirrorInstalled !== 2) {
                    // ConversationController 会跨脚本重注入存活；用版本号而不是布尔标记，
                    // 发现旧桥接时强制覆盖，避免继续执行上一版失效的 queueManager 方法。
                    Object.defineProperty(manager, '__wbsQueueMirrorInstalled', { value: 2, configurable: true });
                    Object.defineProperty(manager, '__wbsQueueMirrorItems', { value: [], writable: true, configurable: true });
                    Object.defineProperty(manager, '__wbsQueueOriginalItems', { value: manager.items, configurable: true });
                    manager.items = function () { return manager.__wbsQueueMirrorItems.slice(); };
                    manager.delete = function (itemId) {
                      var adapter = window.__wbsAdapter;
                      if (!adapter || typeof adapter.removeConversationMessageQueueItem !== 'function') {
                        return Promise.reject(new Error('WorkBuddy 队列删除接口不可用'));
                      }
                      return Promise.resolve(adapter.removeConversationMessageQueueItem(sessionId, itemId));
                    };
                    manager.sendNow = function (itemId) {
                      var adapter = window.__wbsAdapter;
                      if (!adapter || typeof adapter.sendConversationMessageQueueItemNow !== 'function') {
                        return Promise.reject(new Error('WorkBuddy 队列立即发送接口不可用'));
                      }
                      return Promise.resolve(adapter.sendConversationMessageQueueItemNow(sessionId, itemId));
                    };
                    manager.move = function (itemId, index) {
                      var adapter = window.__wbsAdapter;
                      var items = manager.__wbsQueueMirrorItems.slice();
                      var from = items.findIndex(function (item) { return item && String(item.id) === String(itemId); });
                      if (from < 0) return Promise.resolve();
                      var targetIndex = Math.max(0, Math.min(Number(index) || 0, items.length - 1));
                      var moved = items.splice(from, 1)[0];
                      items.splice(targetIndex, 0, moved);
                      var orderedIds = items.map(function (item) { return item && item.id; }).filter(Boolean);
                      if (!adapter || typeof adapter.reorderConversationMessageQueueItems !== 'function') {
                        return Promise.reject(new Error('WorkBuddy 队列排序接口不可用'));
                      }
                      return Promise.resolve(adapter.reorderConversationMessageQueueItems(sessionId, orderedIds));
                    };
                  }
                  manager.__wbsQueueMirrorItems = queueItems.slice();
                }
                if (store && typeof store.setPromptQueue === 'function') {
                  store.setPromptQueue(queueItems);
                  controller.promptQueue.emitQueueUpdate();
                  if (!snapshot.__wbsOptimistic) delete modernOptimisticQueueIds[sessionId];
                  return true;
                }
              }
              cur = cur.return;
            }
            break;
          }
        }
      } catch (e) {}
      return false;
    }

    function dropModernOptimisticItem(sessionId) {
      if (!sessionId || !modernOptimisticQueueIds[sessionId]) return Promise.resolve();
      var adapter = window.__wbsAdapter;
      if (!adapter || typeof adapter.getConversationMessageQueue !== 'function') return Promise.resolve();
      var id = modernOptimisticQueueIds[sessionId];
      return Promise.resolve(adapter.getConversationMessageQueue(sessionId)).then(function (snapshot) {
        if (snapshot && Array.isArray(snapshot.items)) {
          snapshot.items = snapshot.items.filter(function (item) { return String(item && item.id) !== String(id); });
          syncModernQueueSnapshot(sessionId, snapshot);
        }
        delete modernOptimisticQueueIds[sessionId];
      }).catch(function () { delete modernOptimisticQueueIds[sessionId]; });
    }

    function getModernQueueSnapshot(adapter, sessionId, preferred) {
      if (preferred && Array.isArray(preferred.items) &&
          (preferred.items.length > 0 || preferred.runtime != null || preferred.version != null || preferred.updatedAt != null)) {
        return Promise.resolve(preferred);
      }
      if (!adapter || typeof adapter.getConversationMessageQueue !== 'function') return Promise.resolve(preferred || null);
      try {
        return Promise.resolve(adapter.getConversationMessageQueue(sessionId)).then(function (fresh) {
          return fresh || preferred || null;
        });
      } catch (e) {
        return Promise.resolve(preferred || null);
      }
    }

    function findWbsAdapter() {
      // 缓存校验：adapter 的官方包装方法必须仍在（切账号/重挂载后旧实例可能失效，需重新查找）
      if (window.__wbsAdapter && typeof window.__wbsAdapter.enqueueConversationMessageQueueItem === 'function' &&
          typeof window.__wbsAdapter.pauseConversationMessageQueue === 'function') return window.__wbsAdapter;
      var found = WBS_COMPAT.findQueueAdapter(document);
      if (!found || !found.adapter) return null;
      if (found.kind !== 'modern') {
        window.__wbsAdapter = WBS_COMPAT.markQueueAdapter(found.adapter, found.kind);
        return window.__wbsAdapter;
      }

      // 新版顶层 adapter 的方法位于原型链，并负责通知官方队列面板。兼容层只负责发现，
      // 此处包装返回值，把真实 snapshot 同步到当前 ConversationController store。
      var target = found.adapter;
      var shim = {};
      ['enqueueConversationMessageQueueItem', 'pauseConversationMessageQueue', 'resumeConversationMessageQueue',
       'sendConversationMessageQueueItemNow', 'getConversationMessageQueue', 'getQueueState',
       'activateConversationMessageQueue', 'removeConversationMessageQueueItem',
       'reorderConversationMessageQueueItems'].forEach(function (m) {
        if (typeof target[m] === 'function') {
          shim[m] = function () {
            var args = Array.prototype.slice.call(arguments);
            var sessionId = args[0];
            var result = target[m].apply(target, args);
            return Promise.resolve(result).then(function (snapshot) {
              syncModernQueueSnapshot(sessionId, snapshot);
              return snapshot;
            });
          };
        }
      });
      // Composer content-block requests are handled by WorkBuddy's Slate owner.
      // Keep the original receiver so prototype methods retain their context.
      ['requestInsertContentBlocks', 'requestSendPrompt', 'onInsertContentBlocksRequest'].forEach(function (m) {
        if (typeof target[m] === 'function') {
          shim[m] = function () {
            return target[m].apply(target, arguments);
          };
        }
      });
      Object.defineProperty(shim, 'currentActiveSessionId', {
        enumerable: true,
        configurable: true,
        get: function () {
          try {
            return target.currentActiveSessionId || WBS_COMPAT.getSelectedConversationId(document) || null;
          } catch (e) {
            return null;
          }
        },
      });
      window.__wbsAdapter = WBS_COMPAT.markQueueAdapter(shim, 'modern');
      return window.__wbsAdapter;
    }
    function bootstrapModernQueueBridge() {
      try {
        var adapter = findWbsAdapter();
        if (!WBS_COMPAT.isModernQueueAdapter(adapter)) return;
        var sessionId = adapter && adapter.currentActiveSessionId;
        if (!sessionId || typeof adapter.getConversationMessageQueue !== 'function') return;
        Promise.resolve(adapter.getConversationMessageQueue(sessionId)).catch(function () {});
      } catch (e) {}
    }

    // 新版布局冷启动时 React adapter/当前会话可能还在挂载。首次点击不能把
    // 这类“暂不可用”误判成队列故障并写入旧版本地 stash，否则官方队列准备好后
    // 第二次点击会得到两条。这里异步等待官方 adapter + 当前会话，不阻塞渲染主线程。
    function waitForModernQueueAdapter(maxMs) {
      var startedAt = Date.now();
      var limit = Number(maxMs) > 0 ? Number(maxMs) : 10000;
      return new Promise(function (resolve, reject) {
        function probe() {
          if (!alive) return reject(new Error('注入组件已销毁'));
          try {
            var adapter = window.__wbsAdapter || findWbsAdapter();
            var sessionId = adapter && adapter.currentActiveSessionId;
            if (WBS_COMPAT.isModernQueueAdapter(adapter) && sessionId &&
                typeof adapter.enqueueConversationMessageQueueItem === 'function' &&
                typeof adapter.pauseConversationMessageQueue === 'function') {
              return resolve({ adapter: adapter, sessionId: sessionId });
            }
          } catch (_) {}
          if (Date.now() - startedAt >= limit) {
            var e = new Error('WorkBuddy 队列尚未准备完成');
            e.code = 'WBS_QUEUE_NOT_READY';
            return reject(e);
          }
          setBuildTimeout(probe, 100);
        }
        probe();
      });
    }

    // 后台预热只做只读查找，不触碰用户操作；点击路径随后直接复用缓存。
    function warmModernQueueAdapter() {
      if (!alive || window.__wbsAdapter) return;
      try { findWbsAdapter(); } catch (e) {}
    }
    setBuildTimeout(warmModernQueueAdapter, 0);
    setBuildTimeout(warmModernQueueAdapter, 120);
    setBuildTimeout(warmModernQueueAdapter, 500);
    setBuildTimeout(warmModernQueueAdapter, 1500);
    // ConversationController/queueManager 会跨重注入存活；注入后主动只读拉一次当前队列，
    // 立即安装或升级按钮桥接，不要求用户先再次点击“暂存提示词”。
    setBuildTimeout(bootstrapModernQueueBridge, 300);
    setBuildTimeout(bootstrapModernQueueBridge, 1200);
    function handleModernQueueActionClick(event) {
      if (!event || event.button > 0) return;
      var button = event.target && event.target.closest && event.target.closest('.cb-message-queue-item-actions button.icon-btn');
      if (!button) return;
      var cell = button.closest('.cb-message-queue-item');
      if (!cell) return;
      var itemId = cell.getAttribute('data-queue-item-id');
      // Real rows must stay owned by WorkBuddy's React callbacks: they use
      // inputApi.setBlocks() for edit and promptQueue.sendNow() for guided send.
      if (!itemId || itemId.indexOf('wbs-pending-') !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
    }
    listen(document, 'click', handleModernQueueActionClick, true);

    // 输入框内容在顶层 contentToBlocks 中转为可克隆的官方队列 blocks。
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
    // 通过官方 queue item id 记录；旧版无 id 时才保留完整文本精确匹配。
    var stashedBySession = {};
    var stashedIdsBySession = {};
    function stashSigs(sessionId) {
      if (!sessionId) return [];
      var arr = stashedBySession[sessionId];
      if (!arr) { arr = []; stashedBySession[sessionId] = arr; }
      return arr;
    }
    function stashIds(sessionId) {
      if (!sessionId) return [];
      var arr = stashedIdsBySession[sessionId];
      if (!arr) { arr = []; stashedIdsBySession[sessionId] = arr; }
      return arr;
    }
    function recordStashQueueItem(sessionId, blocks, snapshot) {
      // Ensure the session is included in the guard loop even when the queue
      // snapshot gives us an id and no legacy text signature is needed.
      stashSigs(sessionId);
      var ids = stashIds(sessionId);
      var wanted = normalizeQueueText(blocks);
      var items = snapshot && Array.isArray(snapshot.items) ? snapshot.items : [];
      var candidate = null;
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        if (!item || item.id == null || ids.indexOf(String(item.id)) >= 0) continue;
        if (wanted && normalizeQueueText(item.contentBlocks || item.blocks || item.content) === wanted) {
          if (!candidate || (Number(item.order || 0) > Number(candidate.order || 0))) candidate = item;
        }
      }
      if (candidate) {
        ids.push(String(candidate.id));
        return;
      }
      // Only use text fallback when the returned queue has no stable ids at all.
      // Recording a signature before RPC success would make a failed stash look
      // like a real stash and misclassify the user's next ordinary prompt.
      if (items.length && items.some(function (item) { return item && item.id != null; })) return;
      if (wanted) {
        var arr = stashSigs(sessionId);
        if (arr.indexOf(wanted) < 0) arr.push(wanted);
      }
    }
    // 判断一个 queue item 是否为「暂存提示词」消息（按文本签名匹配，仅当前会话）
    function isStashItem(sessionId, it) {
      var arr = stashSigs(sessionId), ids = stashIds(sessionId);
      if (!arr.length && !ids.length) return false;
      var domId = '';
      try {
        domId = it.getAttribute('data-queue-item-id') || it.getAttribute('data-item-id') || '';
      } catch (_) {}
      if (domId) return ids.indexOf(String(domId)) >= 0;
      var contentEl = it.querySelector('.content');
      var txt = (contentEl && (contentEl.getAttribute('title') || contentEl.textContent) || '').replace(/\s+/g, ' ').trim();
      if (!txt || ids.length) return false;
      return arr.some(function (s) { return normalizeQueueText(s) === txt; });
    }
    function syncQueueDomIds(sessionId, snapshot) {
      if (!snapshot || !Array.isArray(snapshot.items)) return;
      var domItems = document.querySelectorAll('.cb-message-queue-item');
      var byText = {};
      snapshot.items.forEach(function (item) {
        if (!item || item.id == null) return;
        var text = normalizeQueueText(item.contentBlocks || item.blocks || item.content);
        if (!text) return;
        if (!byText[text]) byText[text] = [];
        byText[text].push(item);
      });
      Object.keys(byText).forEach(function (text) {
        byText[text].sort(function (a, b) { return Number(a.order || 0) - Number(b.order || 0); });
      });
      var seen = {};
      Array.prototype.forEach.call(domItems, function (domItem) {
        var contentEl = domItem.querySelector('.content');
        var text = normalizeQueueText(contentEl && (contentEl.getAttribute('title') || contentEl.textContent) || '');
        var candidates = byText[text] || [];
        var index = seen[text] || 0;
        seen[text] = index + 1;
        var match = candidates[index];
        if (match && match.id != null) domItem.setAttribute('data-queue-item-id', String(match.id));
        else domItem.removeAttribute('data-queue-item-id');
      });
    }
    // 同步标签（仅当前会话的暂存签名）。只做幂等 DOM 插入/移除，不改 React 属性。
    function syncQueueTags() {
      var sessionId = (window.__wbsAdapter && window.__wbsAdapter.currentActiveSessionId);
      var arr = stashSigs(sessionId), ids = stashIds(sessionId);
      if (!alive || (!arr.length && !ids.length)) return;
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
    // 识别复用 stashedBySession/stashedIdsBySession；按会话独立守护，切换会话不影响其他会话的暂存项。
    var stashSendingSince = {}; // sid -> ts：该会话 sending 暂存项出现时间（判断是否空闲卡住）
    // 顺序合规判定：按 order 排序的 pending 项中，第一个不是暂存项（即普通项在最前）
    function stashOrderValid(items, sessionId) {
      var arr = stashSigs(sessionId), ids = stashIds(sessionId);
      if (!items || (!arr.length && !ids.length)) return true;
      var pendings = [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].status === 'pending') pendings.push(items[i]);
      }
      if (!pendings.length) return true;
      pendings.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
      return !isStashQueueItem(pendings[0], ids, arr);
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
          var arr = stashSigs(sid), ids = stashIds(sid);
          if (!arr.length && !ids.length) { delete stashedBySession[sid]; delete stashedIdsBySession[sid]; return; }
          var p;
          try { p = adapter.getConversationMessageQueue(sid); } catch (e) { return; }
          Promise.resolve(p).then(function (q) {
            if (!q || !q.items || !q.runtime) return;
            // The DOM belongs to the currently visible conversation. A guard
            // pass for a background session must never stamp its ids onto the
            // active session while the user is switching conversations.
            if (adapter.currentActiveSessionId === sid) {
              syncQueueDomIds(sid, q);
              syncQueueTags();
            }
            var hasStashPending = false;
            var hasStashSending = false;
            var hasNormalPending = false;
            var sendingItemId = null;
            for (var k = 0; k < q.items.length; k++) {
              var it = q.items[k];
              if (it.status === 'sending') {
                if (isStashQueueItem(it, ids, arr)) { hasStashSending = true; if (!sendingItemId) sendingItemId = it.id; }
                continue;
              }
              if (it.status !== 'pending') continue;
              if (isStashQueueItem(it, ids, arr)) hasStashPending = true;
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
              if (q.runtime.paused && stashOrderValid(q.items, sid)) {
                try { adapter.resumeConversationMessageQueue(sid); crumb('guard:auto-send-resume'); } catch (e) {}
              }
              if (hasStashPending) {
                enforceStashOrder(sid, q.items, arr);
              } else {
                // 普通项还在但已无本插件暂存项：交给官方正常调度，停止守护
                delete stashedBySession[sid];
                delete stashedIdsBySession[sid];
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
              delete stashedIdsBySession[sid];
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
    function enforceStashOrder(sessionId, items, arr) {
      var ids = stashIds(sessionId);
      if (!alive || !items || (!arr || !arr.length) && !ids.length) return;
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
        if (isStashQueueItem(sorted[i], ids, arr)) {
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
      crumb('order:reorder');
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
    // 新版输入组件将每个会话的草稿保存在 composer store，并持久化到
    // localStorage 的 cb-draft:<conversationId>。只清 Slate/DOM 会导致切回会话时旧草稿重新水合。
    // 这里沿当前 composer 的 fiber 向上找官方 store.api.clear()，仅接受 activeSessionId 与
    // 暂存会话完全一致的 store；持久化键删除是官方 store 更新未同步落盘时的窄兜底。
    function clearModernComposerDraft(ed, sessionId) {
      if (!WBS_COMPAT.hasModernQueueSurface(document) || !ed || !sessionId || !document.contains(ed)) return false;
      var node = ed;
      for (var up = 0; up < 20 && node; up++) {
        var fk = Object.keys(node).find(function (k) {
          return k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance') === 0;
        });
        if (fk) {
          var cur = node[fk], seen = 0;
          while (cur && seen < 120) {
            var p = cur.memoizedProps;
            var store = p && p.store;
            if (WBS_COMPAT.isComposerStore(store, sessionId)) {
              try { store.api.clear(); } catch (_) { return false; }
              try {
                var draftKey = WBS_COMPAT.draftStorageKey(sessionId);
                if (draftKey) localStorage.removeItem(draftKey);
              } catch (_) {}
              return true;
            }
            cur = cur.return; seen++;
          }
        }
        node = node.parentElement;
      }
      return false;
    }
    // 清空输入框：新版布局先清官方 composer store；旧版布局仍通过 React fiber
    // 找 Slate onChange。两端最后都用 DOM 编辑命令做显示同步兜底。
    // 【切会话守卫】入队 await 期间可能发生会话切换：此时 fiber 链可能已失效/指向旧会话，
    // 直接清 store/onChange 有渲染进程风险——一律跳过（输入框留着内容，用户可见可清）。
    function clearComposerViaOnChange(expectedContent) {
      try {
        var wbsA = window.__wbsAdapter;
        if (stashSessionAtClick && wbsA && wbsA.currentActiveSessionId &&
            wbsA.currentActiveSessionId !== stashSessionAtClick) return; // 会话已切换：跳过清空
        // The queue RPC is asynchronous. Never clear text that the user typed
        // after clicking stash while that RPC was in flight.
        if (expectedContent) {
          var currentContent = getComposerContent();
          if (!stashContentMatches(expectedContent, currentContent)) return;
        }
        var mic = document.querySelector('.voice-mic-wrap');
        var ed = null;
        if (mic) {
          var p0 = mic.parentElement;
          for (var up = 0; up < 6 && p0; up++) {
            var e = p0.querySelector('[contenteditable="true"]');
            if (e) { ed = e; break; }
            p0 = p0.parentElement;
          }
        } else {
          // 新版布局（无 voice-mic-wrap）：复用通用输入框定位（视口下半部可见的 contenteditable）
          ed = findComposer();
        }
        var modernDraftCleared = clearModernComposerDraft(ed, stashSessionAtClick);
        if (modernDraftCleared) return;
        var cleared = false;
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
                  cleared = true;
                  // DOM 兜底硬清：新版 Slate 输入框存在 value 与 DOM 脱节的场景
                  // （中文输入法 composition 未走通受控链 / 外部改 DOM），此时 React 认为
                  // value 已是空文档 → onChange 不产生 re-render → 文字残留输入框。
                  // execCommand('delete') 直接清 DOM 并触发 beforeinput，Slate 感知后同步，
                  // 与 onChange 在同一同步 tick 内执行，不会误删用户新输入。
                  try {
                    ed.focus();
                    var selC = window.getSelection();
                    var rangeC = document.createRange();
                    rangeC.selectNodeContents(ed);
                    selC.removeAllRanges(); selC.addRange(rangeC);
                    document.execCommand('delete');
                  } catch (eC) {}
                }
                return;
              }
              cur = cur.return; seen++;
            }
          }
          node = node.parentElement;
        }
        // 新版布局（无 mic）fiber 未命中回退：execCommand 全选删除（占位符一并清除，React/Slate 由 input 事件驱动更新），
        // 有内容才清（避免空输入也触发编辑命令），仍受 hadText 判断约束
        if (!cleared && !mic) {
          try {
            var hasTxt2 = (ed.innerText || '').replace(/[\uFEFF\u200B]/g, '').trim().length > 0;
            if (hasTxt2) {
              ed.focus();
              var sel2 = window.getSelection();
              var range2 = document.createRange();
              range2.selectNodeContents(ed);
              sel2.removeAllRanges();
              sel2.addRange(range2);
              document.execCommand('delete');
            }
          } catch (e2) {}
        }
      } catch (e) {}
    }
    // 队列操作超时包装：WorkBuddy 内部 Promise 可能永不 settle，超时后走本地暂存兜底，避免"卡死"
    function withQueueTimeout(promise, ms) {
      return new Promise(function (resolve, reject) {
        var done = false;
        var t = setBuildTimeout(function () {
          if (!done) {
            done = true;
            var timeoutError = new Error('WorkBuddy 队列响应超时（' + Math.round(ms / 1000) + 's）');
            timeoutError.code = 'WBS_QUEUE_TIMEOUT';
            reject(timeoutError);
          }
        }, ms);
        promise.then(function (r) { if (!done) { done = true; clearTimeout(t); resolve(r); } },
          function (e) { if (!done) { done = true; clearTimeout(t); reject(e); } });
      });
    }
    function enqueueToWorkBuddyQueue(content) {
      try {
        var blocks = contentToBlocks(content);
        if (!blocks.length) return Promise.reject(new Error('输入框内容为空'));
        var cachedAdapter = window.__wbsAdapter || findWbsAdapter();
        var modernQueue = WBS_COMPAT.isModernQueueAdapter(cachedAdapter) || WBS_COMPAT.hasModernQueueSurface(document);
        var ready = modernQueue
          ? waitForModernQueueAdapter(10000)
          : Promise.resolve({ adapter: cachedAdapter, sessionId: null });
        return ready.then(function (readyState) {
          var adapter = readyState && readyState.adapter;
          // 官方包装方法必须齐全：enqueueConversationMessageQueueItem（入队+刷新面板）/ pauseConversationMessageQueue（暂停自动发送+刷新面板）
          if (!adapter || typeof adapter.enqueueConversationMessageQueueItem !== 'function' ||
              typeof adapter.pauseConversationMessageQueue !== 'function') {
            throw new Error('未找到 WorkBuddy 队列接口');
          }
          var sessionId = readyState.sessionId || adapter.currentActiveSessionId;
          if (!sessionId) throw new Error('未获取到当前会话');
          // 记录本次实际入队使用的会话 id。等待冷启动就绪期间也不允许换会话后误清空输入。
          stashSessionAtClick = sessionId;
          var modernAdapter = WBS_COMPAT.isModernQueueAdapter(adapter);
          var enqueueSnapshot = null;
          // 关键事务顺序：先暂停，再入队。新版 5.4 的 dispatcher 会在 enqueue RPC
          // 返回前继续 activate()，旧的“先入队后暂停”会把已有普通项全部发送掉。
          var pauseWait = modernAdapter
            ? withQueueTimeout(adapter.pauseConversationMessageQueue(sessionId, 'manual'), 5000)
            : Promise.resolve(null);
          return pauseWait
            .then(function () { crumb('pause:ok'); })
            .catch(function () { crumb('pause:fail'); return null; })
            .then(function () {
              // 立即把暂存项镜像到新版官方队列 store，避免 RPC 冷启动时 UI 空等数秒。
              // 真实快照返回后会整体替换该临时项；临时项不参与任何官方操作。
              if (modernAdapter) {
                try { syncModernQueueSnapshot(sessionId, { __wbsOptimistic: blocks }); } catch (e) {}
              }
              var rawEnqueue = adapter.enqueueConversationMessageQueueItem(sessionId, blocks);
              return Promise.resolve(rawEnqueue).then(function (snapshot) {
                // 某些 5.4 时机返回 null/{items:[]}，立即重新读取当前会话，避免
                // 暂存 ID 丢失或旧空快照覆盖 UI。
                return getModernQueueSnapshot(adapter, sessionId, snapshot);
              });
            })
            .then(function (snapshot) {
              enqueueSnapshot = snapshot;
              recordStashQueueItem(sessionId, blocks, snapshot);
              crumb('enqueue:done');
              // 入队后立即执行一轮守护，保持暂存项暂停。
              try { guardStashedPause(); } catch (e) {}
              return { ok: true, blocks: blocks.length, sessionId: sessionId, snapshot: enqueueSnapshot };
            });
        });
      } catch (e) {
        // 同步异常防护：adapter/队列 API 任何同步抛错都不中断点击链，转 reject 走本地暂存兜底
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
    }

    var stashBusy = false;
    var stashBusyTimer = null;
    // 新版官方入队 Promise 可能晚于 UI 超时才 settle。保留同一内容的
    // in-flight 事务，后续重复点击只复用原事务，绝不再次调用 enqueue。
    var stashInFlight = null;
    var stashSessionAtClick = null; // 点击暂存时的会话 id：清空输入框的切会话守卫用
    function crumb(msg) {
      try { console.log('[wbscrum]', msg); } catch (e) {}
      try {
        fetch(API + '/api/breadcrumb', { method: 'POST', headers: { 'content-type': 'application/json', 'X-WorkDaddy-Token': WBS_API_TOKEN }, body: JSON.stringify({ msg: msg }) }).catch(function () {});
      } catch (e) {}
    }
    listen(stashBtn, 'click', function () {
      // 官方入队仍在处理中时，无论看门狗是否已恢复按钮外观，都不允许
      // 再发起第二次 enqueue；否则冷启动慢响应会把同一提示词写入两次。
      if (stashBusy || stashInFlight) return;
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
      var stashWork = enqueueToWorkBuddyQueue(content);
      stashInFlight = stashWork;
      stashWork
        .then(function (r) {
          clearComposerViaOnChange(content);
          syncStash(); // 输入框清空后隐藏暂存按钮
        })
        .catch(function (e) {
          var modernQueue = WBS_COMPAT.isModernQueueAdapter(window.__wbsAdapter) || WBS_COMPAT.hasModernQueueSurface(document);
          var optimisticCleanup = modernQueue ? dropModernOptimisticItem(stashSessionAtClick) : Promise.resolve();
          // A timeout is still retained for the legacy layout only. The modern layout does
          // not fall back after timeout: a late successful RPC must not be paired
          // with a local fallback item, which would create duplicate queue entries.
          if (e && e.code === 'WBS_QUEUE_TIMEOUT') {
            crumb('enqueue:timeout-no-fallback');
            return optimisticCleanup;
          }
          if (e && e.code === 'WBS_QUEUE_NOT_READY' && modernQueue) {
            crumb('enqueue:not-ready-no-fallback');
            return optimisticCleanup;
          }
          // 兜底：WorkBuddy 队列不可用时退回本地暂存
          var uidPromise = (state.current && state.current.uid)
            ? Promise.resolve(state.current.uid)
            : api('/api/current').then(function (c) { return (c && c.uid) || null; }).catch(function () { return null; });
          return optimisticCleanup.then(function () { return uidPromise; }).then(function (uid) {
            var convId = getConversationId();
            return api('/api/stash', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ uid: uid || null, conversationId: convId, content: content }),
            }).then(function () {
              // 已暂存到本地面板（WorkBuddy 队列不可用时兜底）：成功后同样清空输入框并刷新按钮显隐
              clearComposerViaOnChange(content);
              syncStash();
            });
          });
        })
        .catch(function (e) {
          // 暂存失败：静默（功能内部错误不影响输入框）
        })
        .finally(function () {
          clearTimeout(stashBusyTimer);
          stashBusy = false;
          stashInFlight = null;
          stashBtn.style.opacity = '';
          stashSessionAtClick = null;
        });
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
    var hiddenToolsUnlocked = false;
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
        '<button class="wbs-acct-io" type="button" data-act="export" title="选择账号并输入密码后导出备份">' + EXPORT_ICON + '<span>导出</span></button>' +
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

    function closeSecureTransferModal(mask) {
      if (mask && mask.parentNode) mask.parentNode.removeChild(mask);
    }

    function openSecureTransferModal(options) {
      options = options || {};
      closeSecureTransferModal(panel && panel.querySelector('#wbs-secure-transfer-modal'));
      var items = Array.isArray(options.items) ? options.items : [];
      var requirePassword = options.requirePassword !== false;
      var selected = {};
      var itemHtml = '';
      for (var i = 0; i < items.length; i++) {
        selected[String(items[i].id)] = true;
        itemHtml += '<label class="wbs-transfer-option selected">' +
          '<input type="checkbox" data-transfer-id="' + escAttr(items[i].id) + '" checked>' +
          '<span class="wbs-transfer-copy"><span class="wbs-transfer-title">' + esc(items[i].title || '') + '</span>' +
          (items[i].sub ? '<span class="wbs-transfer-sub">' + esc(items[i].sub) + '</span>' : '') + '</span></label>';
      }
      var mask = document.createElement('div');
      mask.className = 'wbs-modal-mask wbs-modal-mask-panel';
      mask.id = 'wbs-secure-transfer-modal';
      mask.innerHTML =
        '<div class="wbs-password-modal wbs-transfer-modal" role="dialog" aria-modal="true" aria-labelledby="wbs-transfer-title">' +
        '<div class="wbs-login-modal-title" id="wbs-transfer-title">' + esc(options.title || '安全传输') + '</div>' +
        (items.length ? '<div class="wbs-transfer-select-head"><span>' + esc(options.selectionLabel || '选择内容') + '</span>' +
          '<button class="wbs-transfer-toggle" type="button" id="wbs-transfer-toggle">取消全选</button></div>' +
          '<div class="wbs-transfer-list">' + itemHtml + '</div>' : '') +
        '<label class="wbs-password-field"><span>密码' + (requirePassword ? '' : '（旧版文件可留空）') + '</span>' +
        '<input id="wbs-transfer-password" type="password" autocomplete="new-password" placeholder="' + esc(options.passwordPlaceholder || '请输入密码') + '"></label>' +
        '<div class="wbs-password-hint">' + esc(options.hint || (requirePassword ? '密码不能为空，请妥善保管。' : '新版文件请输入密码。')) + '</div>' +
        '<div class="wbs-password-error" id="wbs-transfer-error" role="alert"></div>' +
        '<div class="wbs-modal-actions"><button class="wbs-modal-btn" type="button" id="wbs-transfer-cancel">取消</button>' +
        '<button class="wbs-modal-btn wbs-modal-ok" type="button" id="wbs-transfer-confirm">' + esc(options.confirmText || '确定') + '</button></div>' +
        '</div>';
      (panel || root).appendChild(mask);
      var input = mask.querySelector('#wbs-transfer-password');
      var error = mask.querySelector('#wbs-transfer-error');
      var confirm = mask.querySelector('#wbs-transfer-confirm');
      var close = function () { closeSecureTransferModal(mask); };
      function selectedIds() { return Object.keys(selected).filter(function (id) { return selected[id]; }); }
      function syncSelection() {
        var checks = mask.querySelectorAll('[data-transfer-id]');
        for (var c = 0; c < checks.length; c++) {
          var id = checks[c].getAttribute('data-transfer-id');
          checks[c].checked = !!selected[id];
          checks[c].closest('.wbs-transfer-option').classList.toggle('selected', !!selected[id]);
        }
        var toggle = mask.querySelector('#wbs-transfer-toggle');
        if (toggle) toggle.textContent = selectedIds().length === items.length ? '取消全选' : '全选';
      }
      var optionChecks = mask.querySelectorAll('[data-transfer-id]');
      for (var oi = 0; oi < optionChecks.length; oi++) {
        optionChecks[oi].addEventListener('change', function () {
          selected[this.getAttribute('data-transfer-id')] = !!this.checked;
          syncSelection();
        });
      }
      var toggle = mask.querySelector('#wbs-transfer-toggle');
      if (toggle) toggle.addEventListener('click', function () {
        var selectAll = selectedIds().length !== items.length;
        for (var t = 0; t < items.length; t++) selected[String(items[t].id)] = selectAll;
        syncSelection();
      });
      mask.querySelector('#wbs-transfer-cancel').addEventListener('click', close);
      mask.addEventListener('click', function (ev) { if (ev.target === mask) close(); });
      confirm.addEventListener('click', function () {
        var value = input.value;
        if (items.length && !selectedIds().length) {
          error.textContent = '请至少选择一项';
          return;
        }
        if (requirePassword && !value.trim()) {
          error.textContent = '密码不能为空';
          input.focus();
          return;
        }
        error.textContent = '';
        confirm.disabled = true;
        confirm.textContent = '处理中…';
        Promise.resolve().then(function () {
          return options.onConfirm(value, selectedIds());
        }).then(close).catch(function (err) {
          error.textContent = (err && err.message) || String(err || '操作失败');
          confirm.disabled = false;
          confirm.textContent = options.confirmText || '确定';
          input.focus();
        });
      });
      input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') confirm.click();
        if (ev.key === 'Escape') close();
      });
      setBuildTimeout(function () { input.focus(); }, 0);
    }

    function downloadTransfer(result, fallbackName) {
      var blob = new Blob([result.content], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = result.filename || fallbackName;
      document.body.appendChild(anchor);
      anchor.click();
      setTimeout(function () { document.body.removeChild(anchor); URL.revokeObjectURL(url); }, 300);
    }

    function readTransferFile(file) {
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () { resolve(String(reader.result || '')); };
        reader.onerror = function () { reject(new Error('读取文件失败')); };
        reader.readAsText(file);
      });
    }

    function copyPlainText(text) {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        return navigator.clipboard.writeText(String(text));
      }
      return new Promise(function (resolve, reject) {
        var textarea = document.createElement('textarea');
        textarea.value = String(text);
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        var copied = false;
        try { copied = document.execCommand('copy'); } catch (_) {}
        document.body.removeChild(textarea);
        if (copied) resolve(); else reject(new Error('复制失败'));
      });
    }

    // 导出账号：密码必填，daemon 使用随机 salt 加密后触发浏览器下载。
    function onExportAccounts() {
      var items = state.accounts.map(function (account) {
        return {
          id: account.uid,
          title: account.nickname || '未命名账号',
          sub: account.phone || account.uin || '',
        };
      });
      if (!items.length) { toast('没有可导出的账号备份', true, root); return; }
      openSecureTransferModal({
        title: '导出账号',
        selectionLabel: '选择账号',
        items: items,
        requirePassword: true,
        confirmText: '导出',
        hint: '所选账号将加密保存，密码不能为空，请妥善保管。',
        onConfirm: function (password, uids) { return api('/api/accounts/export', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: password, uids: uids }),
        }).then(function (r) {
            downloadTransfer(r, 'WorkDaddy-accounts.json');
            toast('已导出 ' + r.count + ' 个账号（已加密）', false, root);
          });
        },
      });
    }

    // 导入账号：读文件后输入密码；空密码仅对历史 workdaddy 格式有效。
    function onImportFile(ev) {
      var file = ev.target && ev.target.files && ev.target.files[0];
      ev.target.value = '';
      if (!file) return;
      readTransferFile(file).then(function (content) {
        openSecureTransferModal({
          title: '导入账号',
          requirePassword: false,
          passwordPlaceholder: '新版文件请输入密码',
          hint: '新版文件必须输入密码；旧版导出文件可留空。',
          confirmText: '导入',
          onConfirm: function (password) { return api('/api/accounts/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: content, password: password }),
          }).then(function (r) {
              toast('成功导入 ' + r.count + ' 个账号', false, root);
              refresh();
            });
          },
        });
      }).catch(function (e) { toast(e.message || '读取文件失败', true, root); });
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
    var sessionsState = { uid: undefined, currentUid: '', range: '7d', list: [], selected: {}, wsExpanded: {}, accounts: [], batchMode: false, autoCopy: null };
    function isTaskSessionRecordUI(s) {
      // 任务（未选择项目/一次性）会话：以官方 is_playground=1 为准。
      // 普通工作区也用 WorkBuddy\\YYYY-MM-DD-HH-MM-SS 命名，仅凭 cwd 无法区分。
      return !!(s && Number(s.is_playground) === 1);
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
        '<button class="wbs-sess-bbtn" type="button" id="wbs-sess-import" title="从加密文件导入会话">' + IMPORT_ICON + '<span>导入</span></button>' +
        '<span class="wbs-sess-count" id="wbs-sess-count"></span>' +
        '<div class="wbs-sess-batchbar" id="wbs-sess-batchbar" style="display:none">' +
        '<button class="wbs-sess-bbtn wbs-sess-check-all" type="button" id="wbs-sess-check-all">全选</button>' +
        '<span class="wbs-sess-batch-count" id="wbs-sess-batch-count">已选 0</span>' +
        '<button class="wbs-sess-bbtn" type="button" id="wbs-sess-copy" title="复制选中到其他账号"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><span>复制</span></button>' +
        '<button class="wbs-sess-bbtn" type="button" id="wbs-sess-export" title="使用密码导出选中会话">' + EXPORT_ICON + '<span>导出</span></button>' +
        '<button class="wbs-sess-bbtn wbs-sess-delbtn" type="button" id="wbs-sess-delete" title="删除选中"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg><span>删除</span></button>' +
        '<button class="wbs-sess-bbtn wbs-sess-done" type="button" id="wbs-sess-done">取消</button>' +
        '</div>' +
        '</div>' +
        '<input type="file" id="wbs-sess-import-file" accept=".json,application/json" style="display:none">' +
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
        sessionsState.currentUid = curUid;
        var curName = '当前账号';
        for (var i = 0; i < accts.length; i++) if (accts[i].uid === curUid) curName = accts[i].nickname || curName;
        var html = '<option value="">' + esc(curName) + '</option>';
        accts.forEach(function (a) {
          if (a.uid === curUid) return;
          html += '<option value="' + escAttr(a.uid) + '">' + esc(a.nickname || '账号' + a.uid.slice(0, 4)) + '</option>';
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
        // 任务会话（is_playground=1）保留在列表中，由渲染层归入「任务」分组展示与操作。
        sessionsState.list = ((d && d.sessions) || []);
        sessionsState.autoCopy = (d && d.autoCopy) || null;
        sessionsState.selected = {};
        sessionsState.wsExpanded = {};
        renderSessions();
        // 筛选变化后退出批量模式（勾选框隐藏 + 恢复工具栏右侧按钮）
        if (sessionsState.batchMode) {
          sessionsState.batchMode = false;
          setSessBatchBar(false);
        }
        updateSessCount();
      }).catch(function (e) {
        listEl.innerHTML = '<div class="wbs-empty">会话加载失败: ' + esc(e.message || e) + '</div>';
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
        if (isTaskSessionRecordUI(s)) { tasks.push(s); return; }
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
        var taskAllChecked = tasks.every(function (s) { return sessionsState.selected[s.id]; });
        html += '<div class="wbs-sess-group wbs-sess-tasks">' +
          '<div class="wbs-sess-group-head">' +
          (batch ? '<input type="checkbox" class="wbs-ws-check" data-ws="__TASKS__"' + (taskAllChecked ? ' checked' : '') + '>' : '') +
          '<span class="wbs-sess-group-name" title="未选择项目的一次性任务/临时会话"><span class="wbs-sess-group-type">任务</span></span>' +
          '<span class="wbs-sess-group-count">' + tasks.length + '</span>' +
          '</div>';
        taskVis.forEach(function (s) {
          var title = s.custom_title || s.title || '(无标题)';
          var sel = sessionsState.selected[s.id] ? ' checked' : '';
          var inherited = !!s.autoCopyWorkspace;
          var marked = !!s.autoCopySession || inherited;
          html += '<div class="wbs-sess-row">' +
            (batch ? '<input type="checkbox" class="wbs-sess-check" data-id="' + escAttr(s.id) + '"' + sel + '>' : '') +
            '<span class="wbs-sess-main"><span class="wbs-sess-title">' + esc(title) + '</span>' +
            '<span class="wbs-sess-meta">' + esc(fmtHumanTime(s.last_activity_at || s.updated_at || s.created_at)) + '</span></span>' +
            (batch ? '' : autoCopyButton('session', s.id, s.user_id, marked, inherited)) +
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
            '<span class="wbs-sess-meta">' + esc(fmtHumanTime(s.last_activity_at || s.updated_at || s.created_at)) + '</span></span>' +
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
        return !!s.autoCopySession || !!s.autoCopyWorkspace;
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
            if (w === '__TASKS__') return isTaskSessionRecordUI(s);
            return String(s.user_id || sessionsState.uid || '') + '::' + (s.cwd || '(未指定空间)') === w;
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
      var n = sessionsState.list.filter(function (s) { return sessionsState.selected[s.id]; }).length;
      var countEl = sessionsPane.querySelector('#wbs-sess-count');
      updateSessionSummary(countEl);
      // 批量模式下「已选 N」显示在批量操作行内（模型页同款排版）
      var bc = sessionsPane.querySelector('#wbs-sess-batch-count');
      if (bc) bc.textContent = '已选 ' + n;
      // 未选中会话时隐藏「复制/删除」按钮（仅批量模式可见）
      var cp = sessionsPane.querySelector('#wbs-sess-copy');
      var ex = sessionsPane.querySelector('#wbs-sess-export');
      var dl = sessionsPane.querySelector('#wbs-sess-delete');
      if (cp) cp.style.display = n ? '' : 'none';
      if (ex) ex.style.display = n ? '' : 'none';
      if (dl) dl.style.display = n ? '' : 'none';
      syncCheckAllBtn();
    }
    // 全选按钮：根据当前是否全选切换图标（勾选框 空/勾选 两种状态）与文案
    function syncCheckAllBtn() {
      if (!sessionsPane) return;
      var btn = sessionsPane.querySelector('#wbs-sess-check-all');
      if (!btn) return;
      var selectable = sessionsState.list.slice();
      var allSel = selectable.length > 0 && selectable.every(function (s) { return sessionsState.selected[s.id]; });
      btn.textContent = allSel ? '取消全选' : '全选';
    }
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
    // 批量模式工具栏切换：开启时隐藏「批量操作/count/刷新」并在同一行显示批量操作按钮；
    // 关闭时恢复。批量按钮行与筛选行共用 toolbar，不再另起一行。
    function setSessBatchBar(on) {
      var bar = sessionsPane.querySelector('#wbs-sess-batchbar');
      var bb = sessionsPane.querySelector('#wbs-sess-batch');
      var importBtn = sessionsPane.querySelector('#wbs-sess-import');
      var cnt = sessionsPane.querySelector('#wbs-sess-count');
      if (bb) { bb.style.display = on ? 'none' : ''; bb.classList.toggle('active', on); }
      if (importBtn) importBtn.style.display = on ? 'none' : '';
      if (cnt) cnt.style.display = on ? 'none' : '';
      if (bar) bar.style.display = on ? 'flex' : 'none';
    }

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
      // 批量操作：进入批量模式（工具栏右侧按钮隐藏，批量按钮在同一行原位显示）。退出通过「取消」按钮
      var batchBtn = sessionsPane.querySelector('#wbs-sess-batch');
      if (batchBtn) {
        batchBtn.addEventListener('click', function () {
          if (sessionsState.batchMode) return; // 已在批量模式：仅「取消」可退出
          sessionsState.batchMode = true;
          sessionsState.selected = {};
          setSessBatchBar(true);
          renderSessions();
          updateSessCount();
        });
      }
      // 全部勾选/清空 toggle（多选框图标按钮）
      var checkAll = sessionsPane.querySelector('#wbs-sess-check-all');
      if (checkAll) {
        checkAll.addEventListener('click', function () {
          var selectable = sessionsState.list.slice();
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
      var exportBtn = sessionsPane.querySelector('#wbs-sess-export');
      if (exportBtn) exportBtn.addEventListener('click', function () {
        var ids = selectedSessIds();
        if (!ids.length) { toast('请先勾选要导出的会话', true, root); return; }
        openSecureTransferModal({
          title: '导出会话',
          requirePassword: true,
          confirmText: '导出',
          hint: '将加密导出 ' + ids.length + ' 个会话及其本地消息附件。',
          onConfirm: function (password) { return api('/api/sessions/export', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ids: ids, password: password }),
          }).then(function (result) {
            downloadTransfer(result, 'WorkDaddy-sessions.json');
            toast('已导出 ' + result.count + ' 个会话（已加密）', false, root);
          }); },
        });
      });
      var importBtn = sessionsPane.querySelector('#wbs-sess-import');
      var importFile = sessionsPane.querySelector('#wbs-sess-import-file');
      if (importBtn && importFile) {
        importBtn.addEventListener('click', function () { importFile.click(); });
        importFile.addEventListener('change', function (event) {
          var file = event.target && event.target.files && event.target.files[0];
          event.target.value = '';
          if (!file) return;
          readTransferFile(file).then(function (content) {
            var targetUid = sessionsState.uid === '' ? '' : (sessionsState.uid || sessionsState.currentUid || '');
            var target = sessionsState.accounts.find(function (account) { return account.uid === targetUid; });
            openSecureTransferModal({
              title: '导入会话',
              requirePassword: true,
              confirmText: '导入',
              hint: targetUid ? '会话将导入到「' + ((target && target.nickname) || '当前账号') + '」。' : '会话将保留导出时的账号归属。',
              onConfirm: function (password) { return api('/api/sessions/import', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ content: content, password: password, targetUid: targetUid }),
              }).then(function (result) {
                toast('已导入 ' + result.count + ' 个会话' + (result.failed ? '，' + result.failed + ' 个失败' : ''), !!result.failed, root);
                loadSessions();
              }); },
            });
          }).catch(function (error) { toast(error.message || '读取文件失败', true, root); });
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
      // 取消（退出批量模式，恢复工具栏右侧按钮）
      var doneBtn = sessionsPane.querySelector('#wbs-sess-done');
      if (doneBtn) {
        doneBtn.addEventListener('click', function () {
          sessionsState.batchMode = false;
          sessionsState.selected = {};
          setSessBatchBar(false);
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
              return '<option value="' + escAttr(a.uid) + '">' + esc(a.nickname || a.uid) + (a.phone ? '（' + esc(a.phone) + '）' : '') + '</option>';
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
      return sessionsState.list.filter(function (s) { return sessionsState.selected[s.id]; }).map(function (s) { return s.id; });
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
        '<div class="wbs-model-batchbar" id="wbs-model-batchbar" style="display:none">' +
        '<button class="wbs-sess-bbtn wbs-model-check-all" type="button" id="wbs-model-check-all">全选</button>' +
        '<span class="wbs-model-batch-count" id="wbs-model-batch-count">已选 0</span>' +
        '<button class="wbs-sess-bbtn wbs-model-batch-action" type="button" id="wbs-model-batch-action"></button>' +
        '<button class="wbs-sess-bbtn wbs-sess-done" type="button" id="wbs-model-done">取消</button>' +
        '</div>' +
        '</div>' +
        '<div class="wbs-model-tip" id="wbs-model-tip" style="display:none"><span class="wbs-model-tip-ico">' + MODEL_TIP_SVG + '</span><strong>小贴士</strong><span>解决 WorkBuddy 不支持多个同名模型的问题。</span></div>' +
        '<div class="wbs-model-list" id="wbs-model-list"><div class="wbs-empty">加载中…</div></div>' +
        '</div>' +
        '<div class="wbs-modal-mask" id="wbs-model-confirm" style="display:none"><div class="wbs-modal"><div class="wbs-modal-title" id="wbs-model-confirm-title">确认操作</div><div class="wbs-modal-body" id="wbs-model-confirm-body"></div><div class="wbs-modal-actions"><button class="wbs-modal-btn" type="button" id="wbs-model-confirm-cancel">取消</button><button class="wbs-modal-btn wbs-modal-ok" type="button" id="wbs-model-confirm-ok">确定</button></div></div></div>' +
        '<div class="wbs-modal-mask" id="wbs-model-edit" style="display:none"><div class="wbs-modal wbs-model-edit-modal"><div class="wbs-modal-title">编辑模型</div><div class="wbs-model-edit-form"><label class="wbs-model-edit-field"><span>自定义名称</span><input id="wbs-model-edit-name" type="text" autocomplete="off" placeholder="例如我的 DeepSeek"></label><label class="wbs-model-edit-field"><span>模型名</span><input id="wbs-model-edit-id" type="text" autocomplete="off" placeholder="例如 deepseek-v4-flash"></label><label class="wbs-model-edit-field"><span>URL</span><input id="wbs-model-edit-url" type="url" autocomplete="off"></label><label class="wbs-model-edit-field"><span>API Key</span><span class="wbs-model-secret-wrap"><input id="wbs-model-edit-key" type="password" autocomplete="off"><button class="wbs-model-eye" id="wbs-model-edit-eye" type="button" title="显示或隐藏 API Key" aria-label="显示或隐藏 API Key"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/></svg></button></span></label></div><div class="wbs-modal-actions"><button class="wbs-modal-btn" type="button" id="wbs-model-edit-cancel">取消</button><button class="wbs-modal-btn wbs-modal-ok" type="button" id="wbs-model-edit-save">保存</button></div></div></div>';
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
          '<button class="wbs-model-icon-action" type="button" data-model-backup="' + escAttr(model.index) + '" title="备份" aria-label="备份">' + MODEL_BACKUP_SVG + '</button>' +
          '<button class="wbs-model-icon-action" type="button" data-model-test="' + escAttr(model.index) + '" title="连通测试" aria-label="连通测试">' + MODEL_TEST_SVG + '</button>' +
          '<button class="wbs-model-icon-action wbs-model-danger-action" type="button" data-model-delete-official="' + escAttr(model.index) + '" title="删除" aria-label="删除">' + TRASH_SVG + '</button>' +
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
      var modelCount = modelsPane.querySelector('#wbs-model-count');
      if (modelCount) modelCount.style.display = modelsState.batch ? 'none' : '';
      var spacer = modelsPane.querySelector('.wbs-model-toolbar-spacer');
      if (spacer) spacer.style.display = modelsState.batch ? 'none' : '';
      var batchbar = modelsPane.querySelector('#wbs-model-batchbar');
      if (batchbar) batchbar.style.display = modelsState.batch ? 'flex' : 'none';
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
        return '<div class="wbs-model-group"><div class="wbs-model-group-head"><span class="wbs-model-group-title">' + esc(group.id || '(未命名模型)') + '</span><span class="wbs-model-group-count">' + items.length + '</span></div>' + items.map(function (model) {
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
      var id = modelsPane.querySelector('#wbs-model-edit-id');
      var name = modelsPane.querySelector('#wbs-model-edit-name');
      var url = modelsPane.querySelector('#wbs-model-edit-url');
      var key = modelsPane.querySelector('#wbs-model-edit-key');
      var eye = modelsPane.querySelector('#wbs-model-edit-eye');
      var save = modelsPane.querySelector('#wbs-model-edit-save');
      var cancel = modelsPane.querySelector('#wbs-model-edit-cancel');
      id.value = item.id || item.name || '';
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
        var patch = { id: id.value, name: name.value, url: url.value };
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
        '<button class="wbs-theme-opt active" type="button" data-theme="default">默认</button>' +
        '<button class="wbs-theme-opt" type="button" data-theme="eye-care">护眼绿</button>' +
        '<button class="wbs-theme-opt" type="button" data-theme="cyber-purple">赛博紫</button>' +
        '<button class="wbs-theme-opt" type="button" data-theme="nebula">' + WBS_BRAND + '</button>' +
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
        '<div class="wbs-bg-upload" id="wbs-bg-upload" title="点击选择图片，或拖拽到此处"><span class="wbs-bg-upload-ico">+</span><span>点击或拖拽上传壁纸</span><span class="wbs-bg-upload-hint">支持 PNG / JPG / WebP，自动压缩；可添加多张</span></div>' +
        '<div class="wbs-wallpapers wbs-custom-wallpapers" id="wbs-custom-wallpapers"><div class="wbs-wp-loading">壁纸加载中…</div></div>' +
        '<input type="file" id="wbs-theme-file" accept="image/png,image/jpeg,image/webp" style="display:none">' +
        '</div>' +
        '<div class="wbs-avatar-row">' +
        '<img class="wbs-avatar-preview" id="wbs-avatar-preview" alt="头像预览" title="点击恢复官方头像">' +
        '<button class="wbs-theme-upload" id="wbs-avatar-upload" type="button" title="上传图片替换左下角头像">更换头像</button>' +
        '<button class="wbs-theme-upload" id="wbs-avatar-reset" type="button" title="恢复 WorkBuddy 官方头像">恢复默认</button>' +
        '<input type="file" id="wbs-avatar-file" accept="image/png,image/jpeg,image/webp" style="display:none">' +
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
        '<div class="wbs-pcard" id="wbs-ac-card">' +
        '<div class="wbs-pcard-title">会话<span class="wbs-pcard-sub" id="wbs-ac-status"></span></div>' +
        '<div class="wbs-nd-row" id="wbs-ac-row">' +
        '<span class="wbs-nd-title">继续异常中断会话</span>' +
        '<span class="wbs-nd-hint">检测到会话异常中断，自动让它继续。</span>' +
        '<label class="wbs-switch"><input type="checkbox" id="wbs-ac-switch"><span class="wbs-switch-slider"></span></label>' +
        '</div>' +
        '<div class="wbs-nd-row">' +
        '<span class="wbs-nd-title">暂存提示词</span>' +
        '<span class="wbs-nd-hint">暂存想法择机发送，发送后自动删除。</span>' +
        '<label class="wbs-switch"><input type="checkbox" id="wbs-sess-stash"><span class="wbs-switch-slider"></span></label>' +
        '</div>' +
        '<div class="wbs-nd-row">' +
        '<span class="wbs-nd-title">会话消息索引</span>' +
        '<span class="wbs-nd-hint">悬停预览，点击或拖动快速定位消息。</span>' +
        '<label class="wbs-switch" title="在会话左侧显示消息索引"><input type="checkbox" id="wbs-sess-message-nav"><span class="wbs-switch-slider"></span></label>' +
        '</div>' +
        '<div class="wbs-nd-row">' +
        '<span class="wbs-nd-title">引用消息文本</span>' +
        '<span class="wbs-nd-hint">选中会话消息文字后，一键插入输入框。</span>' +
        '<label class="wbs-switch" title="选中会话消息中的文字后显示引用按钮"><input type="checkbox" id="wbs-sess-selection-quote"><span class="wbs-switch-slider"></span></label>' +
        '</div>' +
        '<div class="wbs-nd-row">' +
        '<span class="wbs-nd-title">快捷短语</span>' +
        '<span class="wbs-nd-hint">发送后不会自动删除。</span>' +
        '<label class="wbs-switch"><input type="checkbox" id="wbs-sess-phrase"><span class="wbs-switch-slider"></span></label>' +
        '</div>' +
        '<div class="wbs-qp-area" id="wbs-qp-area" style="display:none">' +
        '<div class="wbs-qp-toolbar">' +
        '<span class="wbs-qp-batchbar" id="wbs-qp-batchbar" style="display:none">' +
        '<button class="wbs-sess-bbtn" type="button" id="wbs-qp-checkall">全选</button>' +
        '<span class="wbs-qp-batch-count" id="wbs-qp-batch-count">已选 0</span>' +
        '<button class="wbs-sess-bbtn" type="button" id="wbs-qp-copy" title="复制选中快捷短语">' + MODEL_COPY_SVG + '<span>复制</span></button>' +
        '<button class="wbs-sess-bbtn" type="button" id="wbs-qp-export" title="使用密码导出选中快捷短语">' + EXPORT_ICON + '<span>导出</span></button>' +
        '<button class="wbs-sess-bbtn wbs-qp-batch-action" type="button" id="wbs-qp-batch-del">删除</button>' +
        '<button class="wbs-sess-bbtn wbs-sess-done" type="button" id="wbs-qp-done">取消</button>' +
        '</span>' +
        '<button class="wbs-sess-bbtn" type="button" id="wbs-qp-batch">批量操作</button>' +
        '<button class="wbs-sess-bbtn" type="button" id="wbs-qp-import" title="从加密文件导入快捷短语">' + IMPORT_ICON + '<span>导入</span></button>' +
        '<span class="wbs-qp-toolbar-spacer"></span>' +
        '<button class="wbs-sess-bbtn" type="button" id="wbs-qp-add">+ 新增</button>' +
        '</div>' +
        '<input type="file" id="wbs-qp-import-file" accept=".json,application/json" style="display:none">' +
        '<div class="wbs-qp-list" id="wbs-qp-list"><div class="wbs-empty">加载中…</div></div>' +
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
        '<div class="wbs-ac-log-wrap" id="wbs-ac-log-wrap">' +
        '<div class="wbs-ac-log-head">会话 · 状态机日志<span class="wbs-ac-log-clear" id="wbs-ac-log-clear" title="清空日志">清空</span></div>' +
        '<pre class="wbs-ac-log" id="wbs-ac-log">（未开启「会话异常中断」监控时无日志）</pre>' +
        '</div>' +
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
        '<label class="wbs-sleep-mode"><input type="radio" name="wbs-sleep-mode" value="until-done"><span class="wbs-sleep-mode-name">所有会话结束允许休眠</span><span class="wbs-sleep-mode-hint">任一会话运行中都保持唤醒</span></label>' +
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
            var mode = this.value;
            // until-done：校验至少一个会话正在进行中；无进行中会话则拒绝并回退 allow
            if (mode === 'until-done') {
              if (!isAnySessionBusy()) {
                toast('当前没有进行中的会话，无法开启「所有会话结束允许休眠」', true, root);
                var goBack = pcPane && pcPane.querySelector('input[name="wbs-sleep-mode"][value="allow"]');
                if (goBack) goBack.checked = true;
                syncSleepState();
                return;
              }
            }
            postSleepMode(mode, displaySleepSwitch ? displaySleepSwitch.checked : false);
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

      // 关于 pane：项目信息卡 + 简洁的错误诊断开关 + 版本
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
          '<div class="wbs-about-name-row"><div class="wbs-about-name" id="wbs-about-name">' + WBS_BRAND + '</div><span class="wbs-about-ver" id="wbs-about-ver">' + esc('') + '</span></div>' +
          '<span class="wbs-about-badge" id="wbs-about-badge">本机回环 CDP 注入 · 不改官方安装包</span>' +
          '<div class="wbs-about-desc">一个基于 <b>Chrome DevTools Protocol (CDP)</b> 的 WorkBuddy 桌面端增强工具。零侵入、零重签名——只把界面组件注入到正在运行的 WorkBuddy 渲染进程里。</div>' +
          '<div class="wbs-about-support">' +
            '<span class="wbs-about-support-text" title="如果 WorkDaddy 对你有帮助，欢迎在 GitHub 点个 Star。你的支持会让这个小项目持续更新。">如果 WorkDaddy 对你有帮助，欢迎在 GitHub 点个 Star。你的支持会让这个小项目持续更新。</span>' +
            '<a class="wbs-about-feedback" id="wbs-about-issues" href="https://github.com/babygoton/WorkDaddy/issues" target="_blank" rel="noopener" title="去 GitHub Issues 反馈问题">' +
              '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' +
              '<span>问题反馈</span>' +
            '</a>' +
            '<a class="wbs-about-ghbtn" id="wbs-about-repo" href="https://github.com/babygoton/WorkDaddy" target="_blank" rel="noopener" aria-label="在 GitHub 上给 WorkDaddy 点 Star" title="在 GitHub 上给 WorkDaddy 点 Star">' +
              '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M12 .3a12 12 0 0 0-3.79 23.39c.6.11.82-.26.82-.58v-2.03c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.33-1.76-1.33-1.76-1.09-.74.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.5 1 .1-.78.42-1.31.76-1.61-2.66-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.11-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6.01 0c2.29-1.55 3.3-1.23 3.3-1.23.65 1.66.24 2.88.12 3.18.77.84 1.23 1.91 1.23 3.22 0 4.61-2.81 5.62-5.49 5.92.43.37.82 1.1.82 2.22v3.29c0 .32.22.7.83.58A12 12 0 0 0 12 .3z"/></svg>' +
            '</a>' +
          '</div>' +
        '</div>' +
        '<div class="wbs-pcard wbs-telemetry-card" id="wbs-telemetry-card">' +
          '<div class="wbs-telemetry-head">' +
            '<div class="wbs-telemetry-label"><span class="wbs-pcard-title">发送错误诊断</span><span class="wbs-telemetry-help" tabindex="0" aria-label="查看错误诊断说明"><svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="10" cy="10" r="8"/><path d="M8.4 7.6a1.8 1.8 0 1 1 2.8 1.45c-.75.48-1.2.85-1.2 1.75M10 13.7v.1"/></svg><span class="wbs-telemetry-tooltip" role="tooltip">仅发送经过脱敏、截断的版本、系统和错误信息，不包含账号、会话内容、Token 或 API Key；可随时关闭。</span></span></div>' +
            '<div class="wbs-telemetry-ctrl"><span class="wbs-telemetry-reco">推荐开启</span>' +
            '<label class="wbs-switch wbs-telemetry-switch" title="发送经过脱敏的错误诊断"><input type="checkbox" id="wbs-telemetry-switch" aria-label="发送错误诊断"><span class="wbs-switch-slider"></span></label>' +
            '</div>' +
          '</div>' +
          '<div class="wbs-telemetry-status" id="wbs-telemetry-status" role="status" aria-live="polite">正在读取设置…</div>' +
        '</div>' +
        '<div class="wbs-pcard wbs-monitor-log-card" id="wbs-monitor-log-card"' + (hiddenToolsUnlocked ? '' : ' style="display:none"') + '>' +
          '<div class="wbs-telemetry-head">' +
            '<div class="wbs-telemetry-label"><span class="wbs-pcard-title">会话监听日志</span><span class="wbs-pcard-sub">仅保存在当前页面内存</span></div>' +
          '</div>' +
          '<div class="wbs-monitor-log-inline" id="wbs-monitor-log-inline">' +
            '<div class="wbs-monitor-log-session-list" aria-label="进行中的会话"></div>' +
            '<div class="wbs-monitor-log-list" role="log" aria-live="polite">暂无进行中的会话</div>' +
          '</div>' +
        '</div>' +
        '';

      // 回拉 /api/about 填充信息（失败时保留硬编码占位）
      var ver = aboutPane.querySelector('#wbs-about-ver');
      if (ver) ver.textContent = 'v' + (WBS_VERSION && WBS_VERSION.indexOf('__WBS_') !== 0 ? WBS_VERSION : '');
      api('/api/about').then(function (d) {
        if (!d || !d.ok) return;
        var el;
        el = aboutPane.querySelector('#wbs-about-name');
        if (el && d.name) el.textContent = d.name;
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
      wireTelemetrySettings();
      acRenderMonitorLogModal();
      // 自动更新：检查 + 红点 + 更新卡片
      checkForUpdate();
    }

    function wireTelemetrySettings() {
      var toggle = aboutPane.querySelector('#wbs-telemetry-switch');
      var status = aboutPane.querySelector('#wbs-telemetry-status');
      if (!toggle || !status) return;
      function renderTelemetryState(enabled, managed) {
        toggle.checked = !!enabled;
        toggle.disabled = !managed;
        // 管理范围内：开关左侧固定展示「推荐开启」，不再显示已开启/已关闭动态文案
        var reco = aboutPane.querySelector('.wbs-telemetry-reco');
        if (reco) reco.style.display = managed ? '' : 'none';
        status.textContent = managed ? '' : '由环境变量控制';
        status.classList.toggle('is-off', !enabled);
      }
      api('/api/telemetry-settings').then(function (data) {
        renderTelemetryState(data.enabled, data.managed !== false);
      }).catch(function () {
        renderTelemetryState(true, true);
        status.textContent = '默认开启 · 设置读取失败';
      });
      toggle.addEventListener('change', function () {
        var next = toggle.checked;
        toggle.disabled = true;
        status.textContent = '保存中…';
        api('/api/telemetry-settings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: next }),
        }).then(function (data) {
          renderTelemetryState(data.enabled, data.managed !== false);
        }).catch(function (error) {
          toggle.checked = !next;
          toggle.disabled = false;
          status.textContent = '由环境变量控制';
          toast('诊断设置保存失败: ' + (error.message || error), true, root);
        });
      });
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

    // 点击「立即更新」：后台下载并校验。Windows 下载完成后由用户明确打开
    // 可见 Setup.exe；macOS 继续沿用原有自动安装与重启流程。
    function startUpdate() {
      var btn = aboutPane.querySelector('#wbs-update-btn');
      var prog = aboutPane.querySelector('#wbs-update-progress');
      var card = aboutPane.querySelector('#wbs-update-card');
      if (!btn || !card) return;
      btn.disabled = true;
      btn.textContent = '下载中…';
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

    function openWindowsInstaller(prog, btn) {
      if (!btn) return;
      btn.disabled = true;
      btn.textContent = '正在打开…';
      appendUpdateLog(prog, '正在打开已校验的安装程序…');
      api('/api/update-apply', { method: 'POST' }).then(function (result) {
        if (!result || !result.ok || !result.opened) {
          var rejected = new Error(formatUpdateFailure(result, '无法打开安装程序'));
          rejected.payload = result;
          throw rejected;
        }
        btn.textContent = '安装程序已打开';
        appendUpdateLog(prog, '安装程序已打开，请按提示退出 WorkBuddy 并完成安装。');
      }).catch(function (error) {
        btn.disabled = false;
        btn.textContent = '打开安装程序';
        var failure = formatUpdateFailure(error, '无法打开安装程序');
        appendUpdateLog(prog, failure);
        try { toast(failure, true, root); } catch (_) {}
      });
    }

    function showWindowsInstallerReady(prog, btn, card, timer) {
      if (timer) clearInterval(timer);
      appendUpdateLog(prog, '即将打开安装包…');
      var bar = card ? card.querySelector('#wbs-update-bar') : null;
      var barFill = bar ? bar.querySelector('#wbs-update-bar-fill') : null;
      if (bar) bar.style.display = '';
      if (barFill) barFill.style.width = '100%';
      if (btn) {
        btn.disabled = false;
        btn.textContent = '打开安装程序';
        btn.onclick = function () { openWindowsInstaller(prog, btn); };
      }
    }

    function openWindowsInstallerAfterDownload(prog, btn, card, timer, resolve, reject) {
      showWindowsInstallerReady(prog, btn, card, timer);
      api('/api/update-apply', { method: 'POST' }).then(function (result) {
        if (!result || !result.ok || !result.opened) {
          var rejected = new Error(formatUpdateFailure(result, '无法打开安装程序'));
          rejected.payload = result;
          throw rejected;
        }
        if (btn) {
          btn.disabled = true;
          btn.textContent = '安装包已打开';
          btn.onclick = null;
        }
        resolve(true);
      }).catch(function (error) {
        var failure = formatUpdateFailure(error, '无法打开安装程序');
        appendUpdateLog(prog, failure);
        try { toast(failure, true, root); } catch (_) {}
        reject(error);
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
              // Windows 安装由用户打开的 Setup.exe 接管；兼容旧 daemon 的残留
              // installing 状态时也必须停在安装包入口，不能再次触发自动重启流程。
              if (WBS_PLATFORM === 'win32') {
                if (s.downloaded) {
                  showWindowsInstallerReady(prog, btn, card, timer);
                  resolve(true);
                }
              } else {
                appendUpdateLog(prog, '正在安装新版本…');
                if (btn) btn.textContent = '安装中…';
                fireApply();
              }
            } else if (st === 'error') {
              clearInterval(timer);
              var statusError = new Error(formatUpdateFailure(s, '更新出错'));
              statusError.payload = s;
              reject(statusError);
            } else if (st === 'idle' && s.downloaded) {
              if (WBS_PLATFORM === 'win32') {
                openWindowsInstallerAfterDownload(prog, btn, card, timer, resolve, reject);
              } else {
                appendUpdateLog(prog, '下载完成，准备安装…');
                fireApply();
              }
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
          var previous = themePane.querySelector('.wbs-theme-opt.active');
          themePane.querySelectorAll('.wbs-theme-opt').forEach(function (b) { b.classList.toggle('active', b === segBtn); });
          applyTheme(id).then(function () {
            var names = { 'default': '默认', 'nebula': WBS_BRAND + ' 主题', 'eye-care': '护眼绿', 'cyber-purple': '赛博紫' };
            toast('已应用主题「' + (names[id] || id) + '」', false, root);
          }).catch(function (er) {
            themePane.querySelectorAll('.wbs-theme-opt').forEach(function (b) { b.classList.toggle('active', b === previous); });
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
      wireAutoContinuePane();
      wireSessionControls();
      // （开发调试入口已抽离至独立脚本 picker-internal.js，连点 logo 右侧按钮呼出）
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
    function loadWallpapers(force) {
      var grid = root.querySelector('#wbs-wallpapers');
      var cgrid = root.querySelector('#wbs-custom-wallpapers');
      if (!grid && !cgrid) return;
      if (grid && grid.dataset.loaded && !force) return;
      if (grid) grid.dataset.loaded = '1';
      var base = API.replace(/\/api\/?$/, '');
      api('/api/wallpapers').then(function (d) {
        var list = d.wallpapers || [];
        var customList = d.customWallpapers || [];
        var current = d.currentWallpaper || null;
        if (grid) {
          if (!list.length) { grid.innerHTML = '<div class="wbs-wp-loading">暂无官方壁纸</div>'; }
          else {
            var html = '';
            list.forEach(function (w) {
              var wallpaperUrl = base + '/wallpapers/' + encodeURIComponent(w.name);
              html +=
                '<div class="wbs-wp' + (current === w.name ? ' active' : '') + '" data-wp="' + escAttr(w.name) + '" title="' + escAttr(w.title) + '">' +
                '<div class="wbs-wp-thumb"><img data-src="' + escAttr(wallpaperUrl) + '" alt="' + escAttr(w.title) + '" loading="lazy"></div>' +
                '<div class="wbs-wp-badge">' + esc(String(w.name).replace(/\D/g, '').replace(/^0+/, '') || w.title) + '</div>' +
                '</div>';
            });
            grid.innerHTML = html;
          }
        }
        if (cgrid) {
          if (!customList.length) { cgrid.innerHTML = '<div class="wbs-wp-loading">还没有自定义壁纸，先上传一张</div>'; }
          else {
            var chtml = '';
            customList.forEach(function (w) {
              var wallpaperUrl = base + '/wallpapers/' + encodeURIComponent(w.name);
              chtml +=
                '<div class="wbs-wp wbs-wp-custom' + (current === w.name ? ' active' : '') + '" data-wp="' + escAttr(w.name) + '" title="' + escAttr(w.title) + '">' +
                '<button class="wbs-wp-del" type="button" title="删除壁纸" data-del="' + escAttr(w.name) + '"><span class="wbs-wp-del-ico"></span></button>' +
                '<div class="wbs-wp-thumb"><img data-src="' + escAttr(wallpaperUrl) + '" alt="' + escAttr(w.title) + '" loading="lazy"></div>' +
                '</div>';
            });
            cgrid.innerHTML = chtml;
          }
        }
        // 面板高度固定为主题页高度：首进主题页壁纸渲染后锁定，防止切 tab 高度跳动
        lockPanelHeight();
        // 逐张 fetch → blob → objectURL 预览（no-store 防 HTTP 缓存旧图——图库重建后同名文件内容会变）
        var allGrids = [grid, cgrid].filter(Boolean);
        allGrids.forEach(function (g) {
          g.querySelectorAll('.wbs-wp-thumb img').forEach(function (im) {
            fetch(im.getAttribute('data-src'), { cache: 'no-store' })
              .then(function (r) { return r.ok ? r.blob() : Promise.reject(new Error('HTTP ' + r.status)); })
              .then(function (blob) { im.src = URL.createObjectURL(blob); })
              .catch(function () {
                im.alt = '加载失败';
                im.style.opacity = '.25';
              });
          });
        });
        // 官方/自定义壁纸点击切换（互斥高亮：切换后重载两侧网格同步选中态）
        allGrids.forEach(function (g) {
          g.querySelectorAll('.wbs-wp').forEach(function (card) {
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
                toast('已应用壁纸「' + (card.getAttribute('title') || name) + '」', false, root);
                loadWallpapers(true);
              }).catch(function (e) {
                toast('切换壁纸失败: ' + (e.message || e), true, root);
              }).finally(function () { card.classList.remove('busy'); });
            });
          });
        });
        // 自定义壁纸删除（仅 custom 网格）：直接删文件 + 刷新；删除的是当前壁纸时提示
        if (cgrid) {
          cgrid.querySelectorAll('.wbs-wp-del').forEach(function (btn) {
            btn.addEventListener('click', function (ev) {
              ev.stopPropagation();
              var name = btn.getAttribute('data-del');
              var card = btn.closest('.wbs-wp');
              if (card && card.classList.contains('busy')) return;
              api('/api/custom-wallpapers?name=' + encodeURIComponent(name), { method: 'DELETE' }).then(function (r) {
                if (!r || !r.ok) throw new Error((r && r.error) || '删除失败');
                if (name === current) toast('已删除当前壁纸（背景保留不变）', false, root);
                else toast('已删除壁纸', false, root);
                loadWallpapers(true);
              }).catch(function (e) {
                toast('删除壁纸失败: ' + (e.message || e), true, root);
              });
            });
          });
        }
      }).catch(function () {
        if (grid) grid.innerHTML = '<div class="wbs-wp-loading">壁纸加载失败（daemon 不可达）</div>';
        if (cgrid) cgrid.innerHTML = '<div class="wbs-wp-loading">壁纸加载失败（daemon 不可达）</div>';
      });
    }

    function setOpen(open) {
      state.open = open;
      panel.classList.toggle('show', open);
      fab.classList.toggle('hidden', open); // 打开时隐藏按钮
      if (open) {
        refresh();
        checkForUpdate(); // 打开面板即检测更新（每次打开都强制查一次新版本）
        try { acCheckPromptOnOpen(); } catch (e) {} // 每次打开面板：指令块丢失则请求 daemon 补写（无 toast）
        try { syncSessionModule(); } catch (e) {} // 每次打开面板刷新会话模块（开关+快捷短语，含外部修改）
      } else {
        stopCheckinPolling();
        state.creditRunId++;
      }
    }

    function setupFabDrag() {
      var handle = fab.querySelector('.wbs-fab .button.up');
      if (!handle) return;
      fab.style.touchAction = 'none';
      fab.style.userSelect = 'none';
      handle.style.touchAction = 'none';
      listen(handle, 'pointerdown', function (e) {
        if (e.button !== undefined && e.button !== 0) return;
        var rect = fab.getBoundingClientRect();
        fabDrag = {
          pointerId: e.pointerId,
          startY: e.clientY,
          startX: e.clientX,
          startRight: window.innerWidth - rect.right,
          startBottom: window.innerHeight - rect.bottom,
        };
        fabDragMoved = false;
        fabDragSuppressClick = false;
        fab.classList.add('is-dragging');
        try { handle.setPointerCapture(e.pointerId); } catch (_) {}
        if (e.preventDefault) e.preventDefault();
      });
      listen(handle, 'pointermove', function (e) {
        if (!fabDrag || e.pointerId !== fabDrag.pointerId) return;
        var deltaX = e.clientX - fabDrag.startX;
        var deltaY = e.clientY - fabDrag.startY;
        if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) >= FAB_DRAG_THRESHOLD) {
          fabDragMoved = true;
          fabDragSuppressClick = true;
        }
        applyFabPosition(fab, fabDrag.startRight - deltaX, fabDrag.startBottom - deltaY);
        if (e.preventDefault) e.preventDefault();
      });
      function finishFabDrag(e) {
        if (!fabDrag || (e && e.pointerId !== fabDrag.pointerId)) return;
        var rect = fab.getBoundingClientRect();
        var bottom = clampFabBottom(window.innerHeight - rect.bottom, rect.height || 32);
        // 释放后水平吸附回右边，垂直位置保留。
        if (fabSnapTimer !== null) {
          clearTimeout(fabSnapTimer);
          fabSnapTimer = null;
        }
        fab.classList.remove('is-dragging');
        fab.classList.add('is-snapping');
        applyFabPosition(fab, FAB_EDGE_GAP, bottom);
        try { localStorage.setItem(FAB_POSITION_KEY, String(Math.round(bottom))); } catch (_) {}
        fabDrag = null;
        fabSnapTimer = setBuildTimeout(function () {
          fabSnapTimer = null;
          fab.classList.remove('is-snapping');
        }, 620);
      }
      listen(handle, 'pointerup', finishFabDrag);
      listen(handle, 'pointercancel', finishFabDrag);
      listen(handle, 'lostpointercapture', function () {
        if (fabDrag) finishFabDrag();
      });
    }

    setupFabDrag();
    fab.addEventListener('click', function (e) {
      if (fabDragSuppressClick || fabDragMoved) {
        fabDragSuppressClick = false;
        fabDragMoved = false;
        if (e.preventDefault) e.preventDefault();
        if (e.stopPropagation) e.stopPropagation();
        return;
      }
      setOpen(true);
    });
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
    // 只提供四个入口：官方主题(default) 与 WorkDaddy 官方主题(nebula)、官方内置深色主题(eye-care/cyber-purple)
    // 默认选中「WorkBuddy 默认主题」(default)：未设置/异常时回退到 default 而非 nebula（用户要求）
    var ALLOWED_THEMES = ['default', 'nebula', 'eye-care', 'cyber-purple'];
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

    // ===== 元素检查（隐藏入口，实现抽离在 picker-internal.js，git 不跟踪）=====
    // 连续点击面板标题 5 次 → 在标题右侧显示「🔍 拾取」按钮；点击进入拾取模式。
    // 实现代码在 picker-internal.js（daemon 拼注入脚本时若有该文件则注入，定义 window.__wbsStartPicked）；
    // 他人环境没有该文件 → 按钮点击时 __wbsStartPicked 不存在 → toast 报错即可，不影响其他功能。
    var piTitle = root.querySelector('#wbs-title');
    var piPickBtn = root.querySelector('#wbs-pick-btn');
    var piClickCount = 0;
    var piClickTimer = null;
    if (piTitle) {
      piTitle.addEventListener('click', function () {
        piClickCount += 1;
        clearTimeout(piClickTimer);
        piClickTimer = setBuildTimeout(function () { piClickCount = 0; }, 1200);
        if (piClickCount >= 5) {
          piClickCount = 0;
          hiddenToolsUnlocked = true;
          if (piPickBtn) piPickBtn.style.display = '';
          var monitorLogCard = aboutPane && aboutPane.querySelector('#wbs-monitor-log-card');
          if (monitorLogCard) monitorLogCard.style.display = '';
          try { toast('隐藏工具已呼出', false, root); } catch (_) {}
        }
      });
    }
    if (piPickBtn) {
      piPickBtn.addEventListener('click', function () {
        if (typeof window.__wbsStartPicked === 'function') {
          window.__wbsStartPicked();
        } else {
          toast('元素检查不可用：内部模块未加载', true, root);
        }
      });
    }

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
          // 先存入自定义壁纸库（多张），拿到文件名后再应用到当前主题
          api('/api/custom-wallpapers', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ dataUrl: compressed }),
          }).then(function (up) {
            if (!up || !up.ok) throw new Error((up && up.error) || '上传壁纸失败');
            var name = up.name;
            // 目标主题：当前选中的主题；若是 default 则用内置默认深色主题 nebula
            var target = themeSelectValue();
            return api('/api/theme-bg', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ id: target, custom: name }),
            }).then(function (d) {
              if (!d || !d.ok) throw new Error((d && d.error) || '替换背景图失败');
              toast('已添加并应用自定义壁纸', false, root);
              loadThemes();
              // 刷新自定义壁纸网格（含选中态）与当前壁纸高亮
              loadWallpapers(true);
            });
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
    var sleepSessionCache = Object.create(null); // until-done 独立发现的控制器缓存（仅内存）

    /* ===== 免打扰模块（No-Disturb）===== */
    var ndAutoObserver = null; // 弹窗自动点允许的 MutationObserver
    var ndScanTimer = null;
    var ndScanRoots = [];
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

    /* ———— 持续会话 · 会话异常中断（Auto-Continue 监控，macOS only）————
     * 状态机：IDLE → WATCHING（发现新助手消息）→ SETTLING → JUDGED。
     * 终局信号 = 助手消息底部操作区出现 feedback 元素（[class*="assistantFeedback"]，任务无论成败都会渲染），
     *          出现并经短缓冲（AC_FB_SETTLE_MS）稳定后：正文块末尾有完成标记 = 完成；无标记 = 异常 → 发送「如果未完成，继续执行；已完成则回复"已完成"」。
     * 兜底：feedback 选择器失效时，消息静默超过 AC_IDLE_FALLBACK_MS 也判定一次。
     * 只处理开关开启后新出现的回复；同一条只触发一次（judgedMessages）；generation 隔离旧回调。 */
    var AC_SETTLE_MS = 800;           // 判定轮询间隔（feedback 出现后/等待期间）
    var AC_FB_SETTLE_MS = 3000;       // feedback 出现后的 3 秒静默缓冲：等操作按钮区和正文彻底稳定再判定
    var AC_IDLE_FALLBACK_MS = 60000;  // DOM 兜底：feedback 一直未出现时，消息静默超过此时长才判定
    var AC_CONTROLLER_SETTLE_MS = 8000; // store 显示已空闲但 assistant 尚未 terminal 时的防抖窗口
    var AC_RETRY_DELAY_MS = 300;      // 发送失败重试间隔
    var AC_MAX_SEND_ATTEMPTS = 2;     // 同一回复最多发送尝试次数（首次+1 重试）
    var AC_STRICT_MARKER = '\u200B\u200B\u2060'; // 严格三连完成标记
    var AC_CONTINUE_TEXT = '如果未完成，继续执行；已完成则回复"已完成"';
    var AC_HEARTBEAT_MS = 5000;       // controller/会话区存活体检

    var acCtx = {
      generation: 0,
      controller: null,
      controllerUnsubs: null,
      controllerLastVersion: -1,
      controllerLastBusy: false,
      controllerIdleAt: 0,
      sessionRoot: null,
      observer: null,
      settleTimer: null,
      heartbeat: null,
      activeMessage: null,
      judgedMessages: null,   // Set<消息签名>：同一条消息只判定/触发一次（签名判重，虚拟列表重建可免疫）
      baselineMessages: null,
      lastMutationAt: 0,
      lastActiveTxt: '',
      lastMsgCount: 0,   // 上次观察到的助手消息数：新增消息 = 新回复；数量的增减而非元素重建可区分"切会话回放"
      sessionSig: '',    // 会话身份签名（URL + 首条用户消息）：变化 = 切换会话 → 重新校准基准，不触发
      feedbackSeen: false, // 当前消息是否已出现操作区（feedback）终局信号
      feedbackAt: 0,       // feedback 出现时间戳
      baselineAssistantKey: '', // 当前会话「切换后/开启后」最后一条已有助手消息的稳定 key（baseline，绝不判定）
      awaitingNewReply: false,  // 是否仍在等待新回复：为 true 时 baseline 消息的 feedback/文本变化/重排均不解除判定，不安排 settle
    };
    var acRunning = false;
    var acStatusTimer = null;
    var acMonitorRegistry = createSessionMonitorRegistry({ maxLogs: 180 });
    var acMulti = {
      generation: 0,
      sessions: Object.create(null),
      discoveryTimer: null,
      sessionResource: null,
      sessionResourceUnsubscribe: null,
      sessionResourceRetryAt: 0,
      sidebarReconcileAt: 0,
    };

    /** 状态机可视化日志：只写入当前 renderer 的有界内存，不落盘、不发送到 daemon。 */
    var AC_LOG_MAX = 150;
    var acLogLines = [];
    var acLogLastKeyTs = {};
    function acLogLine(msg, extra) {
      var now = new Date();
      var t = now.toTimeString().slice(0, 8) + '.' + String(now.getMilliseconds()).padStart(3, '0');
      return '[' + t + '] ' + msg + (extra ? ' | ' + JSON.stringify(extra).slice(0, 200) : '');
    }
    function acLog(msg, extra) {
      var line = acLogLine(msg, extra);
      acLogLines.push(line);
      if (acLogLines.length > AC_LOG_MAX) acLogLines.shift();
      try {
        var pre = enhancePane && enhancePane.querySelector('#wbs-ac-log');
        if (pre) { pre.textContent = acLogLines.join('\n'); pre.scrollTop = pre.scrollHeight; }
      } catch (e) {}
    }
    /** 限频日志：同一 key 在窗口内最多打一条（流式 mutation 每帧都打会刷屏） */
    function acLogR(key, msg, extra, windowMs) {
      var w = windowMs || 400;
      var last = acLogLastKeyTs[key] || 0;
      var now = Date.now();
      if (now - last < w) return;
      acLogLastKeyTs[key] = now;
      acLog(msg, extra);
    }

    function acSessionTitle(controller) {
      try {
        var view = controller && typeof controller.getSessionViewState === 'function'
          ? controller.getSessionViewState() : null;
        return String((view && (view.title || view.name)) || '').slice(0, 120);
      } catch (_) { return ''; }
    }

    function acMonitorLog(sessionId, event, detail) {
      if (!sessionId) return;
      acMonitorRegistry.append(sessionId, event, detail || {});
      acScheduleMonitorLogRender();
    }

    var acMonitorLogFrame = null;
    function acScheduleMonitorLogRender() {
      if (acMonitorLogFrame != null) return;
      var raf = window.requestAnimationFrame || function (fn) { return setTimeout(fn, 40); };
      acMonitorLogFrame = raf(function () {
        acMonitorLogFrame = null;
        acRenderLog();
        acRenderMonitorLogModal();
      });
    }

    function acResetState() {
      var c = acCtx;
      c.generation++;
      if (c.settleTimer) { clearTimeout(c.settleTimer); c.settleTimer = null; }
      if (c.observer) { try { c.observer.disconnect(); } catch (e) {} c.observer = null; }
      if (Array.isArray(c.controllerUnsubs)) {
        for (var ui = 0; ui < c.controllerUnsubs.length; ui++) {
          try { c.controllerUnsubs[ui](); } catch (e) {}
        }
      }
      c.controller = null;
      c.controllerUnsubs = null;
      c.controllerLastVersion = -1;
      c.controllerLastBusy = false;
      c.controllerIdleAt = 0;
      c.sessionRoot = null;
      c.activeMessage = null;
      c.judgedMessages = new Set();
      c.baselineMessages = new WeakSet();
      c.lastMutationAt = 0;
      c.lastActiveTxt = '';
      c.lastMsgCount = 0;
      c.sessionSig = '';
      c.feedbackSeen = false;
      c.feedbackAt = 0;
      c.baselineAssistantKey = '';
      c.awaitingNewReply = false;
    }

    /* 监控状态常驻展示：开关开启期间卡片标题右侧固定显示「监控激活会话中」 */
    var acStatusVisible = false;
    function acShowStatus() {
      acStatusVisible = true;
      if (acStatusTimer) { clearTimeout(acStatusTimer); acStatusTimer = null; } // 清掉弱提示残留定时
      var st = enhancePane && enhancePane.querySelector('#wbs-ac-status');
      if (st) st.textContent = '监控激活会话中';
    }
    function acHideStatus() {
      acStatusVisible = false;
      var st = enhancePane && enhancePane.querySelector('#wbs-ac-status');
      if (st) st.textContent = '';
    }
    function acStartStatusAnim() { acShowStatus(); } // 兼容旧调用名（固定展示）
    function acStopStatusAnim() { acHideStatus(); }

    /** 弱提示：复用卡片标题右侧的 wbs-ac-status 小字，4s 后自动清除；若状态常驻显示则暂停，提示结束恢复 */
    function acWeak(msg) {
      var restore = acStatusVisible;
      acStatusVisible = false;
      var st = enhancePane && enhancePane.querySelector('#wbs-ac-status');
      if (st) st.textContent = msg;
      if (acStatusTimer) clearTimeout(acStatusTimer);
      acStatusTimer = setTimeout(function () {
        var s = enhancePane && enhancePane.querySelector('#wbs-ac-status');
        if (s && s.textContent === msg) s.textContent = '';
        if (acRunning && restore) acShowStatus(); // 弱提示结束恢复状态常驻
      }, 4000);
    }

    /** 取正文块：内容容器直接子块中排除 widget/推理/元信息折叠，优先最后一段文本内容块（_assistantTextContent/markdown） */
    function acPickBodyBlock(contentEl) {
      if (!contentEl || !contentEl.children || !contentEl.children.length) return contentEl;
      var children = contentEl.children;
      var picked = null;
      for (var i = 0; i < children.length; i++) {
        var el = children[i];
        var cls = typeof el.className === 'string' ? el.className : '';
        if (/_widget|widgetRenderer|_assistantReasoning|_metaFold|_collapse/i.test(cls)) continue; // 非正文块跳过
        if (/_assistantTextContent|_assistantText|_markdown|markdown/i.test(cls)) picked = el; // 正文文本段优先
        else if (!picked) picked = el; // 兜底：第一个非跳过块
      }
      return picked || children[children.length - 1];
    }

    /** 完成标记判定：正文文本末尾（去除可见空白后）为严格三连标记 或 任一零宽字符。可见转义文本不算 */
    function acHasMarker(text) {
      if (typeof text !== 'string' || !text.length) return false;
      var t = text.replace(/[ \t\r\n\f\v\u00A0]+$/, ''); // 只去除可见空白，保留零宽字符（含 U+FEFF）
      if (!t.length) return false;
      if (t.slice(-AC_STRICT_MARKER.length) === AC_STRICT_MARKER) return true;
      if (/[\u200B\uFEFF\u2060\u200D]$/.test(t)) return true;
      return false;
    }

    function acHasCompletionActions(row) {
      if (!row || !row.querySelectorAll) return false;
      var controls = row.querySelectorAll('button,[role="button"]');
      for (var i = 0; i < controls.length; i++) {
        var el = controls[i];
        if (typeof isVisibleHealthNode === 'function') {
          if (!isVisibleHealthNode(el)) continue;
        } else if (el.offsetParent === null) continue;
        var text = [el.innerText, el.getAttribute('aria-label'), el.getAttribute('title'), el.className]
          .join(' ').replace(/\s+/g, ' ');
        if (/(^|\s)(copy|复制|regenerate|重新生成|retry|重试|read aloud|朗读)(\s|$)/i.test(text) ||
            /_copyButton_|_ratingButton_|_actionButton_|_shareButton_|_moreButton_/i.test(String(el.className || ''))) return true;
      }
      return false;
    }

    function acHasErrorSignal(row) {
      if (!row || !row.querySelectorAll) return false;
      var errors = row.querySelectorAll('[role="alert"],[class*="errorBanner"],[class*="_error_"],[class*="failed"],[class*="Failed"]');
      for (var i = 0; i < errors.length; i++) {
        var error = errors[i];
        if (error.closest && error.closest('.wbs-root')) continue;
        if (typeof isVisibleHealthNode === 'function' && !isVisibleHealthNode(error)) continue;
        if (error.offsetParent === null && !(error.getBoundingClientRect && error.getBoundingClientRect().width)) continue;
        var text = (error.textContent || '').replace(/\s+/g, ' ').trim();
        if (text && /(错误|失败|重试|超时|限流|error|failed|retry|timeout|rate limit)/i.test(text)) return true;
      }
      return false;
    }

    function acLooksTruncated(text) {
      var t = String(text || '').replace(/[ \t\r\n\f\v\u00A0]+$/, '');
      // Punctuation alone is not interruption evidence: a normal answer may end in
      // a comma/colon while introducing a list. Keep only explicit continuation
      // language and ellipsis, which are useful fallback signals when error UI is absent.
      return /(\.\.\.|…|正在$|等待$|调用$|执行$|结果如下[:：]?$)/.test(t);
    }

    function acReplyDecision(row, content, text) {
      return classifyAutoContinueReply({
        observed: !!text,
        hasCompletionActions: acHasCompletionActions(row),
        completionMarker: acHasMarker(text),
        error: acHasErrorSignal(row),
        looksTruncated: acLooksTruncated(text),
      });
    }

    /** 忙碌判定：仅匹配"停止生成"类精确信号（宽泛 stop/loading 会命中 _loadingWithCredit 等常驻元素，导致永不发送）；
     *  只认「可见 + 未隐藏 + 未禁用」的元素，避免把隐藏残留的停止按钮误判为忙碌 */
    function acIsBusyEl(sessionRoot) {
      if (!sessionRoot) return null;
      // querySelectorAll 遍历：跳过隐藏/aria-hidden/disabled 的匹配元素，返回第一个真实有效的停止信号
      var els = sessionRoot.querySelectorAll(
        '[aria-label*="停止"],[title*="停止"],[class*="stopGenerate"],[class*="StopGenerate"],' +
        '[class*="stopButton"],[class*="StopButton"],[class*="stopEmit"],[class*="_generating"],[class*="_Generating"]'
      );
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (el.offsetParent === null) continue;                 // 不可见（display:none / 已卸载区域）
        if (el.getAttribute('aria-hidden') === 'true') continue; // 对辅助技术隐藏
        if (el.hasAttribute('disabled') || el.disabled) continue; // 禁用态不算工作中
        return el;
      }
      return null;
    }
    function acIsBusy(sessionRoot) {
      return !!acIsBusyEl(sessionRoot);
    }

    /** 定位输入框：优先 textarea，其次 contenteditable；必须可见 */
    function acFindComposer(sessionRoot) {
      if (!sessionRoot) return null;
      var ta = sessionRoot.querySelector('textarea');
      if (ta && ta.offsetParent !== null) return { el: ta, type: 'textarea' };
      var ce = sessionRoot.querySelector('[contenteditable="true"]');
      if (ce && ce.offsetParent !== null) return { el: ce, type: 'contenteditable' };
      return null;
    }
    function acComposerText(composer) {
      if (!composer) return '';
      if (composer.type === 'textarea') return composer.el.value || '';
      // contenteditable（Slate）：克隆后剔除 data-slate-placeholder 占位节点，避免空态误判为"有内容"
      try {
        var clone = composer.el.cloneNode(true);
        var ph = clone.querySelectorAll('[data-slate-placeholder]');
        for (var i = 0; i < ph.length; i++) { var p = ph[i]; if (p.parentNode) p.parentNode.removeChild(p); }
        return clone.textContent || '';
      } catch (e) { return composer.el.textContent || ''; }
    }

    /** 定位发送按钮：最后一个可见、带 send/发送 语义的按钮 */
    function acFindSendButton(sessionRoot) {
      if (!sessionRoot) return null;
      var btns = sessionRoot.querySelectorAll('button');
      var last = null;
      for (var i = 0; i < btns.length; i++) {
        var b = btns[i];
        if (b.offsetParent === null) continue;
        var aria = (b.getAttribute('aria-label') || '').toLowerCase();
        var title = (b.getAttribute('title') || '').toLowerCase();
        var cls = typeof b.className === 'string' ? b.className : '';
        if (/send|发送/.test(aria) || /send|发送/.test(title) || /\bsend\b/i.test(cls)) last = b;
      }
      return last;
    }

    /** 写入输入框（React 合成事件需 native setter；contenteditable/Slate 用插入文本） */
    function acSetValue(composer, text) {
      if (!composer) return;
      if (composer.type === 'textarea') {
        var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        try { setter.call(composer.el, text); } catch (e) { composer.el.value = text; }
        composer.el.dispatchEvent(new Event('input', { bubbles: true }));
        composer.el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        try {
          composer.el.focus();
          var sel = window.getSelection();
          var range = document.createRange();
          range.selectNodeContents(composer.el);
          sel.removeAllRanges();
          sel.addRange(range);
          document.execCommand('delete'); // 先清空（含占位符），避免插入内容与占位文本堆叠
          document.execCommand('insertText', false, text);
          composer.el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
        } catch (e) {}
      }
    }
    function acPressEnter(el) {
      try {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      } catch (e) {}
    }

    /** 官方 assistant 消息 ID：.cb-assistant-message 的 data-message-request-id；取不到返回 null。
     *  用于 baseline 解锁/切换识别——只认官方 ID，绝不回退文本签名（文本变化不得视为新回复） */
    function acAssistantMsgId(content) {
      if (!content) return null;
      try {
        var row = content.closest ? content.closest('.cb-assistant-message') : null;
        var mid = row && row.getAttribute('data-message-request-id');
        return mid || null;
      } catch (e) { return null; }
    }

    /** 消息稳定签名：正文规范化文本截断——DOM 虚拟列表重建后签名不变，可稳定判重（judgedMessages 用签名而非节点引用） */
    function acMsgSignature(content) {
      if (!content) return '';
      try {
        // 优先使用官方稳定消息 ID（.cb-assistant-message 的 data-message-request-id）：
        // 唯一、不碰撞、虚拟列表重建后属性仍在；重新生成会换新 ID = 重新判定，语义正确
        var row = content.closest ? content.closest('.cb-assistant-message') : null;
        var mid = row && row.getAttribute('data-message-request-id');
        if (mid) return 'id:' + mid;
        // 回退（无 ID 的旧 DOM）：len + 前96 + 后96，防模板前缀碰撞
        var body = acPickBodyBlock(content) || content;
        var t = (body.textContent || '').replace(/\s+/g, ' ').trim();
        if (!t) return '';
        return t.length + ':' + t.slice(0, 96) + ':' + t.slice(-96);
      } catch (e) { return ''; }
    }

    /** 用户消息快照（发送前后对比，作为真实发送证据） */
    function acUserMsgSnapshot(sessionRoot) {
      try {
        // 用户消息稳定 ID：.cb-user-message 外层 id="user-message-<uuid>"（官方唯一，比数量/文本更可靠）
        var ms = sessionRoot.querySelectorAll('.cb-user-message[id], [id^="user-message-"]');
        if (!ms.length) ms = sessionRoot.querySelectorAll('.cb-user-message, [class*="_userMessage_"]');
        var text = '';
        var lastId = '';
        var ids = [];
        for (var qi = 0; qi < ms.length; qi++) {
          var idv = ms[qi].getAttribute('id');
          if (idv) ids.push(idv);
        }
        if (ms.length) {
          var last = ms[ms.length - 1];
          lastId = last.getAttribute('id') || '';
          var pick = last.querySelector('[class*="_userMessageText_"]') || last;
          text = (pick.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
        }
        return { count: ms.length, last: text, lastId: lastId, ids: ids };
      } catch (e) { return null; }
    }

    function acControllerComposerEmpty() {
      var editor = findComposer();
      if (!editor) return true; // controller 直发不依赖 DOM；无 editor 时不阻塞
      try { return !composerHasContent(editor); } catch (e) { return false; }
    }

    /** 优先走 ConversationController.sendPrompt：同一层接口同时服务 WorkBuddy/WorkBuddy AI，
     *  不依赖输入框 DOM 与 CDP。只有控制器缺失/调用失败时才回退旧发送链。 */
    function acSendViaController(gen, controller, assistantId) {
      if (gen !== acCtx.generation || !controller || typeof controller.sendPrompt !== 'function') return false;
      var activeId = acActiveConversationId();
      if (activeId && String(activeId) !== String(controller.conversationId || '')) {
        acLog('controller-send-session-mismatch', { activeId: activeId, controllerId: controller.conversationId || '' });
        acStartMonitor();
        return true;
      }
      var view;
      try { view = controller.getSessionViewState(); } catch (e) { return false; }
      if (!view || view.isBusy || view.isRunActive || view.isTurnActive || view.isPending || view.isSending) {
        acLog('controller-send-busy-skip', { assistantId: assistantId || '', state: view && view.state });
        return true;
      }
      if (!acControllerComposerEmpty()) {
        acLog('composer-busy-abandon');
        acWeak('输入框非空，已放弃自动发送，避免覆盖你的输入');
        return true;
      }
      toast('检测到会话异常中断，即将自动发送「' + AC_CONTINUE_TEXT + '」', false, root);
      acLog('controller-send-call', { assistantId: assistantId || '' });
      var sendPromise;
      try {
        sendPromise = controller.sendPrompt({ blocks: [{ type: 'text', text: AC_CONTINUE_TEXT }] }, {
          _meta: { 'codebuddy.ai': { source: 'workdaddy-auto-continue' } },
        });
      } catch (e) {
        acLog('controller-send-throw', { err: (e && e.message) || '?' });
        acWeak('底层发送失败，请手动发送');
        return true;
      }
      Promise.resolve(sendPromise).then(function (result) {
        if (gen !== acCtx.generation) return;
        if (result && result.ok === false) throw new Error((result.error && result.error.message) || 'controller-send-rejected');
        acLog('controller-send-ok', { assistantId: assistantId || '' });
        acWeak('已发送「' + AC_CONTINUE_TEXT + '」');
      }).catch(function (e) {
        if (gen !== acCtx.generation) return;
        // Promise 拒绝不代表底层一定未接受请求；自动二次走 DOM/CDP 可能重复发送。
        // 保守停止并提示人工确认，只有 controller 本身完全不存在时才使用旧发送链。
        acLog('controller-send-unconfirmed', { err: (e && e.message) || '?' });
        acWeak('底层发送结果未确认，为避免重复消息已停止重试，请检查会话');
      });
      return true;
    }

    /** 发送主流程：检测到异常中断先 toast 预告，记录发送前用户消息快照，然后发送固定文案 */
    function acSendContinue(gen, sessionRoot, activeMessage, skipController) {
      if (gen !== acCtx.generation) return;
      if (!skipController && acSendViaController(gen, acCtx.controller, activeMessage && acAssistantMsgId(activeMessage))) return;
      if (!sessionRoot || !document.body.contains(sessionRoot)) return;
      if (!activeMessage || !document.body.contains(activeMessage)) return;
      var composer = acFindComposer(sessionRoot);
      if (!composer) { acLog('no-composer'); acWeak('未找到输入框'); return; }
      if (acIsBusy(sessionRoot)) {
        var busyEl = acIsBusyEl(sessionRoot);
        acLog('busy-skip', { el: busyEl ? String(busyEl.className).slice(0, 50) : '?' });
        return; // 仍在生成：不提示不发送
      }
      toast('检测到会话异常中断，即将自动发送「' + AC_CONTINUE_TEXT + '」', false, root);
      acLog('toast-shown', { gen: gen, composer: composer.type });
      // 局部发送上下文（快照+会话签名+generation）：贯穿本次发送与验证，防并发发送互相覆盖、防切会话误证
      var sendCtx = {
        snap: acUserMsgSnapshot(sessionRoot),
        sig: acSessionSig(sessionRoot),
        gen: gen,
      };
      var txt = acComposerText(composer).trim();
      if (txt !== '') {
        // 用户正在输入：轮询最多 2s 等待清空，仍非空则放弃，绝不覆盖用户内容
        var waitUntil = Date.now() + 2000;
        (function tryWait() {
          if (gen !== acCtx.generation) return;
          if (!acComposerText(composer).trim()) { acDoSend(gen, sessionRoot, composer, 0, sendCtx); return; }
          if (Date.now() < waitUntil) { setTimeout(tryWait, 200); return; }
          acLog('composer-busy-abandon');
          acWeak('输入框非空，已放弃自动发送，避免覆盖你的输入');
        })();
      } else {
        acDoSend(gen, sessionRoot, composer, 0, sendCtx);
      }
    }
    /** 发送：统一走 daemon CDP 真实输入（聚焦→全选→插入「如果未完成，继续执行；已完成则回复"已完成"」→真实 Enter，isTrusted Slate 必然响应）。
     *  CDP 失败才兜底：按钮可用（存在且未禁用）则先写入固定文案再点按钮；最后手段为本地模拟填写+合成 Enter。 */
    function acDoSend(gen, sessionRoot, composer, attempt, sendCtx) {
      if (gen !== acCtx.generation) return;
      acLog('send-cdp-call', { attempt: attempt });
      api('/api/auto-continue-send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }).then(function (d) {
        if (gen !== acCtx.generation) return;
        if (!d || !d.ok) throw new Error((d && d.error) || 'cdp-send-failed');
        acLog('cdp-send-ok');
        acVerifySent(gen, sessionRoot, composer, attempt, sendCtx);
      }).catch(function (e) {
        if (gen !== acCtx.generation) return;
        acLog('cdp-send-fail-fallback', { err: (e && e.message) || '?' });
        var btn = acFindSendButton(sessionRoot);
        if (btn && !btn.disabled && !btn.hasAttribute('disabled') && btn.getAttribute('aria-disabled') !== 'true') {
          // 兜底点按钮前必须先写入固定文案（空输入框点发送 = 什么都没发）
          acSetValue(composer, AC_CONTINUE_TEXT);
          setTimeout(function () {
            if (gen !== acCtx.generation) return;
            acLog('send-btn-click', { attempt: attempt });
            btn.click();
            acVerifySent(gen, sessionRoot, composer, attempt, sendCtx);
          }, 80);
          return;
        }
        acSetValue(composer, AC_CONTINUE_TEXT);
        setTimeout(function () {
          if (gen !== acCtx.generation) return;
          acLog('send-synthetic-enter', { attempt: attempt });
          acPressEnter(composer.el);
          acVerifySent(gen, sessionRoot, composer, attempt, sendCtx);
        }, 100);
      });
    }
    /** 发送结果验证：必须观测到真实发送证据——用户消息数增加，或末条文本变化且包含固定文案。
     *  仅凭「输入框清空」不算成功（空输入框点发送=没发也清空）；证据缺失则重试，超时按失败汇报。 */
    function acVerifySent(gen, sessionRoot, composer, attempt, sendCtx) {
      var before = sendCtx && sendCtx.snap;
      if (!before) { acLog('send-no-snapshot'); return; }
      var pollAt = Date.now();
      (function poll() {
        if (gen !== acCtx.generation) return;
        // 验证期间会话切换：本发送上下文已失效，立即终止——不重试、不提示成功（防把新会话消息误当证据）
        if (sendCtx && sendCtx.sig && acSessionSig(sessionRoot) !== sendCtx.sig) {
          acLog('send-abort-session-switch');
          return;
        }
        if (attempt >= AC_MAX_SEND_ATTEMPTS) { acLog('send-failed-attempts', { attempt: attempt }); acWeak('自动发送失败，请手动点击发送'); return; }
        var snap = acUserMsgSnapshot(sessionRoot);
        // 新消息 ID 证据：snap 可能为 null（DOM 异常）；空 ID（降级 DOM 无官方 id）不得当新 ID——
        // 必须 snap/lastId/ids 三者齐全且非空，且 lastId 不在发送前 id 集中
        var newId = !!(snap && snap.lastId && before && Array.isArray(before.ids) &&
          before.ids.length && snap.lastId && before.ids.indexOf(snap.lastId) < 0);
        var fresh = snap && before && snap.last &&
          snap.last.indexOf('如果未完成，继续执行；已完成则回复"已完成"') >= 0 &&
          (newId || snap.count > before.count || (before.last && snap.last !== before.last));
        if (fresh) { // 真实证据：出现了包含固定文案的新用户消息
          acLog('send-verified-ok', { attempt: attempt, count: snap.count });
          acWeak('已发送「如果未完成，继续执行；已完成则回复"已完成"」');
          return;
        }
        if (Date.now() - pollAt > 7000) {
          if (!acComposerText(composer).trim()) {
            // 输入框已空但证据未到：很大可能是发送成功、WorkBuddy 渲染延迟 → 延长观察窗口，绝不重发（防重复消息）
            acLog('send-wait-evidence', { ms: Date.now() - pollAt });
            if (Date.now() - pollAt > 15000) {
              // 无 sent 证据绝不能呈现为成功：提示未确认结果、已停止重试（避免重复消息）
              acLog('send-evidence-timeout', { attempt: attempt });
              acWeak('未能确认自动发送结果，请检查会话；为避免重复消息，已停止重试');
              return;
            }
            setTimeout(poll, 1000);
            return;
          }
          // composer 仍非空 = 确实没发出去 → 重试
          acLog('send-retry', { attempt: attempt, count: snap && snap.count });
          acDoSend(gen, sessionRoot, composer, attempt + 1, sendCtx);
          return;
        }
        setTimeout(poll, 500);
      })();
    }

    /** 该消息是否为「用户主动取消」：内容容器带 cb-user-cancelled-indicator → 不发送继续，仅记日志 */
    function acUserCancelled(row) {
      return !!row && !!row.querySelector('[class*="user-cancelled-indicator"],[class*="UserCancelled"]');
    }

    /** 从 React fiber 上找当前 ConversationController。只依赖稳定能力形状，不依赖类名/hash；
     * WorkBuddy 与 WorkBuddy AI 若采用同一 controller 均走此路径。 */
    function acFindConversationController() {
      try {
        var activeId = acActiveConversationId();
        var roots = [
          activeId ? document.querySelector('.cr-document[data-root-id="' + String(activeId).replace(/"/g, '\\"') + '"]') : null,
          document.querySelector('.conversation-shell'),
          document.querySelector('.chat-container'),
          document.querySelector('#root > div'),
        ].filter(Boolean);
        var fallback = null;
        for (var ri = 0; ri < roots.length; ri++) {
          var stack = [roots[ri]], guard = 0;
          while (stack.length && guard++ < 450) {
            var el = stack.pop();
            if (!el) continue;
            for (var key in el) {
              if (key.indexOf('__reactFiber$') !== 0 && key.indexOf('__reactInternalInstance') !== 0) continue;
              var cur = el[key], seen = 0;
              while (cur && seen++ < 650) {
                var props = cur.memoizedProps;
                var controller = props && props.value;
                if (controller && controller.conversationId && controller.messageStore && controller.sessionStore &&
                    typeof controller.getSessionViewState === 'function' && typeof controller.getMessagesViewState === 'function') {
                  if (!fallback) fallback = controller;
                  if (!activeId || String(controller.conversationId) === String(activeId)) return controller;
                }
                cur = cur.return;
              }
              break;
            }
            var children = el.children || [];
            for (var ci = 0; ci < children.length; ci++) stack.push(children[ci]);
          }
        }
        // 已知 activeId 时绝不返回其他会话的 fallback controller，避免切换会话后绑定/发送到旧会话。
        return activeId ? null : fallback;
      } catch (e) { return null; }
    }

    function acControllerSnapshot(controller) {
      if (!controller) return null;
      try {
        var session = controller.getSessionViewState();
        var messageState = controller.messageStore.getState();
        var assistant = selectAutoContinueAssistant(messageState);
        var errorView = typeof controller.getErrorViewState === 'function' ? controller.getErrorViewState() : {};
        var sessionState = controller.sessionStore.getState();
        var error = sessionState && sessionState.error;
        var warning = sessionState && sessionState.warning;
        var errText = [error && error.code, error && error.message, warning && warning.code, warning && warning.message].filter(Boolean).join(' ');
        var text = autoContinueMessageText(assistant);
        var extra = assistant && assistant.extra || {};
        return {
          conversationId: String(controller.conversationId || ''),
          version: Number(messageState.version || 0),
          assistant: assistant,
          assistantId: assistant && String(assistant.id || assistant.requestId || ''),
          text: text,
          complete: !!(assistant && assistant.complete === true),
          terminalKnown: Object.prototype.hasOwnProperty.call(extra, 'isRequestTerminal'),
          terminal: !!(assistant && extra.isRequestTerminal === true),
          manualStop: !!extra.isCancelled,
          error: !!error || !!(errorView && (errorView.error || errorView.hasError)),
          networkFailure: /network|offline|timeout|connection|网络|离线|超时|连接/i.test(errText),
          blocked: !!(session && (session.isPending || session.state === 'pending')),
          busy: !!(session && (session.isBusy || session.isRunActive || session.isTurnActive || session.isSending || session.isPending)) ||
            !!messageState.streamingRequestId || !!messageState.streamingMessageId,
          hydrating: !!(session && (session.isHydrating || (session.viewHistoryRestorePhase && session.viewHistoryRestorePhase !== 'idle'))),
          state: session && session.state,
          phase: session && session.agentPhase,
        };
      } catch (e) {
        acLogR('controller-snapshot-error', 'controller-snapshot-error', { err: (e && e.message) || '?' }, 3000);
        return null;
      }
    }

    function acControllerCheck() {
      var c = acCtx;
      var gen = c.generation;
      var snap = acControllerSnapshot(c.controller);
      if (!snap || !snap.conversationId) return;
      var sig = 'conversation:' + snap.conversationId;
      var activeId = acActiveConversationId();
      if (sig !== c.sessionSig || (activeId && String(activeId) !== String(snap.conversationId))) {
        acStartMonitor();
        return;
      }
      if (snap.hydrating) {
        c.controllerLastVersion = snap.version;
        c.baselineAssistantKey = snap.assistantId || '';
        c.awaitingNewReply = true;
        c.controllerIdleAt = 0;
        acLogR('controller-hydrating', 'controller-hydrating', { id: snap.conversationId, assistantId: snap.assistantId }, 3000);
        return;
      }
      if (snap.version !== c.controllerLastVersion) {
        c.controllerLastVersion = snap.version;
        c.lastMutationAt = Date.now();
        if (!snap.busy) c.controllerIdleAt = Date.now();
      }
      if (snap.busy) {
        if (!c.controllerLastBusy) acLog('controller-running', { id: snap.assistantId, state: snap.state, phase: snap.phase });
        c.controllerLastBusy = true;
        c.controllerIdleAt = 0;
        return;
      }
      if (c.controllerLastBusy || !c.controllerIdleAt) c.controllerIdleAt = Date.now();
      c.controllerLastBusy = false;
      if (!snap.assistantId) return;
      if (snap.blocked || findBlockingPrompt()) {
        acLogR('controller-blocked', 'controller-blocked', { id: snap.assistantId, state: snap.state }, 3000);
        return;
      }
      if (c.awaitingNewReply) {
        if (!snap.assistantId || snap.assistantId === c.baselineAssistantKey) return;
        c.awaitingNewReply = false;
        c.baselineAssistantKey = snap.assistantId;
        c.controllerIdleAt = Date.now();
        acLog('controller-new-reply', { id: snap.assistantId, version: snap.version });
      }
      var signature = 'id:' + snap.assistantId;
      if (c.judgedMessages.has(signature)) return;
      var idleFor = Date.now() - c.controllerIdleAt;
      var controllerCompleted = autoContinueControllerCompleted(snap);
      // 明确 terminal（或旧版无 terminal 字段时的 complete）是可靠终局，可立即判定；错误也只需短缓冲；
      // 其余 incomplete 空闲等待 8 秒，避免 state 与最后一个消息 chunk 存在极短时序差。
      if (!controllerCompleted && !snap.error && idleFor < AC_CONTROLLER_SETTLE_MS) {
        acScheduleSettle(Math.max(250, AC_CONTROLLER_SETTLE_MS - idleFor));
        return;
      }
      var decision = classifyAutoContinueControllerSnapshot({
        assistantId: snap.assistantId,
        busy: snap.busy,
        manualStop: snap.manualStop,
        error: snap.error,
        networkFailure: snap.networkFailure,
        completionMarker: acHasMarker(snap.text),
        // 新版明确暴露 isRequestTerminal 时只认该字段；旧版没有该字段才退回 complete。
        complete: snap.terminalKnown ? false : snap.complete,
        terminal: snap.terminal,
      });
      c.judgedMessages.add(signature);
      if (!decision.trigger) {
        acLog('controller-completed', { id: snap.assistantId, reason: decision.reason, complete: snap.complete, terminal: snap.terminal });
        return;
      }
      if (snap.manualStop) { acLog('controller-user-cancelled-skip', { id: snap.assistantId }); return; }
      acLog('controller-trigger', { id: snap.assistantId, reason: decision.reason, state: snap.state, idleForMs: idleFor });
      acSendViaController(gen, c.controller, snap.assistantId);
    }

    function acBindController(controller, carry) {
      var c = acCtx;
      if (!controller) return false;
      var snap = acControllerSnapshot(controller);
      if (!snap || !snap.conversationId) return false;
      var preserve = carry && String(carry.conversationId || '') === String(snap.conversationId);
      c.controller = controller;
      c.sessionSig = 'conversation:' + snap.conversationId;
      c.controllerLastVersion = snap.version;
      c.controllerLastBusy = snap.busy;
      c.controllerIdleAt = snap.busy ? 0 : Date.now();
      c.baselineAssistantKey = preserve ? String(carry.baselineAssistantKey || '') : (snap.assistantId || '');
      c.awaitingNewReply = preserve ? !!carry.awaitingNewReply : true;
      c.judgedMessages = new Set(preserve && Array.isArray(carry.judgedMessages) ? carry.judgedMessages : []);
      c.controllerUnsubs = [];
      var notify = function () {
        if (!acRunning || controller !== acCtx.controller) return;
        try { acControllerCheck(); } catch (e) {}
      };
      try { c.controllerUnsubs.push(controller.sessionStore.subscribe(notify)); } catch (e) {}
      try { c.controllerUnsubs.push(controller.messageStore.subscribe(notify)); } catch (e) {}
      acLog('controller-monitor-start', { id: snap.conversationId, assistantId: snap.assistantId, busy: snap.busy, version: snap.version });
      acLog('baseline-established', { via: 'controller', awaitingNewReply: true });
      acStartStatusAnim();
      return true;
    }

    /** 判定：feedback 终局信号出现（经稳定缓冲）后检查正文末尾完成标记；无标记且非用户取消 = 异常 → 触发。
     *  兜底：feedback 一直未出现（选择器失效）时，消息静默超 AC_IDLE_FALLBACK_MS 也判定一次 */
    function acSettleCheck() {
      if (acCtx.controller) { acControllerCheck(); return; }
      var c = acCtx;
      var gen = c.generation;
      if (!c.sessionRoot || !document.body.contains(c.sessionRoot)) { acLog('settle-root-gone'); return; }
      // 静默期间会话切换 → 重校准基准，绝不触发旧会话的判定
      var sigNow = acSessionSig(c.sessionRoot);
      if (!sigNow) { acLog('settle-no-id-skip'); return; } // 官方会话 ID 取不到：保守不判定
      if (sigNow !== c.sessionSig) {
        // 与 acOnMutation 切换分支一致的「统一建立 baseline」：清 timer + 记会话 ID + 记最后 assistant ID + 等待新回复
        if (c.settleTimer) { clearTimeout(c.settleTimer); c.settleTimer = null; }
        var st0 = acSnapshot(c.sessionRoot);
        c.sessionSig = sigNow;
        c.lastMsgCount = st0.count;
        c.lastActiveTxt = st0.content ? (st0.content.textContent || '') : '';
        c.activeMessage = st0.content || null;
        c.judgedMessages = new Set();
        c.feedbackSeen = false;
        c.feedbackAt = 0;
        c.lastMutationAt = Date.now();
        c.baselineAssistantKey = acAssistantMsgId(st0.content) || '';
        c.awaitingNewReply = true;
        acLog('settle-session-switch', { count: st0.count });
        acLog('baseline-established', { via: 'settle' });
        return;
      }
      var stat = acSnapshot(c.sessionRoot);
      if (!stat.content || !stat.row) { acLog('settle-no-content', { count: stat.count }); return; }
      // baseline 等待期兜底：即使旧 timer 未取消成功，只要仍在等待新回复且当前仍是 baseline → 直接返回，绝不判定/发送
      if (c.awaitingNewReply) {
        var keyNow = acAssistantMsgId(stat.content);
        if (!keyNow || keyNow === c.baselineAssistantKey) {
          acLog('settle-baseline-wait', { count: stat.count });
          return;
        }
        // key 变化 = 第一条新回复已出现 → 解除等待继续正常判定
        c.awaitingNewReply = false;
        c.baselineAssistantKey = keyNow;
        c.lastMutationAt = Date.now();
        c.feedbackSeen = false;
        c.feedbackAt = 0;
        acLog('settle-baseline-released', { count: stat.count });
      }
      if (stat.count > c.lastMsgCount) { // 判定期间出现新回复 → 回到新回复流程
        c.lastMsgCount = stat.count;
        c.lastMutationAt = Date.now();
        c.activeMessage = stat.content;
        c.feedbackSeen = false;
        c.feedbackAt = 0;
        acLog('settle-recount-new', { count: stat.count });
        acScheduleSettle(0);
        return;
      }
      if (c.judgedMessages.has(acMsgSignature(stat.content))) { acLog('settle-already-judged', { count: stat.count }); return; }
      var fb = !!stat.row.querySelector('[class*="assistantFeedback"]');
      if (fb && !c.feedbackSeen) { c.feedbackSeen = true; c.feedbackAt = Date.now(); acLog('feedback-seen-settle', { count: stat.count }); }
      var mutAge = Date.now() - c.lastMutationAt;
      if (fb) {
        // feedback 已出现但还在稳定渲染 → 再等
        if (Date.now() - c.feedbackAt < AC_FB_SETTLE_MS) { acScheduleSettle(AC_SETTLE_MS); return; }
        c.judgedMessages.add(acMsgSignature(stat.content));
        var body = acPickBodyBlock(stat.content);
        var text = body ? (body.textContent || '') : '';
        if (!text.trim()) { acLog('settle-empty-body', { count: stat.count }); return; }
        var decision = acReplyDecision(stat.row, stat.content, text);
        if (!decision.trigger) { acLog('settle-completed', { reason: decision.reason, tail: text.slice(-24) }); return; }
        // 明确异常证据仍需排除用户手动取消（取消 = 有意终止，不自动继续，仅留痕）
        if (acUserCancelled(stat.row)) { acLog('user-cancelled-skip', { via: 'feedback', count: stat.count }); return; }
        acLog('trigger', { via: 'feedback', reason: decision.reason, count: stat.count, tail: text.slice(-40) });
        acSendContinue(gen, c.sessionRoot, stat.content);
        return;
      }
      // 无 feedback：静默超兜底时长才判定（避开多工具调用之间的停顿；正常结束都会渲染 feedback）
      if (mutAge >= AC_IDLE_FALLBACK_MS) {
        // AI 仍在工作中（工具执行/生成中，停止按钮在 DOM）→ 不是中断：重置静默计时继续等，绝不误触发
        if (acIsBusy(c.sessionRoot)) {
          c.lastMutationAt = Date.now();
          acLog('busy-skip-at-fallback', { count: stat.count, mutAgeMs: mutAge });
          acScheduleSettle(AC_IDLE_FALLBACK_MS);
          return;
        }
        c.judgedMessages.add(acMsgSignature(stat.content));
        var body2 = acPickBodyBlock(stat.content);
        var text2 = body2 ? (body2.textContent || '') : '';
        if (!text2.trim()) return;
        var decision2 = acReplyDecision(stat.row, stat.content, text2);
        if (!decision2.trigger) { acLog('settle-completed-fallback', { reason: decision2.reason }); return; }
        if (acUserCancelled(stat.row)) { acLog('user-cancelled-skip', { via: 'idle-fallback', count: stat.count, mutAgeMs: mutAge }); return; }
        acLog('trigger', { via: 'idle-fallback', reason: decision2.reason, count: stat.count, mutAgeMs: mutAge, tail: text2.slice(-40) });
        acSendContinue(gen, c.sessionRoot, stat.content);
        return;
      }
      acLogR('settle-waiting', 'settle-waiting', { count: stat.count, fb: fb, mutAgeMs: mutAge }, 3000);
      acScheduleSettle(AC_SETTLE_MS);
    }
    function acScheduleSettle(delay) {
      var c = acCtx;
      if (c.settleTimer) clearTimeout(c.settleTimer);
      var ms = (typeof delay === 'number' && delay >= 0) ? delay : AC_SETTLE_MS;
      c.settleTimer = setTimeout(function () {
        c.settleTimer = null;
        try { acSettleCheck(); } catch (e) {}
      }, ms);
    }

    /** Auto-Continue 专用的「当前激活会话 ID」：优先级 adapter.currentActiveSessionId（官方，最可靠）
     *  → URL 参数 conversationId/conversation_id → active/aria-selected=true 的官方 data-conversation-id。
     *  全部取不到返回 ''；绝不回退到任意会话、标题或文本（共享的 getConversationId 有任意会话兜底，本模块不用） */
    function acActiveConversationId() {
      try {
        var a = window.__wbsAdapter;
        if (a && a.currentActiveSessionId) return a.currentActiveSessionId;
      } catch (e) {}
      try {
        var u = new URL(location.href);
        var q = u.searchParams.get('conversationId') || u.searchParams.get('conversation_id');
        if (q) return q;
      } catch (e) {}
      try {
        var sel = document.querySelector(
          '[data-conversation-id].active,[data-conversation-id][aria-selected="true"],' +
          '[class*="conversation"][class*="active"],[data-conversation-id][class*="active"]'
        );
        var id = sel && (sel.getAttribute('data-conversation-id') || sel.getAttribute('data-id'));
        if (id) return id;
      } catch (e) {}
      return '';
    }

    /** 会话身份签名：当前激活会话的官方 conversation ID（adapter 优先，其次 URL 参数 / active 的 data-conversation-id）。
     *  取不到返回 '' → 调用方保守跳过判定（绝不回退任意会话/标题/文本） */
    function acSessionSig(sessionRoot) {
      try {
        var id = acActiveConversationId();
        return id ? 'conversation:' + id : '';
      } catch (e) { return ''; }
    }

    /** 观察快照：最后一条助手消息「行」与内容容器 + 消息总数 */
    function acSnapshot(sessionRoot) {
      var msgs = sessionRoot.querySelectorAll('.cb-assistant-message');
      var count = msgs ? msgs.length : 0;
      var row = null, content = null;
      if (count) {
        row = msgs[count - 1];
        content = row.querySelector('[class*="assistantMessageContent"]') || row;
      }
      return { row: row, content: content, count: count };
    }

    /** observer 回调：会话身份变化 → 建立新 baseline 并等待新回复（绝不判定历史消息）；
     *  计数增加或消息 key 变化 → 解除等待进入新回复流；feedback/文本变化仅在非等待期判定 */
    function acOnMutation() {
      var c = acCtx;
      if (!c.sessionRoot || !document.body.contains(c.sessionRoot)) return;
      var stat = acSnapshot(c.sessionRoot);
      var content = stat.content;
      if (!content || !content.parentNode) return;
      var txt = content.textContent || '';
      var sig = acSessionSig(c.sessionRoot);
      if (!sig) { acLog('session-id-idle-skip'); return; } // 官方会话 ID 取不到：保守，不做任何判定
      // 会话切换（新会话/切回）：取消旧 timer，建立新 baseline，等待新回复
      if (sig !== c.sessionSig) {
        if (c.settleTimer) { clearTimeout(c.settleTimer); c.settleTimer = null; }
        c.sessionSig = sig;
        c.lastMsgCount = stat.count;
        c.lastActiveTxt = txt;
        c.activeMessage = content;
        c.judgedMessages = new Set();
        c.feedbackSeen = false;
        c.feedbackAt = 0;
        c.lastMutationAt = Date.now();
        // 切换后的最后一条已有消息 = 历史 baseline，绝不判定；只有新回复出现才解除
        c.baselineAssistantKey = acAssistantMsgId(content) || '';
        c.awaitingNewReply = true;
        acLog('session-switch', { count: stat.count, txtLen: txt.length, sig: sig });
        acLog('baseline-established', { awaitingNewReply: true });
        return;
      }
      if (stat.count > c.lastMsgCount) {
        if (c.awaitingNewReply) {
          // awaiting 期间数量增加（虚拟列表重挂/历史回放/重排都可能造成）：只刷新基准计数作观察日志，
          // 绝不单独解锁——继续落入下方官方 assistant ID 门控，由 ID 决定是否解除等待
          c.lastMsgCount = stat.count;
          c.lastActiveTxt = txt;
          acLog('count-grow-awaiting', { count: stat.count });
          // fall through → awaiting 门控
        } else {
          // 正常判定流中出现新回复（内容开始流式输出）
          c.lastMsgCount = stat.count;
          c.activeMessage = content;
          c.lastActiveTxt = txt;
          c.lastMutationAt = Date.now();
          c.feedbackSeen = false;
          c.feedbackAt = 0;
          acLog('new-reply', { count: stat.count, txtLen: txt.length, tail: txt.slice(-24) });
          acScheduleSettle();
          return;
        }
      }
      if (stat.count < c.lastMsgCount) { // 消息被删除/回滚 → 校准基准；保留 judgedMessages（7→6→7 时旧消息不重复判定），重置 feedback/计时
        c.lastMsgCount = stat.count;
        c.lastActiveTxt = txt;
        c.activeMessage = content;
        c.feedbackSeen = false;
        c.feedbackAt = 0;
        c.lastMutationAt = Date.now();
        acLogR('count-shrink', 'count-shrink', { count: stat.count }, 2000);
        return;
      }
      // 等待新回复门控：等待期唯一解锁依据 = 官方 assistant ID 变化（数量增加只刷新基准观察日志，不单独解锁）；
      // 历史消息出现 feedback/文本变化/重排 一律不解除、不安排判定
      if (c.awaitingNewReply) {
        // 解锁只认官方 assistant ID（data-message-request-id）；无官方 ID（null）或 ID 仍等于 baseline → 保守继续等待
        var keyNow = acAssistantMsgId(content);
        if (keyNow && keyNow !== c.baselineAssistantKey) {
          c.baselineAssistantKey = keyNow;
          c.awaitingNewReply = false;
          c.activeMessage = content;
          c.lastActiveTxt = txt;
          c.lastMutationAt = Date.now();
          c.feedbackSeen = false;
          c.feedbackAt = 0;
          acLog('new-reply', { count: stat.count, via: 'key-change', txtLen: txt.length });
          acScheduleSettle();
          return;
        }
        c.lastActiveTxt = txt; // baseline：只更新追踪，不判定
        return;
      }
      // 终局信号：消息行内出现 feedback 操作区（无论任务成败都会渲染）
      if (stat.row && stat.row.querySelector('[class*="assistantFeedback"]')) {
        if (!c.feedbackSeen) {
          c.feedbackSeen = true;
          c.feedbackAt = Date.now();
          c.lastMutationAt = c.feedbackAt;
          acLog('feedback-seen', { count: stat.count });
        }
        acScheduleSettle();
        return;
      }
      if (txt !== c.lastActiveTxt) { // 同一消息文本增长/变化 → 仅刷新计时
        var grew = txt.length > c.lastActiveTxt.length;
        c.lastActiveTxt = txt;
        c.lastMutationAt = Date.now();
        acLogR('mut:' + (grew ? 'grow' : 'change'), 'mut-' + (grew ? 'grow' : 'change'), { count: stat.count, txtLen: txt.length });
        acScheduleSettle();
      }
    }

    /** 启动监控：优先绑定 ConversationController stores；旧客户端找不到 controller 时才挂 DOM observer。 */
    function acStartLegacyMonitor() {
      var carry = acCtx.controller ? {
        conversationId: acCtx.controller.conversationId,
        baselineAssistantKey: acCtx.baselineAssistantKey,
        awaitingNewReply: acCtx.awaitingNewReply,
        judgedMessages: acCtx.judgedMessages ? Array.from(acCtx.judgedMessages) : [],
      } : null;
      acResetState(); // 使旧 generation 回调全部失效
      var c = acCtx;
      var gen = c.generation;
      // 心跳先行：controller/页面重挂载或会话切换后都能自动重绑
      if (c.heartbeat) clearInterval(c.heartbeat);
      c.heartbeat = setInterval(function () {
        if (!acRunning) return;
        if (c.controller) {
          var activeId = acActiveConversationId();
          var currentController = acFindConversationController();
          if ((activeId && String(activeId) !== String(c.controller.conversationId)) ||
              (currentController && currentController !== c.controller) ||
              !c.controller.sessionStore || !c.controller.messageStore) { acStartMonitor(); return; }
          acControllerCheck();
          return;
        }
        var root = c.sessionRoot;
        if (!root || !document.body.contains(root)) { acStartMonitor(); return; }
        if (acSessionSig(root) !== c.sessionSig) acOnMutation();
      }, AC_HEARTBEAT_MS);
      var controller = acFindConversationController();
      if (controller) {
        // 仅为 controller.sendPrompt 失败保留窄 DOM 发送兜底；监控与判定仍完全来自 stores。
        c.sessionRoot = document.querySelector('.chat-container') || document.querySelector('.conversation-shell');
        if (c.sessionRoot) {
          var fallbackStat = acSnapshot(c.sessionRoot);
          c.activeMessage = fallbackStat.content || null;
        }
      }
      if (acBindController(controller, carry)) return;
      var sessionRoot = document.querySelector('.chat-container') ||
        document.querySelector('.main-content--chat') ||
        document.querySelector('.main-content.main-content--chat') ||
        document.querySelector('.conversation-shell');
      if (!sessionRoot) { acWeak('会话控制器尚未就绪，稍后自动重试'); acLog('controller-retry-waiting'); return; }
      c.sessionRoot = sessionRoot;
      var stat = acSnapshot(sessionRoot);
      c.lastMsgCount = stat.count; // 当前已有消息计入基准；之后数量增加才视为新回复
      c.lastActiveTxt = stat.content ? (stat.content.textContent || '') : '';
      // baseline：监控开启时的最后一条已有助手消息绝不判定（awaitingNewReply 门控，等新回复出现才解除）
      c.baselineAssistantKey = acAssistantMsgId(stat.content) || '';
      c.awaitingNewReply = true;
      c.sessionSig = acSessionSig(sessionRoot);
      c.observer = new MutationObserver(function () { try { acOnMutation(); } catch (e) {} });
      c.observer.observe(sessionRoot, { childList: true, subtree: true, characterData: true });
      acLog('monitor-start', { count: c.lastMsgCount, gen: gen, sig: c.sessionSig });
      acLog('baseline-established', { awaitingNewReply: true });
      acStartStatusAnim(); // 开关开启期间持续显示「监控激活会话中…」
    }
    function acStopLegacyMonitor() {
      var c = acCtx;
      if (c.settleTimer) { clearTimeout(c.settleTimer); c.settleTimer = null; }
      if (c.observer) { try { c.observer.disconnect(); } catch (e) {} c.observer = null; }
      if (Array.isArray(c.controllerUnsubs)) {
        for (var ui = 0; ui < c.controllerUnsubs.length; ui++) {
          try { c.controllerUnsubs[ui](); } catch (e) {}
        }
      }
      c.controllerUnsubs = null;
      c.controller = null;
      if (c.heartbeat) { clearInterval(c.heartbeat); c.heartbeat = null; }
      c.generation++;
      acLog('monitor-stop', { gen: c.generation });
      acStopStatusAnim();
      c.sessionRoot = null;
      c.activeMessage = null;
      c.judgedMessages = null;
      c.baselineMessages = null;
    }

    function acMultiUpdateStatus(session, status, detail) {
      var count = Object.keys(acMulti.sessions).length;
      var st = enhancePane && enhancePane.querySelector('#wbs-ac-status');
      if (st) st.textContent = count ? '监控激活会话中' : '等待会话';
      if (!session || !session.id) return;
      var previous = session.status;
      session.status = status;
      acMonitorRegistry.update(session.id, { title: session.title, status: status });
      // Store subscriptions can emit on every streaming chunk. Keep the live
      // viewer useful by logging transitions and explicit operations only.
      var operation = /^(discovered|sending|continue-sent|send-error|send-unconfirmed|input-busy|interrupted|completed|stopped|awaiting-approval)$/.test(status);
      if (previous !== status || operation) acMonitorLog(session.id, status, detail || {});
    }

    function acMultiCreateSession(update, source) {
      if (!update || !update.id || acMulti.sessions[update.id]) return acMulti.sessions[update.id] || null;
      var session = {
        id: update.id,
        controller: null,
        title: update.title || '',
        status: 'discovered',
        lastSeen: 0,
        controllerLastDiscoveredAt: 0,
        lastVersion: -1,
        lastBusy: false,
        idleAt: 0,
        baselineAssistantKey: '',
        awaitingNewReply: true,
        awaitingSince: 0,
        hadActivity: !!update.active,
        judgedMessages: new Set(),
        timer: null,
        generation: acMulti.generation,
        sending: false,
        unsubs: [],
        resourceActive: !!update.active,
        resourceStatus: update.status || '',
        resourcePendingInputKind: update.pendingInputKind || '',
        resourceUpdatedAt: Date.now(),
      };
      acMulti.sessions[session.id] = session;
      acMonitorRegistry.ensure(session.id, { title: session.title, status: session.status });
      acMonitorLog(session.id, 'discovered', { source: source || 'session-resource' });
      return session;
    }

    function acMultiStatusFromResource(update) {
      if (update.pendingInputKind) return 'awaiting-approval';
      return update.status === 'pending' ? 'pending' : 'running';
    }

    function acMultiHandleSessionResourceUpdate(update) {
      if (!update || !update.id || !acRunning || acMulti.mode !== 'multi') return;
      var session = acMulti.sessions[update.id];
      var action = sessionMonitorLifecycleAction(update, !!session);
      if (action === 'add') session = acMultiCreateSession(update, update.event === 'sidebarSnapshot' ? 'sidebar' : 'session-resource');
      if (action === 'ignore' || !session) return;
      session.resourceActive = update.active;
      session.resourceStatus = update.status || session.resourceStatus;
      session.resourcePendingInputKind = update.pendingInputKind || '';
      session.resourceUpdatedAt = Date.now();
      if (update.title) session.title = update.title;
      if (action === 'remove') {
        acMultiUpdateStatus(session, 'completed', {
          source: update.event === 'sidebarSnapshot' ? 'sidebar' : 'session-resource',
          event: update.event,
          status: update.status,
        });
        acMultiFinishSession(session);
        return;
      }
      if (!update.active) return;
      acMultiUpdateStatus(session, acMultiStatusFromResource(update), {
        source: update.event === 'sidebarSnapshot' ? 'sidebar' : 'session-resource',
        status: update.status,
        pendingInputKind: update.pendingInputKind || undefined,
      });
    }

    function acMultiReconcileSidebar() {
      if (!WBS_COMPAT || typeof WBS_COMPAT.findConversationListRecords !== 'function') return false;
      var records = [];
      try { records = WBS_COMPAT.findConversationListRecords(document) || []; } catch (_) {}
      for (var i = 0; i < records.length; i++) {
        var update = normalizeSessionMonitorResourceRecord(records[i], 'sidebarSnapshot');
        if (update) acMultiHandleSessionResourceUpdate(update);
      }
      return records.length > 0;
    }

    function acMultiBindSessionResource() {
      if (acMulti.sessionResource) return true;
      acMulti.sessionResourceRetryAt = Date.now() + 15000;
      if (!WBS_COMPAT || typeof WBS_COMPAT.findSessionsResource !== 'function') return false;
      var resource = null;
      try { resource = WBS_COMPAT.findSessionsResource(document); } catch (_) {}
      if (!resource) return false;
      acMulti.sessionResource = resource;
      acMulti.sessionResourceUnsubscribe = subscribeSessionMonitorResource(resource, acMultiHandleSessionResourceUpdate);
      acLog('session-resource-bound');
      return true;
    }

    function acMultiUnbindSessionResource() {
      if (typeof acMulti.sessionResourceUnsubscribe === 'function') {
        try { acMulti.sessionResourceUnsubscribe(); } catch (_) {}
      }
      acMulti.sessionResourceUnsubscribe = null;
      acMulti.sessionResource = null;
      acMulti.sessionResourceRetryAt = 0;
    }

    function acMultiSchedule(session, delay) {
      if (!session || !acRunning) return;
      if (session.timer) clearTimeout(session.timer);
      session.timer = setBuildTimeout(function () {
        session.timer = null;
        acMultiCheckSession(session);
      }, Math.max(100, Number(delay || 800)));
    }

    function acMultiSend(session, snapshot) {
      if (!session || !snapshot || session.sending || !acRunning) return;
      var controller = session.controller;
      if (!controller || typeof controller.sendPrompt !== 'function') return;
      var view;
      try { view = controller.getSessionViewState(); } catch (_) { return; }
      if (view && (view.isBusy || view.isRunActive || view.isTurnActive || view.isPending || view.isSending)) {
        acMultiUpdateStatus(session, 'running', { reason: 'send-busy-skip' });
        return;
      }
      // Only the active session has a user-editable composer. A background
      // controller send must never inspect or overwrite that composer.
      if (String(acActiveConversationId() || '') === String(session.id) && !acControllerComposerEmpty()) {
        acMultiUpdateStatus(session, 'input-busy', { reason: 'active-composer-not-empty' });
        acWeak('输入框非空，已放弃会话 ' + session.id + ' 的自动继续');
        return;
      }
      session.sending = true;
      acMultiUpdateStatus(session, 'sending', { assistantId: snapshot.assistantId || '' });
      var promise;
      try {
        promise = controller.sendPrompt({ blocks: [{ type: 'text', text: AC_CONTINUE_TEXT }] }, {
          _meta: { 'codebuddy.ai': { source: 'workdaddy-auto-continue' } },
        });
      } catch (e) {
        session.sending = false;
        acMultiUpdateStatus(session, 'send-error', { error: (e && e.message) || '?' });
        return;
      }
      Promise.resolve(promise).then(function (result) {
        if (!acRunning || session.generation !== acMulti.generation) return;
        session.sending = false;
        session.awaitingNewReply = true;
        session.awaitingSince = Date.now();
        session.baselineAssistantKey = snapshot.assistantId || session.baselineAssistantKey;
        acMultiUpdateStatus(session, 'continue-sent', { assistantId: snapshot.assistantId || '' });
      }).catch(function (e) {
        if (!acRunning || session.generation !== acMulti.generation) return;
        session.sending = false;
        acMultiUpdateStatus(session, 'send-unconfirmed', { error: (e && e.message) || '?' });
      });
    }

    function acMultiCheckSession(session) {
      if (!session || !acRunning || !session.controller) return;
      var selectedId = acActiveConversationId();
      if (selectedId && String(selectedId) !== String(session.id) && session.resourceActive) {
        acMultiUpdateStatus(session,
          session.resourcePendingInputKind ? 'awaiting-approval' : (session.resourceStatus === 'pending' ? 'pending' : 'running'),
          { source: 'session-resource' });
        return;
      }
      var snapshot = acControllerSnapshot(session.controller);
      if (!snapshot || !snapshot.conversationId) return;
      session.lastSeen = Date.now();
      session.title = session.title || acSessionTitle(session.controller);
      acMonitorRegistry.ensure(session.id, { title: session.title });
      session.hadActivity = session.hadActivity || isSessionMonitorInProgress(snapshot);
      if (snapshot.hydrating) {
        session.awaitingNewReply = true;
        session.baselineAssistantKey = snapshot.assistantId || session.baselineAssistantKey;
        session.lastVersion = snapshot.version;
        // An unmounted controller can remain frozen in hydration forever. A
        // newer global resource event is authoritative for background state.
        acMultiUpdateStatus(session, session.resourceActive ? 'running' : 'hydrating',
          session.resourceActive ? { source: 'session-resource' } : undefined);
        return;
      }
      if (snapshot.blocked) {
        session.lastBusy = true;
        session.idleAt = 0;
        session.lastVersion = snapshot.version;
        acMultiUpdateStatus(session, 'awaiting-approval', { state: snapshot.state || '' });
        return;
      }
      if (snapshot.busy) {
        session.lastBusy = true;
        session.idleAt = 0;
        session.lastVersion = snapshot.version;
        acMultiUpdateStatus(session, 'running', { phase: snapshot.phase || '', state: snapshot.state || '' });
        return;
      }
      if (session.lastBusy || !session.idleAt) session.idleAt = Date.now();
      session.lastBusy = false;
      session.lastVersion = snapshot.version;
      if (!snapshot.assistantId) {
        acMultiFinishSession(session);
        return;
      }
      if (session.awaitingNewReply) {
        if (snapshot.assistantId === session.baselineAssistantKey) {
          // Hydration can settle on an existing historical reply without ever
          // producing a new turn. It is no longer an in-progress session.
          if (!session.awaitingSince && !snapshot.busy) {
            acMultiFinishSession(session);
            return;
          }
          if (session.awaitingSince && !snapshot.busy && Date.now() - session.awaitingSince >= AC_CONTROLLER_SETTLE_MS) {
            acMultiFinishSession(session);
            return;
          }
          acMultiUpdateStatus(session, 'waiting-new-reply');
          return;
        }
        session.awaitingNewReply = false;
        session.baselineAssistantKey = snapshot.assistantId;
        session.idleAt = Date.now();
        acMultiUpdateStatus(session, 'new-reply', { assistantId: snapshot.assistantId });
      }
      var signature = 'id:' + snapshot.assistantId;
      if (session.judgedMessages.has(signature)) return;
      var idleFor = Date.now() - session.idleAt;
      var completed = autoContinueControllerCompleted(snapshot);
      if (!completed && !snapshot.error && idleFor < AC_CONTROLLER_SETTLE_MS) {
        acMultiUpdateStatus(session, 'settling', { idleForMs: idleFor });
        acMultiSchedule(session, Math.max(250, AC_CONTROLLER_SETTLE_MS - idleFor));
        return;
      }
      var decision = classifyAutoContinueControllerSnapshot({
        assistantId: snapshot.assistantId,
        busy: snapshot.busy,
        manualStop: snapshot.manualStop,
        error: snapshot.error,
        networkFailure: snapshot.networkFailure,
        completionMarker: acHasMarker(snapshot.text),
        complete: snapshot.terminalKnown ? false : snapshot.complete,
        terminal: snapshot.terminal,
      });
      session.judgedMessages.add(signature);
      if (!decision.trigger) {
        acMultiFinishSession(session);
        return;
      }
      if (snapshot.manualStop) {
        acMultiFinishSession(session);
        return;
      }
      acMultiUpdateStatus(session, 'interrupted', { reason: decision.reason, idleForMs: idleFor });
      acMultiSend(session, snapshot);
    }

    function acMultiBindController(controller) {
      if (!controller || !controller.conversationId) return null;
      var id = String(controller.conversationId);
      var existing = acMulti.sessions[id];
      if (existing && existing.controller === controller) {
        existing.lastSeen = Date.now();
        existing.controllerLastDiscoveredAt = Date.now();
        return existing;
      }
      var initialSnapshot = acControllerSnapshot(controller);
      if (!existing && !isSessionMonitorInProgress(initialSnapshot)) return null;
      var session = existing || acMultiCreateSession({
        id: id,
        title: acSessionTitle(controller),
        status: 'running',
        active: true,
        terminal: false,
      }, 'controller');
      if (!session) return null;
      if (session.controller && session.controller !== controller) acMultiDetachController(session);
      session.controller = controller;
      session.lastSeen = Date.now();
      session.controllerLastDiscoveredAt = Date.now();
      session.generation = acMulti.generation;
      session.title = session.title || acSessionTitle(controller);
      session.hadActivity = session.hadActivity || isSessionMonitorInProgress(initialSnapshot);
      // Establish the historical baseline before the first store callback.
      // Otherwise an already-rendered assistant message would look like a new
      // reply and could trigger an immediate false continuation.
      // A busy controller's current assistant is the in-flight reply, not a
      // historical baseline. Leave it empty so completion can be judged.
      if (initialSnapshot && !initialSnapshot.busy && !initialSnapshot.blocked && !initialSnapshot.hydrating) {
        session.baselineAssistantKey = initialSnapshot.assistantId || '';
      }
      var notify = function () { acMultiCheckSession(session); };
      try { if (controller.sessionStore && typeof controller.sessionStore.subscribe === 'function') session.unsubs.push(controller.sessionStore.subscribe(notify)); } catch (_) {}
      try { if (controller.messageStore && typeof controller.messageStore.subscribe === 'function') session.unsubs.push(controller.messageStore.subscribe(notify)); } catch (_) {}
      if (initialSnapshot && (isSessionMonitorInProgress(initialSnapshot) || !session.resourceActive)) acMultiCheckSession(session);
      return session;
    }

    function acMultiFinishSession(session) {
      if (!session || !acMulti.sessions[session.id]) return;
      acMultiDetachController(session);
      delete acMulti.sessions[session.id];
      acMonitorRegistry.remove(session.id);
      if (acMonitorSelectedId === session.id) acMonitorSelectedId = '';
      acScheduleMonitorLogRender();
    }

    function acMultiDetachController(session) {
      if (!session) return;
      if (session.timer) { clearTimeout(session.timer); session.timer = null; }
      for (var i = 0; i < session.unsubs.length; i++) { try { session.unsubs[i](); } catch (_) {} }
      session.unsubs = [];
      session.controller = null;
      session.sending = false;
    }

    function acMultiDiscover() {
      if (!acRunning || acMulti.mode !== 'multi') return;
      var controllers = [];
      try {
        if (WBS_COMPAT && typeof WBS_COMPAT.findConversationControllers === 'function') {
          controllers = WBS_COMPAT.findConversationControllers(document) || [];
        }
      } catch (_) {}
      var seen = Object.create(null);
      for (var i = 0; i < controllers.length; i++) {
        var session = acMultiBindController(controllers[i]);
        if (session) seen[session.id] = true;
      }
      var now = Date.now();
      if (!acMulti.sessionResource && now >= acMulti.sessionResourceRetryAt) acMultiBindSessionResource();
      if (now >= acMulti.sidebarReconcileAt) {
        acMulti.sidebarReconcileAt = now + 15000;
        acMultiReconcileSidebar();
      }
      Object.keys(acMulti.sessions).forEach(function (id) {
        var current = acMulti.sessions[id];
        if (!current.controller || seen[id]) return;
        // Controller lifetime follows the active view. Detaching it must not
        // delete a background session still reported active by the global list.
        if (now - current.controllerLastDiscoveredAt > 15000) {
          acMultiDetachController(current);
          if (!current.resourceActive) acMultiFinishSession(current);
        }
      });
      if (acRunning) acMulti.discoveryTimer = setBuildTimeout(acMultiDiscover, AC_HEARTBEAT_MS);
      acMultiUpdateStatus(null);
    }

    function acStartMultiMonitor() {
      acMulti.mode = 'multi';
      acStopLegacyMonitor();
      acMulti.generation++;
      var hasResource = acMultiBindSessionResource();
      var hasSidebar = acMultiReconcileSidebar();
      acMulti.sidebarReconcileAt = Date.now() + 15000;
      acMultiDiscover();
      if (!hasResource && !hasSidebar && !Object.keys(acMulti.sessions).length) {
        acMulti.mode = 'none';
        if (acMulti.discoveryTimer) { clearTimeout(acMulti.discoveryTimer); acMulti.discoveryTimer = null; }
        acMultiUnbindSessionResource();
        return false;
      }
      acShowStatus();
      return true;
    }

    function acStopMultiMonitor() {
      acMulti.mode = 'none';
      acMulti.generation++;
      if (acMulti.discoveryTimer) { clearTimeout(acMulti.discoveryTimer); acMulti.discoveryTimer = null; }
      acMultiUnbindSessionResource();
      Object.keys(acMulti.sessions).forEach(function (id) {
        acMultiDetachController(acMulti.sessions[id]);
        acMonitorRegistry.remove(id);
      });
      acMulti.sessions = Object.create(null);
      acMulti.sidebarReconcileAt = 0;
      acMonitorSelectedId = '';
      acScheduleMonitorLogRender();
    }

    function acStartMonitor() {
      if (acStartMultiMonitor()) return;
      acStartLegacyMonitor();
    }

    function acStopMonitor() {
      acStopMultiMonitor();
      acStopLegacyMonitor();
    }

    /** 把已累积日志渲染进开发者工具卡片（buildEnhancePane 重建后恢复显示） */
    function acRenderLog() {
      try {
        var pre = enhancePane && enhancePane.querySelector('#wbs-ac-log');
        if (pre) {
          pre.textContent = acLogLines.length ? acLogLines.join('\n') : '（未开启「会话异常中断」监控时无日志）';
          pre.scrollTop = pre.scrollHeight;
        }
      } catch (e) {}
    }

    var acMonitorSelectedId = '';
    function acMonitorStatusLabel(status) {
      var labels = {
        discovered: '已发现', running: '运行中', pending: '等待中', hydrating: '恢复中', 'awaiting-approval': '等待允许',
        'waiting-new-reply': '等待新回复', settling: '整理中', interrupted: '已中断', sending: '发送中',
        'continue-sent': '已继续', completed: '已完成', stopped: '已停止', idle: '空闲',
        'send-error': '发送失败', 'send-unconfirmed': '未确认', 'input-busy': '输入框占用', unknown: '未知',
      };
      return labels[status] || status || '未知';
    }
    function acMonitorSafeDetail(detail) {
      var src = detail && typeof detail === 'object' ? detail : {};
      var safe = {};
      Object.keys(src).forEach(function (key) {
        if (/text|prompt|content|token|key|path|cookie|account|nickname/i.test(key)) return;
        var value = src[key];
        if (value == null || typeof value === 'function') return;
        safe[key] = typeof value === 'string' ? value.slice(0, 160) : value;
      });
      var out = JSON.stringify(safe);
      return out === '{}' ? '' : out;
    }
    function acRenderMonitorLogModal() {
      var host = aboutPane && aboutPane.querySelector('#wbs-monitor-log-inline');
      if (!host) return;
      var tabs = host.querySelector('.wbs-monitor-log-session-list');
      var list = host.querySelector('.wbs-monitor-log-list');
      if (!tabs || !list) return;
      var sessions = acMonitorRegistry.list();
      if (!sessions.length) {
        acMonitorSelectedId = '';
        tabs.textContent = '';
        list.textContent = '暂无进行中的会话';
        return;
      }
      if (!sessions.some(function (item) { return item.id === acMonitorSelectedId; })) acMonitorSelectedId = sessions[0].id;
      tabs.textContent = '';
      sessions.forEach(function (session) {
        var tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'wbs-monitor-log-session-btn' + (session.id === acMonitorSelectedId ? ' active' : '');
        tab.setAttribute('aria-pressed', session.id === acMonitorSelectedId ? 'true' : 'false');
        tab.title = session.id;
        var name = session.title || ('会话 ' + session.id.slice(0, 8));
        tab.textContent = name + ' · ' + acMonitorStatusLabel(session.status);
        tab.addEventListener('click', function () { acMonitorSelectedId = session.id; acRenderMonitorLogModal(); });
        tabs.appendChild(tab);
      });
      var selected = sessions.find(function (item) { return item.id === acMonitorSelectedId; });
      list.textContent = '';
      if (!selected || !selected.logs.length) {
        list.textContent = '该会话暂无操作日志';
        return;
      }
      selected.logs.forEach(function (entry) {
        var row = document.createElement('div');
        row.className = 'wbs-monitor-log-entry';
        var time = new Date(entry.at).toLocaleTimeString();
        var detail = acMonitorSafeDetail(entry.detail);
        row.textContent = '[' + time + '] ' + acMonitorStatusLabel(entry.event) + (detail ? ' · ' + detail : '');
        list.appendChild(row);
      });
      list.scrollTop = list.scrollHeight;
    }

    function wireAutoContinuePane() {
      acRenderLog();
      var logClear = enhancePane && enhancePane.querySelector('#wbs-ac-log-clear');
      if (logClear) {
        logClear.addEventListener('click', function () {
          acLogLines = [];
          acRenderLog();
          acLog('log-cleared');
        });
      }
      var sw = enhancePane && enhancePane.querySelector('#wbs-ac-switch');
      if (sw) {
        sw.addEventListener('change', function () {
          var enabled = this.checked;
          api('/api/auto-continue-set', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled: enabled }),
          }).then(function (d) {
            if (!d || !d.ok) throw new Error((d && d.error) || 'daemon 未确认');
            applyAutoContinueState(d); // 开关切换成功：不弹 toast（状态由卡片标题右侧常驻动画体现）
          }).catch(function (e) {
            toast('设置失败: ' + (e.message || e), true, root);
            syncAutoContinue();
          });
        });
      }
      syncAutoContinue();
    }
    /** 会话模块控件绑定：暂存提示词/消息索引/快捷短语开关 + 快捷短语列表。面板每次打开重建时重绑。 */
    function wireSessionControls() {
      var pane2 = enhancePane;
      if (!pane2) { syncSessionModule(); return; }
      var swS = pane2.querySelector('#wbs-sess-stash');
      if (swS) swS.addEventListener('change', function () { setSessionSwitchWire('stashEnabled', this); });
      var swN = pane2.querySelector('#wbs-sess-message-nav');
      if (swN) swN.addEventListener('change', function () {
        sessState.messageNav = !!this.checked;
        writeMessageNavigationEnabled(sessState.messageNav);
        if (messageNavigation) messageNavigation.setEnabled(sessState.messageNav);
      });
      var swQ = pane2.querySelector('#wbs-sess-selection-quote');
      if (swQ) swQ.addEventListener('change', function () {
        sessState.selectionQuote = !!this.checked;
        writeSelectionQuoteEnabled(sessState.selectionQuote);
        if (!sessState.selectionQuote) hideSelectionQuoteButton();
        else scheduleSelectionQuoteButton();
      });
      var swP = pane2.querySelector('#wbs-sess-phrase');
      if (swP) swP.addEventListener('change', function () { setSessionSwitchWire('phraseEnabled', this); });
      var batchBtn = pane2.querySelector('#wbs-qp-batch');
      if (batchBtn) batchBtn.addEventListener('click', function () { sessState.qpBatch = true; sessState.qpSel = {}; renderQpList(); });
      var doneBtn = pane2.querySelector('#wbs-qp-done');
      if (doneBtn) doneBtn.addEventListener('click', function () { sessState.qpBatch = false; sessState.qpSel = {}; renderQpList(); });
      var allBtn = pane2.querySelector('#wbs-qp-checkall');
      if (allBtn) allBtn.addEventListener('click', function () {
        var allSelected = sessState.phrases.length && Object.keys(sessState.qpSel).length === sessState.phrases.length;
        sessState.qpSel = {};
        if (!allSelected) {
          for (var i = 0; i < sessState.phrases.length; i++) sessState.qpSel[sessState.phrases[i].id] = 1;
        }
        renderQpList();
      });
      var batchCopy = pane2.querySelector('#wbs-qp-copy');
      if (batchCopy) batchCopy.addEventListener('click', function () {
        var selected = sessState.phrases.filter(function (phrase) { return !!sessState.qpSel[phrase.id]; });
        if (!selected.length) { acWeak('请先勾选要复制的短语'); return; }
        copyPlainText(selected.map(function (phrase) { return phrase.text; }).join('\n')).then(function () {
          toast('已复制 ' + selected.length + ' 条快捷短语', false, root);
        }).catch(function (error) { toast(error.message || '复制失败', true, root); });
      });
      var batchExport = pane2.querySelector('#wbs-qp-export');
      if (batchExport) batchExport.addEventListener('click', function () {
        var ids = Object.keys(sessState.qpSel);
        if (!ids.length) { acWeak('请先勾选要导出的短语'); return; }
        openSecureTransferModal({
          title: '导出快捷短语',
          requirePassword: true,
          confirmText: '导出',
          hint: '将加密导出 ' + ids.length + ' 条快捷短语。',
          onConfirm: function (password) { return api('/api/quick-phrases/export', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ids: ids, password: password }),
          }).then(function (result) {
            downloadTransfer(result, 'WorkDaddy-quick-phrases.json');
            toast('已导出 ' + result.count + ' 条快捷短语（已加密）', false, root);
          }); },
        });
      });
      var batchDel = pane2.querySelector('#wbs-qp-batch-del');
      if (batchDel) batchDel.addEventListener('click', function () {
        var ids = Object.keys(sessState.qpSel);
        if (!ids.length) { acWeak('请先勾选要删除的短语'); return; }
        confirmQpDelete(ids);
      });
      var importBtn = pane2.querySelector('#wbs-qp-import');
      var importFile = pane2.querySelector('#wbs-qp-import-file');
      if (importBtn && importFile) {
        importBtn.addEventListener('click', function () { importFile.click(); });
        importFile.addEventListener('change', function (event) {
          var file = event.target && event.target.files && event.target.files[0];
          event.target.value = '';
          if (!file) return;
          readTransferFile(file).then(function (content) {
            openSecureTransferModal({
              title: '导入快捷短语',
              requirePassword: true,
              confirmText: '导入',
              hint: '输入导出时设置的密码；已有的相同短语会自动跳过。',
              onConfirm: function (password) { return api('/api/quick-phrases/import', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ content: content, password: password }),
              }).then(function (result) {
                applySessionModule(result);
                toast('已导入 ' + result.imported + ' 条快捷短语' + (result.skipped ? '，跳过 ' + result.skipped + ' 条' : ''), false, root);
              }); },
            });
          }).catch(function (error) { toast(error.message || '读取文件失败', true, root); });
        });
      }
      var addBtn = pane2.querySelector('#wbs-qp-add');
      if (addBtn) addBtn.addEventListener('click', function () { openQpEdit(null); });
      syncSessionModule(); // 每次面板打开拉取最新开关与短语（含外部修改）
    }
    function syncAutoContinue() {
      api('/api/auto-continue').then(function (d) {
        if (d && d.ok) applyAutoContinueState(d);
      }).catch(function () {});
    }
    function applyAutoContinueState(d) {
      // UI 同步（增强页可能未构建，不影响监控运行）
      var card = enhancePane && enhancePane.querySelector('#wbs-ac-card');
      var acRow = enhancePane && enhancePane.querySelector('#wbs-ac-row');
      var sw = enhancePane && enhancePane.querySelector('#wbs-ac-switch');
      if (card && acRow && sw) {
        if (!d.platformSupported || !AC_SUPPORTED) { acRow.style.display = 'none'; }
        else { acRow.style.display = ''; sw.checked = !!d.enabled; }
      }
      // 监控启停（与 UI 解耦：开关开着，监控就必须在跑，无论面板是否打开）
      syncAutoContinueMonitor(d);
    }
    /** 按 daemon 状态启动/停止监控（注入后、增强页构建时、开关切换时都会调用） */
    function syncAutoContinueMonitor(d) {
      if (!d) return;
      if (!d.platformSupported || !AC_SUPPORTED) {
        if (acRunning) { acRunning = false; acLog('monitor-stop-by-state', { reason: 'unsupported' }); acStopMonitor(); }
        return;
      }
      if (d.enabled && !acRunning) { acRunning = true; acLog('monitor-start-by-state'); acStartMonitor(); }
      else if (!d.enabled && acRunning) { acRunning = false; acLog('monitor-stop-by-state'); acStopMonitor(); }
    }
    /** 注入后无条件检查一次开关状态（不依赖打开增强页），根除"开关开着但监控没跑" */
    function ensureAutoContinueMonitor() {
      api('/api/auto-continue').then(function (d) {
        if (d && d.ok) syncAutoContinueMonitor(d);
      }).catch(function () {});
    }
    /** 每次打开面板时校验：开关开着但本地自定义指令块已丢失（外部重写/误删）→ 请求 daemon 补写（不弹 toast） */
    function acCheckPromptOnOpen() {
      api('/api/auto-continue').then(function (d) {
        if (!d || !d.ok) return;
        if (d.enabled && !d.promptBlockPresent) {
          acLog('prompt-block-lost-restore');
          api('/api/auto-continue-set', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled: true }),
          }).then(function (r) {
            if (r && r.ok) applyAutoContinueState(r); // 补写指令块并保持监控开启（无 toast）
          }).catch(function () {});
        }
      }).catch(function () {});
    }

    // reinject/刷新时销毁监控，避免叠加 observer/timer
    registerDisposer(function () {
      acRunning = false;
      if (acThemeObserver) { try { acThemeObserver.disconnect(); } catch (e) {} acThemeObserver = null; }
      acStopMonitor();
      stopNoDisturbAutoApprove();
      stopUntilDoneCheck();
      if (acMonitorLogFrame != null) {
        try {
          var cancelFrame = window.cancelAnimationFrame || clearTimeout;
          cancelFrame(acMonitorLogFrame);
        } catch (e) {}
        acMonitorLogFrame = null;
      }
      if (acStatusTimer) { clearTimeout(acStatusTimer); acStatusTimer = null; }
    });

    /* —— 弹窗自动点允许（兜底，默认关）—— */
    function startNoDisturbAutoApprove() {
      if (ndAutoObserver) return;
      var doc = (window && window.document) || document;
      if (!doc || !doc.body) return;
      ndScanRoots = [];
      ndAutoObserver = new MutationObserver(function (records) {
        for (var i = 0; i < records.length; i++) ndQueueScanRoot(records[i].target);
        scheduleNdScan();
      });
      ndAutoObserver.observe(doc.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['aria-disabled', 'disabled', 'class', 'hidden', 'style', 'data-state', 'data-status'],
      });
      ndQueueScanRoot(doc.body);
      scheduleNdScan();
    }
    function stopNoDisturbAutoApprove() {
      if (ndAutoObserver) { ndAutoObserver.disconnect(); ndAutoObserver = null; }
      if (ndScanTimer) { clearTimeout(ndScanTimer); ndScanTimer = null; }
      ndScanRoots = [];
    }
    function scheduleNdScan() {
      if (ndScanTimer) clearTimeout(ndScanTimer);
      ndScanTimer = setTimeout(scanNoDisturbApproval, 120);
    }
    function ndQueueScanRoot(node) {
      if (!node) return;
      var el = node.nodeType === 1 ? node : node.parentElement;
      if (!el) return;
      // Prefer stable semantic dialog/task boundaries; fall back to a shallow
      // ancestor so a background card is scanned without walking the whole body.
      var root = el.closest && el.closest('[role="dialog"],[data-conversation-id],[data-root-id],' +
        '[class*="_dialog_"],[class*="_modal_"],[class*="_permission_"],[class*="_confirm_"],' +
        '[class*="_decision_"],[class*="_approval_"],[class*="_question_"],[class*="_ask_"],' +
        '[class*="permission-dialog"],[class*="confirm-dialog"],[class*="decision-dialog"],' +
        '[class*="approval"],[class*="permission"],[class*="confirm"]');
      if (!root) {
        root = el;
        for (var i = 0; i < 4 && root.parentElement; i++) root = root.parentElement;
      }
      if (ndScanRoots.indexOf(root) < 0) ndScanRoots.push(root);
      if (ndScanRoots.length > 24) ndScanRoots.shift();
    }
    // Kept as a small compatibility helper for older diagnostic harnesses;
    // background cards are intentionally allowed through the structured gate.
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
    function ndClassifyApprovalCandidate(value) {
      if (typeof classifyNoDisturbApprovalCandidate === 'function') return classifyNoDisturbApprovalCandidate(value);
      var input = value || {};
      var label = String(input.label || '').trim().replace(/^\d+\s*/, '');
      var kind = /始终允许|Always\s*allow/i.test(label) ? 'session' :
        (/^(允许|允许一次|Allow|Yes|同意|批准|确认允许)$/i.test(label) || (/^Yes/i.test(label) && label.length < 24) ? 'once' : null);
      if (!kind || input.disabled || input.ariaDisabled) return null;
      var context = String(input.context || '').slice(0, 700);
      if (input.creditSeen || ND_CREDIT_PATTERN.test(context)) return null;
      return ND_CONFIRM_PATTERN.test(context) || (input.hasDeny === true && input.hasOnce === true && input.buttonCount >= 2 && input.buttonCount <= 12) ? kind : null;
    }
    function ndSessionIdForNode(node) {
      try {
        var owner = node && node.closest && node.closest('[data-conversation-id],[data-root-id]');
        return owner && (owner.getAttribute('data-conversation-id') || owner.getAttribute('data-root-id')) || '';
      } catch (_) { return ''; }
    }
    function ndApprovalContext(button) {
      var box = button;
      var text = '';
      var hasDeny = false;
      var count = 0;
      var creditSeen = false;
      var creditBox = button;
      for (var creditDepth = 0; creditDepth < 8 && creditBox; creditDepth++) {
        creditBox = creditBox.parentElement;
        if (creditBox && ND_CREDIT_PATTERN.test(String(creditBox.textContent || '').slice(0, 700))) {
          creditSeen = true;
          break;
        }
      }
      for (var depth = 0; depth < 8 && box; depth++) {
        box = box.parentElement;
        if (!box) break;
        var current = String(box.textContent || '');
        if (current.length > 700) current = current.slice(0, 700);
        text = current;
        if (ND_CREDIT_PATTERN.test(current)) creditSeen = true;
        hasDeny = ND_DENY_WORD.test(current);
        var buttons = box.querySelectorAll('button');
        count = buttons ? buttons.length : 0;
        var hasOnce = ndIsDecisionGroup(box);
        var kind = ndClassifyApprovalCandidate({
          label: button.textContent || '',
          context: current,
          hasDeny: hasDeny,
          buttonCount: count,
          hasOnce: hasOnce,
          creditSeen: creditSeen,
          disabled: button.disabled,
          ariaDisabled: button.getAttribute('aria-disabled') === 'true',
        });
        if (kind) return { kind: kind, context: current, box: box };
      }
      return { kind: null, context: text, box: box };
    }
    function scanNoDisturbApproval() {
      var doc = (window && window.document) || document;
      if (!doc) return;
      var roots = (typeof ndScanRoots !== 'undefined' && ndScanRoots.length) ? ndScanRoots.splice(0, ndScanRoots.length) : [doc.body];
      var seen = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
      for (var r = 0; r < roots.length; r++) {
        var root = roots[r];
        if (!root || !root.querySelectorAll || (doc.documentElement && !doc.documentElement.contains(root))) continue;
        var btns = root.querySelectorAll('button');
        for (var i = 0; i < btns.length; i++) {
          var b = btns[i];
          if (seen && seen.has(b)) continue;
          if (seen) seen.add(b);
          if (b.getAttribute('data-nd-auto')) continue;
          var t = ndNormalizeLabel(b.textContent || '');
          if (!t) continue;
          var approval = ndApprovalContext(b);
          if (!approval.kind) continue;
          b.setAttribute('data-nd-auto', '1');
          var sessionId = ndSessionIdForNode(b);
          // The viewer represents active Auto-Continue sessions only; do not
          // create a permanent tab for a one-off approval when that monitor is off.
          if (sessionId && acRunning && acMulti.sessions[sessionId]) {
            acMonitorLog(sessionId, 'approval-clicked', { kind: approval.kind, source: 'dom' });
          }
          toNdAudit(approval.kind, t);
          try { if (b.click) b.click(); } catch (e) {}
        }
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
        var map = { allow: '允许电脑休眠（系统默认）', keep: '持续禁止休眠（保持唤醒）', 'until-done': '所有会话结束允许休眠（暂禁休眠）' };
        toast('休眠模式已切换为「' + (map[mode] || mode) + '」' + (displaySleep ? '，显示器可单独休眠' : ''), false, root);
        syncSleepState();
        return d;
      }).catch(function (e) {
        toast('设置失败: ' + (e.message || e), true, root);
        syncSleepState();
      });
    }
    // 旧客户端无控制器时的休眠兜底：只检查当前激活会话的 DOM 信号。
    // 正常路径由 isAnySessionBusy() 通过所有已发现 ConversationController 判断，
    // 因此这里只保留兼容旧版 DOM 的最后降级分支。
    function isSessionBusy(lockedId) {
      try {
        var activeId = acActiveConversationId();
        // 无任何激活会话（或锁定的会话已不是当前会话）→ 视为该会话已结束
        if (!activeId) return { busy: false, sessionId: activeId || '' };
        if (lockedId && String(lockedId) !== String(activeId)) return { busy: false, sessionId: activeId };
        // 停止按钮（5.4.4 实测）：发送按钮在生成中变身为 cr-send-button--sending/--stop，aria-label=「停止」，
        // 位于输入区 cr-input-toolbar（全局唯一当前会话输入区）；兜底 cr-btn-stop/cb-stop/_stop_。
        var stops = document.querySelectorAll(
          '.cr-send-button.cr-send-button--sending,' +
          '.cr-send-button[class*="--stop"],' +
          '[aria-label*="停止"],[aria-label*="stop"],' +
          '[class*="cr-btn-stop"],[class*="cb-stop"],[class*="_stop_"]'
        );
        // 只认可见的（生成中场必然可见）
        for (var si = 0; si < stops.length; si++) {
          var rc = stops[si].getBoundingClientRect();
          if (rc.height > 0 && rc.width > 0) return { busy: true, sessionId: activeId };
        }
        // 兜底：当前会话消息区内 reasoning streaming 存在
        var rootEl = document.querySelector('.cr-message-list, .cr-conversation-timeline, .conversation-timeline');
        var container = rootEl || document;
        var secs = container.querySelectorAll ? container.querySelectorAll(
          'section[class*=_assistantReasoning_][class*=_streaming_],' +
          '[class*="_assistantReasoning_"][data-wbs-theme-state="streaming"]'
        ) : [];
        if (secs.length > 0) return { busy: true, sessionId: activeId };
        return { busy: false, sessionId: activeId };
      } catch (e) { return { busy: false, sessionId: acActiveConversationId ? acActiveConversationId() : '' }; }
    }
    // until-done 模式：轮询所有已发现会话；全部结束后自动恢复 allow。
    var sleepUntilDoneSession = null; // 兼容旧字段；全量模式不再锁定单一会话
    function discoverSleepSessionBusy() {
      var controllers = [];
      try {
        if (WBS_COMPAT && typeof WBS_COMPAT.findConversationControllers === 'function') {
          controllers = WBS_COMPAT.findConversationControllers(document) || [];
        }
      } catch (_) {}
      var seen = Object.create(null);
      var busy = false;
      var now = Date.now();
      for (var i = 0; i < controllers.length; i++) {
        var controller = controllers[i];
        var id = controller && controller.conversationId ? String(controller.conversationId) : '';
        if (!id) continue;
        seen[id] = true;
        var cached = sleepSessionCache[id] || (sleepSessionCache[id] = { controller: controller, lastSeen: now, wasBusy: false });
        cached.controller = controller;
        cached.lastSeen = now;
        var snapshot = acControllerSnapshot(controller);
        cached.wasBusy = !!(snapshot && (snapshot.busy || snapshot.blocked || snapshot.hydrating));
        if (cached.wasBusy) busy = true;
      }
      Object.keys(sleepSessionCache).forEach(function (id) {
        var cached = sleepSessionCache[id];
        if (seen[id]) return;
        // Virtualized background conversations may be absent for one scan.
        if (cached.wasBusy && now - cached.lastSeen < 15000) busy = true;
        else if (now - cached.lastSeen >= 15000) delete sleepSessionCache[id];
      });
      return busy;
    }
    function isAnySessionBusy() {
      var ids = Object.keys(acMulti.sessions);
      if (ids.length) {
        for (var i = 0; i < ids.length; i++) {
          var session = acMulti.sessions[ids[i]];
          if (session && session.resourceActive) return true;
          var snapshot = session && session.controller ? acControllerSnapshot(session.controller) : null;
          if (snapshot && (snapshot.busy || snapshot.blocked || snapshot.hydrating)) return true;
        }
        return discoverSleepSessionBusy();
      }
      if (discoverSleepSessionBusy()) return true;
      return !!isSessionBusy(null).busy;
    }
    function startUntilDoneCheck() {
      if (sleepUntilDoneCheck) return;
      sleepUntilDoneSession = null;
      sleepUntilDoneCheck = setBuildInterval(function () {
        if (!alive) { stopUntilDoneCheck(); return; }
        if (sleepMode !== 'until-done') { stopUntilDoneCheck(); return; }
        if (!isAnySessionBusy()) {
          // 所有已发现会话均结束 → 自动恢复允许休眠
          stopUntilDoneCheck();
          api('/api/sleep-mode', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mode: 'allow', displaySleep: false }),
          }).then(function () {
            toast('所有进行中的会话已完成，已自动恢复「允许电脑休眠」', false, root);
            syncSleepState();
          }).catch(function () { syncSleepState(); });
        }
      }, 3000);
    }
    function stopUntilDoneCheck() {
      if (sleepUntilDoneCheck) { clearInterval(sleepUntilDoneCheck); sleepUntilDoneCheck = null; }
      sleepUntilDoneSession = null;
      sleepSessionCache = Object.create(null);
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
            var dot = root.querySelector('#wbs-fab-sleep-light');
            if (dot) {
              var on = preventing;
              // 默认黑色；禁止休眠时天线圆点亮起呼吸
              dot.classList.remove('sleep-on', 'sleep-until-done');
              if (on) {
                dot.classList.add(d.mode === 'until-done' ? 'sleep-until-done' : 'sleep-on');
              }
              var t = '允许电脑休眠（默认）';
              var antiLock = d.antiLock === true; // daemon 是否已启用防锁屏（UserIsActive 断言）
              if (d.mode === 'keep') t = '持续禁止休眠：电脑/显示器保持唤醒' + (antiLock ? '，已防锁屏' : '');
              if (d.mode === 'keep' && d.displaySleep) t = '持续禁止休眠：仅阻止系统睡眠，显示器可黑屏（可能锁屏）';
              if (d.mode === 'until-done') t = '所有会话结束允许休眠：任一会话回复中保持唤醒，全部结束后自动恢复' + (antiLock ? '，已防锁屏' : '');
              if (d.mode === 'until-done' && d.displaySleep) t = '所有会话结束允许休眠：暂禁中，显示器可黑屏（可能锁屏）';
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

    function todayUsageHtml(a) {
      var usage = a && a.todayUsage;
      if (!usage || usage.synced !== true) return '';
      var used = Number(usage.used);
      if (!isFinite(used) || used <= 0) return '';
      return '<span class="wbs-usage-tag"><span>今日已使用</span>' + CREDIT_ICON + '<b>' + fmtCredits(used) + '</b></span>';
    }

    function accountStatusTagsHtml(a) {
      var tags = todayUsageHtml(a);
      return tags ? '<span class="wbs-account-tags">' + tags + '</span>' : '';
    }

    function checkinBadgeHtml(a) {
      var tag = checkinHtml(a);
      return tag ? '<span class="wbs-checkin-slot">' + tag + '</span>' : '';
    }

    function creditBlockHtml(credits, segments, account) {
      if (isIdentityExpired(account)) return '';
      var usage = accountStatusTagsHtml(account);
      // 企业账号不限量（官方 getEnterpriseUsage 返回 limitNum === -1）
      if (account && account.creditUnlimited) {
        return '<div class="wbs-credit-block">' +
          '<div class="wbs-credit-line"><div class="wbs-credit-left"><span class="wbs-lbl">剩余</span><span class="wbs-credit-total">' + CREDIT_ICON + '<b>不限量</b></span></div>' + usage + '</div>' +
          '<div class="wbs-credit-hint">企业配额</div>' +
          '</div>';
      }
      if (credits === undefined) return '<div class="wbs-credit-block"><div class="wbs-credit-line"><div class="wbs-credit-left"><span class="wbs-lbl">剩余</span><span class="wbs-credit-loading">读取中…</span></div>' + usage + '</div></div>';
      if (credits === null) return '<div class="wbs-credit-block"><div class="wbs-credit-line"><div class="wbs-credit-left"><span class="wbs-lbl">剩余</span><span class="wbs-credit-na">-</span></div>' + usage + '</div></div>';
      return '<div class="wbs-credit-block">' +
        '<div class="wbs-credit-line"><div class="wbs-credit-left"><span class="wbs-lbl">剩余</span><span class="wbs-credit-total">' + CREDIT_ICON + '<b>' + fmtCredits(credits) + '</b></span></div>' + usage + '</div>' +
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
        return {
          account: account,
          index: index,
          isCurrent: !!(state.current && account && account.uid === state.current.uid),
          expiresAt: nearestCreditExpiry(account),
        };
      }).sort(function (a, b) {
        if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
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
      state.current = data.current;
      state.accounts = (data.accounts || []).slice();
      if (state.current && state.current.uid) {
        state.accounts.sort(function (left, right) {
          var leftIsCurrent = !!(left && left.uid === state.current.uid);
          var rightIsCurrent = !!(right && right.uid === state.current.uid);
          if (leftIsCurrent === rightIsCurrent) return 0;
          return leftIsCurrent ? -1 : 1;
        });
      }
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
        // 版本标签：个人账号显示「个人版」；企业账号显示企业名称（enterpriseName），缺省回退「企业」。
        var editionBadge = a.type === 'personal' ? '个人版' : (a.enterpriseName ? a.enterpriseName : (a.type ? '企业' : ''));
        var badge = editionBadge ? '<span class="wbs-badge">' + esc(editionBadge) + '</span>' : '';
        var checkinBadge = checkinBadgeHtml(a);
        // 当前登录账号：卡片右上角对勾角标（替代原「当前」文字标签）
        var curMark = isCur ? '<span class="wbs-cur-marker" title="当前使用中">' + CUR_MARK_SVG + '</span>' : '';
        // 当前登录账号隐藏操作；认证已过期的账号保留删除，但隐藏切换，避免进入登录页。
        var expired = isIdentityExpired(a);
        var ops = isCur
          ? ''
          : '<div class="wbs-ops">' +
            (expired ? '' : '<button class="wbs-icon-btn wbs-acc-switch" type="button" title="切换" data-uid="' + escAttr(a.uid) + '" data-name="' + escAttr(a.nickname || '未命名') + '">' + SWITCH_SVG + '</button>') +
            '<button class="wbs-icon-btn wbs-del" type="button" title="删除" data-uid="' + escAttr(a.uid) + '" data-name="' + escAttr(a.nickname || '未命名') + '">' + TRASH_SVG + '</button>' +
            '</div>';
        // 国际版没有手机号：用 UIN（账号唯一数字标识）替代展示；国内版仍显示手机。
        // UIN 与手机号共用同一标签和值间距，确保与“剩余”额度列对齐。
        var isUinMode = !a.phone;
        var idLbl = a.phone ? '手机' : (a.uin ? 'UIN' : '账号');
        var idVal = a.phone ? esc(a.phone) : (a.uin ? esc(a.uin) : '-');
        card.innerHTML =
          curMark +
          '<div class="wbs-info">' +
          '<div class="wbs-row1"><div class="wbs-name-group"><span class="wbs-name">' + esc(a.nickname || '(未命名)') + '</span>' + badge + checkinBadge + '</div>' + ops + '</div>' +
          '<div class="wbs-meta wbs-secondary-row">' +
          '<div class="wbs-mi wbs-phone-cell' + (isUinMode ? ' wbs-uin-cell' : '') + '"><span class="wbs-lbl">' + idLbl + '</span><span class="wbs-val">' + idVal + '</span></div>' +
          '<div class="wbs-mi wbs-token-cell"><span class="wbs-lbl">有效期至</span><span class="wbs-val' + (ts.warn ? ' wbs-warn' : '') + '">' + esc(ts.label) + '</span></div>' +
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
          var msg = '<div class="wbs-empty">无法连接本地服务: ' + esc(e.message || e) + '<br>请确认守护进程已运行</div>';
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
      (accounts || []).forEach(function (a) {
        for (var j = 0; j < state.accounts.length; j++) {
          if (state.accounts[j].uid === a.uid) {
            state.accounts[j].checkin = a.checkin;
            if (Object.prototype.hasOwnProperty.call(a, 'todayUsage')) state.accounts[j].todayUsage = a.todayUsage;
            byUid[a.uid] = state.accounts[j];
            break;
          }
        }
      });
      for (var i = 0; i < cards.length; i++) {
        var uid = cards[i].getAttribute('data-uid');
        var account = byUid[uid];
        if (!account) continue;
        var cell = cards[i].querySelector('.wbs-credit-cell');
        var status = cell && cell.querySelector('.wbs-account-tags');
        if (status) status.outerHTML = accountStatusTagsHtml(account);
        var nameGroup = cards[i].querySelector('.wbs-name-group');
        var checkinSlot = nameGroup && nameGroup.querySelector('.wbs-checkin-slot');
        var checkinBadge = checkinBadgeHtml(account);
        if (checkinSlot) {
          if (checkinBadge) checkinSlot.outerHTML = checkinBadge;
          else checkinSlot.remove();
        } else if (checkinBadge && nameGroup) {
          nameGroup.insertAdjacentHTML('beforeend', checkinBadge);
        }
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
            var unlimited = !!(r && r.unlimited);
            var hasTodayUsage = !!(r && Object.prototype.hasOwnProperty.call(r, 'todayUsage'));
            for (var i = 0; i < state.accounts.length; i++) {
              if (state.accounts[i].uid === a.uid) {
                state.accounts[i].credits = credits;
                state.accounts[i].creditSegments = segments;
                state.accounts[i].creditUnlimited = unlimited;
                if (hasTodayUsage) state.accounts[i].todayUsage = r.todayUsage;
                break;
              }
            }
            updateCreditCell(a.uid, credits, segments);
          })
          .catch(function () {
            if (runId !== state.creditRunId) return;
            for (var i = 0; i < state.accounts.length; i++) {
              if (state.accounts[i].uid === a.uid) { state.accounts[i].credits = null; state.accounts[i].creditSegments = []; state.accounts[i].creditUnlimited = false; break; }
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
      try { if (typeof window.__wbsStopPicked === 'function') window.__wbsStopPicked(); } catch (e) {}
      var inspector = document.getElementById('wbs-inspector');
      if (inspector && inspector.__wbsClose) inspector.__wbsClose();
      else if (inspector) inspector.remove();
    });
    registerDisposer(function () {
      restoreAvatarDom();
      root.remove();
      stashBtn.remove();
      exploreBtn.remove();
      debugPanel.remove();
      var tags = document.querySelectorAll('.wbs-queue-tag');
      Array.prototype.forEach.call(tags, function (tag) { tag.remove(); });
      if (css) css.remove();
      if (window.__wbsDiag === buildDiag) {
        try { delete window.__wbsDiag; } catch (e) { window.__wbsDiag = null; }
      }
    });

    // 注入完成即按开关状态启动/停止监控（不依赖打开增强面板）
    try { ensureAutoContinueMonitor(); } catch (e) {}
    // 注入完成即同步会话模块状态（暂存/快捷短语开关 + 短语列表）并应用到输入框按钮显隐
    try { syncSessionModule(); } catch (e) {}
    // 选区引用按钮默认开启；开关关闭时仅保留监听器，重新开启无需重注入。
    try { setupSelectionQuote(); } catch (e) {}
    // 打开面板时校验指令块是否丢失，丢失则自动关闭开关（不弹 toast）
    try { acCheckPromptOnOpen(); } catch (e) {}
    // 按钮主题色（浅色黑底白图 / 深色白底黑图）+ 监听主题切换
    try { applyThemeButtonColors(); watchThemeForButtons(); } catch (e) {}

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
    /* 会话消息索引：跟随官方消息视口定位，tooltip 使用主题感知的毛玻璃表面 */
    '.wbs-message-nav-root{position:fixed;width:24px;z-index:2147483645;pointer-events:none;user-select:none;-webkit-user-select:none;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:var(--wb-color-text-primary,#1f1f1f)}',
    '.wbs-message-nav-rail{display:flex;width:24px;height:100%;box-sizing:border-box;flex-direction:column;align-items:center;justify-content:flex-start;gap:0;overflow:hidden;padding:6px 0;border:1px solid transparent;border-radius:8px;background:color-mix(in srgb,var(--wb-bg-popover,#fff) 16%,transparent);box-shadow:none;backdrop-filter:none;-webkit-backdrop-filter:none;pointer-events:auto;touch-action:none;cursor:pointer;scrollbar-width:none;transition:background-color .18s ease,border-color .18s ease,box-shadow .18s ease,backdrop-filter .18s ease}',
    '.wbs-message-nav-rail:hover,.wbs-message-nav-rail:focus-within{border-color:color-mix(in srgb,var(--wb-border-subtle,#d9dadd) 72%,transparent);background:color-mix(in srgb,var(--wb-bg-popover,#fff) 48%,transparent);box-shadow:0 5px 18px rgba(24,28,36,.10);backdrop-filter:blur(14px) saturate(1.12);-webkit-backdrop-filter:blur(14px) saturate(1.12)}',
    '.wbs-message-nav-rail::-webkit-scrollbar{display:none}',
    '.wbs-message-nav-marker{display:flex;width:22px;height:var(--wbs-message-nav-marker-height,12px);min-height:var(--wbs-message-nav-marker-height,12px);box-sizing:border-box;flex:0 0 var(--wbs-message-nav-marker-height,12px);align-items:center;justify-content:center;padding:0;border:1px solid transparent;border-radius:4px;background:color-mix(in srgb,var(--wb-bg-popover,#fff) 10%,transparent);color:var(--wb-icon-secondary,#72757d);cursor:pointer;outline:none;transition:background-color .18s ease,color .18s ease,border-color .18s ease,box-shadow .18s ease,backdrop-filter .18s ease}',
    '.wbs-message-nav-marker:hover,.wbs-message-nav-marker:focus-visible{border-color:var(--wb-border-subtle,rgba(20,24,32,.14));background:color-mix(in srgb,var(--wb-bg-hover,rgba(0,0,0,.06)) 82%,var(--wb-bg-popover,#fff));color:var(--wb-color-text-primary,#1f1f1f);box-shadow:0 3px 10px rgba(24,28,36,.10);backdrop-filter:blur(10px) saturate(1.1);-webkit-backdrop-filter:blur(10px) saturate(1.1)}',
    '.wbs-message-nav-marker:focus-visible{box-shadow:0 0 0 2px color-mix(in srgb,var(--wb-accent-blue,#4f86ff) 62%,transparent),0 3px 10px rgba(24,28,36,.10)}',
    '.wbs-message-nav-dot{display:block;width:5px;height:min(2px,var(--wbs-message-nav-marker-height,12px));border-radius:2px;background:currentColor;opacity:.62;transition:width .18s ease,opacity .18s ease}',
    '.wbs-message-nav-marker:hover .wbs-message-nav-dot,.wbs-message-nav-marker:focus-visible .wbs-message-nav-dot{width:11px;opacity:.82}',
    '.wbs-message-nav-marker.is-active .wbs-message-nav-dot{width:14px;opacity:1}',
    '.wbs-message-nav-tooltip{position:absolute;width:var(--wbs-message-nav-tooltip-max,300px);max-height:min(42vh,320px);box-sizing:border-box;overflow:hidden;padding:10px 11px;border:1px solid var(--wb-border-subtle,rgba(20,24,32,.14));border-radius:8px;background:color-mix(in srgb,var(--wb-bg-popover,#fff) 84%,transparent);color:var(--wb-color-text-primary,#1f1f1f);box-shadow:0 12px 34px rgba(20,24,32,.18),inset 0 1px 0 rgba(255,255,255,.38);backdrop-filter:blur(22px) saturate(1.24);-webkit-backdrop-filter:blur(22px) saturate(1.24);pointer-events:none;opacity:0;transform:translateY(-50%) translateX(3px);transition:opacity .18s ease,transform .18s ease}',
    '.wbs-message-nav-tooltip.is-left{right:calc(100% + 10px)}.wbs-message-nav-tooltip.is-right{left:calc(100% + 10px)}',
    '.wbs-message-nav-tooltip.is-visible{opacity:1;transform:translateY(-50%) translateX(0)}',
    '.wbs-message-nav-prompt,.wbs-message-nav-response{display:-webkit-box;overflow:hidden;-webkit-box-orient:vertical;word-break:break-word;letter-spacing:0}',
    '.wbs-message-nav-prompt{-webkit-line-clamp:4;font-size:12px;font-weight:600;line-height:1.55;color:var(--wb-color-text-primary,#1f1f1f)}',
    '.wbs-message-nav-response{-webkit-line-clamp:6;margin-top:7px;padding-top:7px;border-top:1px solid var(--wb-border-subtle,rgba(20,24,32,.12));font-size:11px;font-weight:400;line-height:1.55;color:var(--wb-color-text-secondary,#5f626a)}',
    '.wbs-message-nav-highlight{animation:wbs-message-nav-highlight .7s ease-out}',
    '@keyframes wbs-message-nav-highlight{0%{box-shadow:0 0 0 3px color-mix(in srgb,var(--wb-accent-blue,#4f86ff) 48%,transparent)}100%{box-shadow:0 0 0 8px transparent}}',
    /* WorkBuddy 内置引用 tooltip 复用快捷短语的气泡风格，长文本在气泡内滚动 */
    '.sq-tooltip-wrapper{width:max-content!important;max-width:calc(100vw - 24px)!important;padding:0!important;border:1px solid color-mix(in srgb,var(--wb-border-subtle,#ececec) 65%,transparent)!important;border-radius:8px!important;background:var(--wb-bg-popover,#fff)!important;box-shadow:0 6px 20px rgba(0,0,0,.16)!important;color:var(--wb-color-text-primary,#1f1f1f)}',
    '.sq-tooltip-wrapper .sq-popover,.sq-tooltip-wrapper .sq-image-preview{width:max-content;max-width:min(240px,calc(100vw - 24px));max-height:min(48vh,240px);box-sizing:border-box;padding:5px 11px;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain}',
    '.sq-tooltip-wrapper .sq-popover__row--title,.sq-tooltip-wrapper .sq-image-preview__title-row{display:none!important}',
    '.sq-tooltip-wrapper .sq-popover__locate-btn,.sq-tooltip-wrapper .sq-image-preview__locate-fab{display:none!important}',
    '.sq-tooltip-wrapper .sq-popover__row--selection{align-items:flex-start}',
    '.sq-tooltip-wrapper .sq-popover__preview{display:block;max-height:min(44vh,220px);overflow-x:hidden;overflow-y:auto;overflow-wrap:anywhere;word-break:break-word;white-space:pre-wrap;text-overflow:clip;scrollbar-width:thin}',
    'html.cb-dark .sq-tooltip-wrapper{background:var(--wb-bg-popover,#202126)!important;border-color:color-mix(in srgb,var(--wb-border-subtle,#ececec) 65%,transparent)!important;color:var(--wb-color-text-primary,#f2f3f5)}',
    /* 复用 WorkBuddy 官方 InputContextTag 的消息图标与关闭图标，仅修正 sceneTag 的 hover 覆盖规则。 */
    '.slate-selection-quote-sceneTag._hasCloseIcon:hover [class*="iconContainer"],.slate-selection-quote-sceneTag__readOnly._hasCloseIcon:hover [class*="iconContainer"]{visibility:hidden!important}',
    '.wbs-selection-quote-btn{position:fixed;z-index:1000;display:none;align-items:center;justify-content:center;min-width:64px;height:30px;box-sizing:border-box;padding:0 10px;border:1px solid var(--wb-border-subtle,rgba(20,24,32,.18));border-radius:8px;background:color-mix(in srgb,var(--wb-bg-popover,#fff) 72%,transparent);color:var(--wb-color-text-primary,#1f1f1f);box-shadow:0 7px 18px rgba(20,24,32,.2),inset 0 1px 0 rgba(255,255,255,.45);backdrop-filter:blur(12px) saturate(1.2);-webkit-backdrop-filter:blur(12px) saturate(1.2);cursor:pointer;outline:none;font:inherit;font-size:12px;line-height:1;white-space:nowrap;transition:background .15s,border-color .15s,box-shadow .15s;color-scheme:light}',
    '.wbs-selection-quote-btn:hover,.wbs-selection-quote-btn:focus-visible{background:color-mix(in srgb,var(--wb-bg-hover,#f3f3f3) 86%,transparent);border-color:var(--wb-border-default,#d5d5d5);box-shadow:0 8px 20px rgba(20,24,32,.2),inset 0 1px 0 rgba(255,255,255,.35)}',
    'html.cb-dark .wbs-selection-quote-btn,html[data-theme="dark"] .wbs-selection-quote-btn,body[data-vscode-theme-name*="dark" i] .wbs-selection-quote-btn{background:color-mix(in srgb,var(--wb-bg-popover,#202126) 70%,transparent);border-color:var(--wb-border-subtle,rgba(255,255,255,.16));color:var(--wb-color-text-primary,#f2f3f5);box-shadow:0 8px 22px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.08);color-scheme:dark}',
    'html.cb-dark .wbs-selection-quote-btn:hover,html.cb-dark .wbs-selection-quote-btn:focus-visible,html[data-theme="dark"] .wbs-selection-quote-btn:hover,html[data-theme="dark"] .wbs-selection-quote-btn:focus-visible,body[data-vscode-theme-name*="dark" i] .wbs-selection-quote-btn:hover,body[data-vscode-theme-name*="dark" i] .wbs-selection-quote-btn:focus-visible{background:color-mix(in srgb,var(--wb-bg-hover,#303238) 84%,transparent);border-color:var(--wb-border-subtle,rgba(255,255,255,.2));box-shadow:0 9px 24px rgba(0,0,0,.38),inset 0 1px 0 rgba(255,255,255,.08)}',
    'html.cb-dark .wbs-message-nav-rail,html[data-theme="dark"] .wbs-message-nav-rail,body[data-vscode-theme-name*="dark" i] .wbs-message-nav-rail{background:color-mix(in srgb,var(--wb-bg-popover,#202126) 14%,transparent);border-color:transparent;box-shadow:none;backdrop-filter:none;-webkit-backdrop-filter:none}',
    'html.cb-dark .wbs-message-nav-rail:hover,html.cb-dark .wbs-message-nav-rail:focus-within,html[data-theme="dark"] .wbs-message-nav-rail:hover,html[data-theme="dark"] .wbs-message-nav-rail:focus-within,body[data-vscode-theme-name*="dark" i] .wbs-message-nav-rail:hover,body[data-vscode-theme-name*="dark" i] .wbs-message-nav-rail:focus-within{background:color-mix(in srgb,var(--wb-bg-popover,#202126) 44%,transparent);border-color:var(--wb-border-subtle,rgba(255,255,255,.12));box-shadow:0 6px 20px rgba(0,0,0,.28);backdrop-filter:blur(14px) saturate(1.12);-webkit-backdrop-filter:blur(14px) saturate(1.12)}',
    'html.cb-dark .wbs-message-nav-tooltip,html[data-theme="dark"] .wbs-message-nav-tooltip,body[data-vscode-theme-name*="dark" i] .wbs-message-nav-tooltip{background:color-mix(in srgb,var(--wb-bg-popover,#202126) 70%,transparent);border-color:var(--wb-border-subtle,rgba(255,255,255,.14));color:var(--wb-color-text-primary,#f2f3f5);box-shadow:0 14px 38px rgba(0,0,0,.42),inset 0 1px 0 rgba(255,255,255,.08)}',
    '@media (prefers-reduced-motion:reduce){.wbs-message-nav-marker,.wbs-message-nav-dot,.wbs-message-nav-tooltip{transition:none!important}.wbs-message-nav-highlight{animation:none!important}}',
    /* 机器人悬浮按钮（bitter-dragon-16 移植）：静态版 0.5 倍 · 无头顶尖角 · 眼睛双眨 */
    '.wbs-fab{position:fixed;right:22px;bottom:22px;z-index:2147483647;transform:scale(0.5);transform-origin:bottom right;cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none;will-change:right,bottom}',
    '.wbs-fab-health-dot{position:absolute;top:-5px;left:-5px;width:14px;height:14px;border-radius:50%;background:#8b8f98;border:2px solid #141416;box-shadow:0 1px 3px rgba(0,0,0,.5);z-index:3}',
    '.wbs-fab-health-dot.running{background:#4da3ff}.wbs-fab-health-dot.blocked{background:#ffb03a}.wbs-fab-health-dot.error{background:#ef6262}.wbs-fab-health-dot.suspected{background:#f08a3c}.wbs-fab-health-dot.stopped{background:#9ca3af}',
    '.wbs-health-status{display:none;align-items:center;min-height:18px;padding:2px 7px;border-radius:999px;font-size:10px;line-height:14px;white-space:nowrap;color:var(--wb-color-text-secondary,#666);background:var(--wb-bg-tertiary,#f2f2f2)}',
    '.wbs-health-status.running,.wbs-health-status.blocked,.wbs-health-status.error,.wbs-health-status.suspected,.wbs-health-status.stopped{display:inline-flex}',
    '.wbs-health-status.running{color:#2369a8;background:rgba(77,163,255,.14)}.wbs-health-status.blocked{color:#9a5b00;background:rgba(255,176,58,.18)}.wbs-health-status.error{color:#a52828;background:rgba(239,98,98,.16)}.wbs-health-status.suspected{color:#9a4d0a;background:rgba(240,138,60,.17)}.wbs-health-status.stopped{color:var(--wb-color-text-secondary,#666)}',
    'html.cb-dark .wbs-health-status.running,html[data-theme="dark"] .wbs-health-status.running{color:#b9dcff;background:rgba(77,163,255,.22)}html.cb-dark .wbs-health-status.blocked,html[data-theme="dark"] .wbs-health-status.blocked{color:#ffd58d;background:rgba(255,176,58,.24)}html.cb-dark .wbs-health-status.error,html[data-theme="dark"] .wbs-health-status.error{color:#ffb3b3;background:rgba(239,98,98,.25)}html.cb-dark .wbs-health-status.suspected,html[data-theme="dark"] .wbs-health-status.suspected{color:#ffc18d;background:rgba(240,138,60,.24)}',
    /* 休眠呼吸灯 keyframes（天线圆点禁用休眠时呼吸；默认毛玻璃由 .wbs-fab-antenna-dot 提供） */
    '@keyframes wbs-sleep-pulse{0%,100%{box-shadow:0 0 5px 1px rgba(46,229,157,.6)}50%{box-shadow:0 0 13px 4px rgba(46,229,157,.95)}}',
    '@keyframes wbs-sleep-pulse-amber{0%,100%{box-shadow:0 0 5px 1px rgba(255,176,58,.6)}50%{box-shadow:0 0 13px 4px rgba(255,176,58,.95)}}',
    '.wbs-fab.hidden{display:none}',
    '.wbs-fab .click{position:relative}',
    '.wbs-fab .click > span:not(.wbs-fab-antenna){display:none}',
    '.wbs-fab .button.shadow{display:none}',
    '.wbs-fab .button{position:relative;left:0;top:0;transform:none;cursor:pointer;border:solid 4px rgba(255,255,255,0);background-color:rgba(20,20,22,.55);backdrop-filter:blur(14px) saturate(1.3);-webkit-backdrop-filter:blur(14px) saturate(1.3);font-size:20px;color:#fff;border-color:rgba(255,255,255,0);box-shadow:0 4px 14px rgba(0,0,0,.45),inset 0 0 0 1px rgba(255,255,255,.08);border-radius:50px;display:flex;align-items:center;justify-content:center;width:100px;height:48px;box-sizing:content-box;padding:0;margin:0;outline:none;transition:background-color .2s,color .2s}',
    /* 贴消息队列时（queue 上方）保持纯色背景（与默认黑色一致，逻辑保留） */
    '.wbs-fab.fab--solid .button{background:#141416;box-shadow:0 4px 14px rgba(0,0,0,.45)}',
    '.wbs-fab .button:before,.wbs-fab .button:after{display:none}',
    '.wbs-fab .button.up{z-index:2}',
    /* 天线：SVG mask 数学绘制「圆 + 杆」一体图形（用户 08-30 01:22 修正杆底穿透：设计值 +4px 上移，
   scale(0.5) 折算后杆底视觉停在按钮顶上方约 2px，不再穿入头部） */
    '.wbs-fab-antenna{position:absolute;left:50%;top:-28px;width:14px;height:24px;transform:translateX(-50%);background:rgba(20,20,22,.55);backdrop-filter:blur(14px) saturate(1.3);-webkit-backdrop-filter:blur(14px) saturate(1.3);z-index:2;pointer-events:none;mask-image:url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 14 24\'><rect x=\'5\' y=\'14\' width=\'4\' height=\'10\'/><circle cx=\'7\' cy=\'7\' r=\'7\'/></svg>");-webkit-mask-image:url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 14 24\'><rect x=\'5\' y=\'14\' width=\'4\' height=\'10\'/><circle cx=\'7\' cy=\'7\' r=\'7\'/></svg>");mask-size:14px 24px;-webkit-mask-size:14px 24px;mask-repeat:no-repeat;-webkit-mask-repeat:no-repeat}',
    /* 呼吸灯圆点：独立于 mask 容器（避免 mask/backdrop-filter 裁剪呼吸辉光），相对 button 定位到天线圆点位置（ant top:-28 内圆占 y0~14 → button 上 -28~-14） */
    '.wbs-fab-antenna-dot{position:absolute;left:50%;top:-28px;width:14px;height:14px;transform:translateX(-50%);border-radius:50%;background:transparent;pointer-events:none;z-index:4}',
    /* 休眠呼吸灯：天线顶部圆点（用户 08-30 00:20 要求替代右上角绿点；08-30 00:37 默认改毛玻璃半透明而非纯黑）——默认毛玻璃，禁止休眠时绿/琥珀呼吸 */
    '#wbs-fab-sleep-light{transition:background .25s,box-shadow .25s}',
    '#wbs-fab-sleep-light.sleep-on{background:rgba(46,229,157,.85);box-shadow:0 0 8px 2px rgba(46,229,157,.85);animation:wbs-sleep-pulse 2.2s ease-in-out infinite}',
    '#wbs-fab-sleep-light.sleep-until-done{background:rgba(255,176,58,.85);box-shadow:0 0 8px 2px rgba(255,176,58,.85);animation:wbs-sleep-pulse-amber 2.2s ease-in-out infinite}',
    '.wbs-fab .click .button .speak~.speak{display:none}',
    '.wbs-fab .speak{position:relative;z-index:2;font-size:15px}',
    '.wbs-fab .wrap{position:relative;width:100px;height:40px;margin:0 2rem;color:#fff;line-height:40px;font-size:2rem;text-align:center;font-weight:400;margin-bottom:0;display:flex;gap:5px}',
    '.wbs-fab .eye{position:relative;margin:auto;top:0;bottom:0;background:#fff;width:40px;height:40px;border-radius:50%;display:inline-block;animation:wbs-cc-double-blink 4s cubic-bezier(0.785,0.135,0.15,0.86) infinite;overflow:hidden}',
    '@keyframes wbs-cc-double-blink{0%,8%{height:40px}10%,12%{height:10px}13%{height:40px}14%,16%{height:0}18%,100%{height:40px}}',
    '.wbs-fab .eye:before{content:"";position:absolute;margin:auto;width:10px;height:10px;left:0;right:0;top:0;bottom:0;border-radius:50%;background:rgba(20,20,22,.55);backdrop-filter:blur(14px) saturate(1.3);-webkit-backdrop-filter:blur(14px) saturate(1.3);box-shadow:inset 0 0 3px rgba(0,0,0,.35),0 0 0 1px rgba(255,255,255,.14)}',
    '.wbs-fab .down:before{animation:wbs-cc-downb 4s cubic-bezier(0.785,0.135,0.15,0.86) infinite}',
    '@keyframes wbs-cc-downb{0%,10%{top:0;left:-10px}20%,40%{top:50%;left:-10px}50%,100%{top:0;left:-10px}}',
    '.wbs-fab .right-blink:before{animation:wbs-cc-rightb 4s cubic-bezier(0.785,0.135,0.15,0.86) infinite}',
    '@keyframes wbs-cc-rightb{0%,10%{top:0;left:50%}20%,40%{top:50%;left:50%}50%,100%{top:0;left:50%}}',
    '.wbs-fab .up-blink:before{animation:wbs-cc-upb 4s cubic-bezier(0.785,0.135,0.15,0.86) infinite}',
    '@keyframes wbs-cc-upb{0%,10%{top:0;left:0%}20%,40%{top:-50%;left:0%}50%,100%{top:0;left:0%}}',
    '.wbs-fab:hover{transform:scale(0.5)}',
    '.wbs-fab:active{transform:scale(0.5) translate(2px,2px)}',
    '.wbs-fab.is-dragging{cursor:grabbing;transition:none !important}',
    '.wbs-fab.is-dragging .button{cursor:grabbing}',
    '.wbs-fab.is-snapping{transition:right .56s cubic-bezier(.22,1.35,.36,1),bottom .56s cubic-bezier(.22,1.35,.36,1)}',
    /* 面板：毛玻璃主题（半透明 + 模糊，背景图透出） */
    '.wbs-panel{position:absolute;right:0;bottom:0;width:520px;max-width:94vw;height:650px;max-height:650px;background:color-mix(in srgb,var(--wb-bg-popover,#fff) 72%,transparent);border:1px solid var(--wb-border-subtle,#f0f0f0);border-radius:18px;box-shadow:0 20px 60px rgba(0,0,0,.28);display:none;flex-direction:column;overflow:hidden;backdrop-filter:blur(28px) saturate(1.25);-webkit-backdrop-filter:blur(28px) saturate(1.25)}',
    '.wbs-panel.show{display:flex}',
    '.wbs-head{display:flex;align-items:center;justify-content:space-between;padding:16px 18px 12px;border-bottom:1px solid var(--wb-border-subtle,#f0f0f0);background:color-mix(in srgb,var(--wb-bg-secondary,#fff) 30%,transparent)}',
    '.wbs-head-left{display:flex;align-items:center;gap:9px;min-width:0}',
    '.wbs-title{font-size:16px;font-weight:700;color:var(--wb-color-text-primary,#1f1f1f);letter-spacing:.3px;cursor:pointer;user-select:none}',
    /* 元素检查拾取按钮（隐藏入口，连点标题 5 次显示） */
    '.wbs-pick-btn{flex:0 0 auto;width:22px;height:22px;border:none;border-radius:7px;background:color-mix(in srgb,var(--wb-accent-blue,#4f86ff) 14%,transparent);color:var(--wb-accent-blue,#4f86ff);font-size:12px;line-height:1;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;transition:background .15s}',
    '.wbs-pick-btn:hover{background:color-mix(in srgb,var(--wb-accent-blue,#4f86ff) 24%,transparent)}',
    '.wbs-ghbtn{display:flex;align-items:center;justify-content:center;width:24px;height:24px;flex-shrink:0;color:var(--wb-icon-tertiary,#999);border-radius:6px;text-decoration:none;transition:color .15s,background .15s}',
    '.wbs-ghbtn:hover{color:var(--wb-color-text-primary,#1f1f1f);background:var(--wb-bg-hover,#f5f5f5)}',
    '.wbs-ghbtn svg{display:block}',
    '.wbs-btn-close{border:none;background:none;color:var(--wb-icon-tertiary,#999);font-size:16px;cursor:pointer;padding:4px 6px;border-radius:6px;line-height:1}',
    '.wbs-btn-close:hover{color:var(--wb-color-text-primary,#1f1f1f);background:var(--wb-bg-hover,#f5f5f5)}',
    '.wbs-body{overflow-y:auto;padding:10px 10px 6px;flex:1;min-height:0;height:calc(650px - 170px);max-height:none}',
    /* 账号卡片：头像 + 信息 + 右侧操作 */
    '.wbs-card{display:block;position:relative;padding:10px 12px;border-radius:12px;margin-bottom:4px;transition:background .12s}',
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
    '.wbs-phone-cell{gap:4px}',
    // UIN 模式（国际版无手机号时用 UIN 替代）：标签与数字之间保留正常间距
    '.wbs-phone-cell.wbs-uin-cell{gap:4px}',
    '.wbs-token-cell{justify-content:flex-end}',
    '.wbs-phone-cell .wbs-lbl,.wbs-credit-left .wbs-lbl{width:28px}',
    '.wbs-token-cell .wbs-lbl{width:48px}',
    '.wbs-phone-cell .wbs-val,.wbs-token-cell .wbs-val{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.wbs-lbl{color:var(--wb-icon-tertiary,#999);flex-shrink:0;width:60px;white-space:nowrap}',
    '.wbs-val{color:var(--wb-color-text-primary,#1f1f1f);font-variant-numeric:tabular-nums;word-break:break-all}',
    '.wbs-warn{color:#f53f3f;font-weight:600}',
    /* 积分到期分布：每个色块代表一个独立额度，悬浮显示额度与到期时间 */
    '.wbs-credit-cell{display:block!important;width:100%;min-width:0}',
    '.wbs-credit-hidden{display:none!important}',
    '.wbs-credit-block{width:100%;min-width:0}',
    '.wbs-credit-line{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:6px;min-width:0}',
    '.wbs-credit-left{display:inline-flex;align-items:center;gap:4px;min-width:0}',
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
    '.wbs-credit-hint{color:var(--wb-icon-tertiary,#999);font-size:10px;line-height:1.4;margin-top:2px}',
    '.wbs-account-tags{display:inline-flex;align-items:center;gap:5px;min-width:0;margin-left:auto}',
    '.wbs-usage-tag{display:inline-flex;align-items:center;gap:4px;min-width:0;white-space:nowrap;color:var(--wb-color-text-primary,#1f1f1f);font-size:12px;font-weight:400;font-variant-numeric:tabular-nums}',
    '.wbs-usage-tag svg{width:14px;height:14px;flex:0 0 14px}',
    '.wbs-usage-tag b{font-weight:700}',
    'html.cb-dark .wbs-usage-tag,html[data-theme="dark"] .wbs-usage-tag{color:var(--wb-color-text-primary,#f3f5fa)}',
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
    /* 版本标签（昵称旁：个人版 / 企业名称）：低饱和浅灰，信息次要不抢眼；深色主题单独适配 */
    '.wbs-badge{display:inline-flex;align-items:center;font-size:10px;line-height:1;padding:2px 7px;border-radius:999px;flex-shrink:1;min-width:0;max-width:112px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;background:var(--wb-bg-tertiary,#eef0f3);color:var(--wb-color-text-secondary,#5f6368);border:1px solid transparent}',
    'html.cb-dark .wbs-badge,html[data-theme="dark"] .wbs-badge{background:rgba(255,255,255,.07);color:rgba(235,236,240,.68);border-color:rgba(255,255,255,.08)}',
    /* 当前使用中角标：无底图形，颜色跟随昵称（text-primary），深色随变量自动适配 */
    '.wbs-cur-marker{position:absolute;top:9px;right:12px;display:inline-flex;color:var(--wb-icon-secondary,#555);opacity:.9}',
    '.wbs-cur-marker svg{display:block}',
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
'.wbs-ac-log-wrap{margin-top:8px;border:1px solid var(--wb-border-subtle,#f0f0f0);border-radius:9px;background:color-mix(in srgb,var(--wb-bg-secondary,#fff) 55%,transparent);overflow:hidden}',
'.wbs-ac-log-head{display:flex;align-items:center;justify-content:space-between;padding:5px 8px;font-size:11px;color:var(--wb-icon-secondary,#555);border-bottom:1px solid var(--wb-border-subtle,#f0f0f0)}',
'.wbs-ac-log-clear{cursor:pointer;color:var(--wb-icon-tertiary,#999);user-select:none}',
'.wbs-ac-log-clear:hover{color:var(--wb-color-text-primary,#1f1f1f)}',
'.wbs-ac-log{margin:0;padding:6px 8px;max-height:180px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.55;color:var(--wb-icon-secondary,#555);white-space:pre-wrap;word-break:break-all}',
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
    // 新版布局内联进操作栏按钮组（flex）：取消 fixed 参与布局，保持与其他按钮一致的圆形
    '.wbs-stash-inline.wbs-stash-inline-inline{position:static;left:auto;right:auto;top:auto;border-radius:50%;box-shadow:none}',
    '.wbs-stash-inline.wbs-stash-inline-inline:hover{width:113px;border-radius:40px}',
    '.wbs-stash-inline .wbs-stash-ico{display:flex;align-items:center;justify-content:center;flex-shrink:0}',
    '.wbs-stash-inline .wbs-stash-ico svg{width:16px;height:16px;display:block}',
    '.wbs-stash-inline .wbs-stash-txt{opacity:0;max-width:0;overflow:hidden;white-space:nowrap;font-size:13px;font-weight:500;margin-left:0;transition:opacity .2s,max-width .25s,margin-left .25s}',
    '.wbs-stash-inline:hover{width:113px;border-radius:40px;padding-right:5px}',
    '.wbs-stash-inline:hover .wbs-stash-txt{opacity:1;max-width:76px;margin-left:7px}',
    '.wbs-explore-inline{position:fixed;left:auto;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;z-index:auto;top:0;right:0;overflow:visible;padding:0 8px}',
    /* 复用暂存按钮视觉（wbs-stash-inline 提供 32px 圆形/背景/阴影），但 hover 不变宽 */
    '.wbs-stash-inline.wbs-explore-inline:hover{width:32px;height:32px;border-radius:50%;padding:0 8px}',
    /* 图标常显；hover 无任何自身动画 */
    '.wbs-explore-ico{display:flex;align-items:center;justify-content:center}',
    /* 新版内联模式：弹层(absolute)必须以按钮自身为定位上下文——static 会让 .wbs-explore-pop 的 bottom:100% 上溯到最近的 positioned 祖先（操作栏外壳），导致弹层大幅偏离按钮；z-index 抬升让按钮成为独立层叠上下文，弹层在其内不受操作栏兄弟元素压制 */
    '.wbs-explore-inline.wbs-stash-inline-inline{position:relative;z-index:99999}',
    /* 按钮不可点击缩放（点击不改变按钮自身与面板大小），菜单全由 hover 展示 */
    '.wbs-explore-inline:active{transform:none}',
    '.wbs-explore-pop{position:absolute;bottom:calc(100% + 10px);left:50%;transform:translateX(-50%) translateY(6px);width:280px;max-width:84vw;opacity:0;visibility:hidden;transition:opacity .18s ease,transform .18s ease,visibility 0s linear .18s;z-index:2147483647;pointer-events:none}',
    /* hover 桥接：向下覆盖按钮与弹窗之间的 10px 间隙，按钮→弹窗移动不丢失悬停（菜单雏形） */
    '.wbs-explore-pop::before{content:"";position:absolute;left:-12px;right:-12px;bottom:-14px;height:14px}',
    '.wbs-explore-inline:hover .wbs-explore-pop,.wbs-explore-pop:hover{opacity:1;visibility:visible;transform:translateX(-50%) translateY(0);pointer-events:auto}',
    /* 点击选项后关闭面板（wbs-menu-closed 期间强制隐藏，重新进入按钮区后恢复可展示） */
    '.wbs-explore-inline.wbs-menu-closed .wbs-explore-pop{opacity:0;visibility:hidden;pointer-events:none;transform:translateX(-50%) translateY(6px)}',
    /* 弹窗卡片：适配插件主题的毛玻璃；面板整体为默认箭头，仅选项 hover 变点击手型 */
    '.wbs-explore-card{position:relative;padding:8px;border-radius:12px;background:color-mix(in srgb,var(--wb-bg-popover,#fff) 62%,transparent);backdrop-filter:blur(18px) saturate(1.3);-webkit-backdrop-filter:blur(18px) saturate(1.3);border:1px solid var(--wb-border-subtle,#ececec);box-shadow:0 12px 32px rgba(0,0,0,.18);color:var(--wb-color-text-primary,#1f1f1f);cursor:default}',
    '.wbs-explore-item{position:relative;display:flex;align-items:center;gap:8px;padding:9px 10px;border-radius:8px;font-size:12px;color:var(--wb-color-text-primary,#1f1f1f);line-height:1.4;cursor:pointer}',
    '.wbs-explore-it{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.wbs-explore-item:hover{background:color-mix(in srgb,var(--wb-bg-hover,#f3f3f3) 76%,transparent)}',
    /* 选项 hover：antd 风格 tooltip（半透明毛玻璃小气泡，出现在选项左侧，完全展示文字） */
    '.wbs-explore-tip{position:absolute;right:calc(100% + 10px);top:50%;transform:translateY(-50%);display:block;width:max-content;padding:5px 11px;border-radius:8px;font-size:11px;line-height:1.35;white-space:normal;word-break:break-word;max-width:240px;color:var(--wb-color-text-primary,#1f1f1f);background:var(--wb-bg-popover,#fff);border:1px solid color-mix(in srgb,var(--wb-border-subtle,#ececec) 65%,transparent);box-shadow:0 6px 20px rgba(0,0,0,.16);opacity:0;visibility:hidden;transition:opacity .15s ease;pointer-events:none;z-index:2}',
    /* 滚动条默认透明，滚动/悬停时才出现（内容多时可上下滚动，内容少完全展示无滚动条） */
    '.wbs-explore-tip-body{display:block;max-height:240px;overflow-y:auto;scrollbar-width:thin;scrollbar-color:transparent transparent;white-space:normal;word-break:break-word}',
    '.wbs-explore-tip-body::-webkit-scrollbar{width:6px}',
    '.wbs-explore-tip-body::-webkit-scrollbar-thumb{background:transparent;border-radius:3px}',
    '.wbs-explore-tip-body:hover::-webkit-scrollbar-thumb,.wbs-explore-tip-body::-webkit-scrollbar-thumb:hover{background:color-mix(in srgb,var(--wb-icon-secondary,#666) 45%,transparent)}',
    '.wbs-explore-tip::before{content:"";position:absolute;left:100%;top:50%;transform:translateY(-50%);border:5px solid transparent;border-left-color:var(--wb-border-subtle,#ececec)}',
    /* tooltip 显隐由 JS（mouseenter/mouseleave + 延迟）控制，CSS 不参与（避免合成器 hover 判定差异导致闪烁） */
    '.wbs-explore-foot{display:flex;align-items:center;justify-content:space-between;padding:10px 6px 4px;margin-top:2px;border-top:1px solid var(--wb-border-subtle,#ececec)}',
    '.wbs-explore-send-txt{font-size:12px;color:color-mix(in srgb,var(--wb-color-text-primary) 40%,transparent)}',
    '.wbs-explore-edit{font-size:12px;font-weight:500;color:var(--wb-icon-secondary,#666);text-decoration:none;cursor:pointer}',
    '.wbs-explore-edit:hover{color:var(--wb-color-text-primary,#1f1f1f)}',
    '.wbs-stash-inline:active{background:var(--wb-button-primary-bg)}',
    /* 队列消息「暂存提示词」标签：入队的暂存消息在操作按钮最左侧 */
    '.wbs-queue-tag{display:inline-flex;align-items:center;gap:4px;background:color-mix(in srgb,var(--wb-color-text-primary) 8%,transparent);color:var(--wb-color-text-secondary);border-radius:999px;font-size:11px;line-height:1;padding:5px 10px 5px 8px;margin-right:6px;font-weight:600;user-select:none;vertical-align:middle;white-space:nowrap}',
    '.wbs-queue-tag svg{flex-shrink:0}',
    /* 会话模块 · 快捷短语列表区（增强页） */
    '.wbs-qp-area{margin-top:10px;border-top:1px solid var(--wb-border-subtle,#eee);padding-top:10px}',
    '.wbs-qp-toolbar{display:flex;align-items:center;gap:8px;margin-bottom:8px}',
    '.wbs-qp-toolbar-spacer{flex:1}',
    '.wbs-qp-batchbar{display:inline-flex;align-items:center;gap:6px;margin-right:8px}',
    '.wbs-qp-batch-count{font-size:11px;color:var(--wb-color-text-secondary,#666)}',
    '.wbs-qp-batch-action{color:#d64545}',
    '.wbs-qp-list{display:flex;flex-direction:column;max-height:220px;overflow-y:auto}',
    '.wbs-qp-row{display:flex;align-items:center;gap:8px;padding:5px 8px;border-bottom:1px solid var(--wb-border-subtle,#eee)}',
    '.wbs-qp-row:hover{background:color-mix(in srgb,var(--wb-bg-hover,#f3f3f3) 45%,transparent)}',
    '.wbs-qp-check{margin:0;width:14px;height:14px;flex:0 0 auto;accent-color:var(--wb-button-primary-bg,#1f1f1f)}',
    '.wbs-qp-text{flex:1;font-size:12px;line-height:1.5;color:var(--wb-color-text-primary,#1f1f1f);overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;white-space:nowrap;word-break:break-all}',
    '.wbs-qp-actions{display:flex;gap:2px;flex-shrink:0;opacity:0;transition:opacity .12s}',
    '.wbs-qp-row:hover .wbs-qp-actions,.wbs-qp-row:focus-within .wbs-qp-actions{opacity:1}',
    '.wbs-qp-icon-btn{display:flex;align-items:center;justify-content:center;width:24px;height:24px;border:none;border-radius:6px;background:transparent;color:var(--wb-icon-secondary,#666);cursor:pointer;flex-shrink:0}',
    '.wbs-qp-icon-btn:hover{background:color-mix(in srgb,var(--wb-bg-hover,#f3f3f3) 80%,transparent);color:var(--wb-color-text-primary,#1f1f1f)}',
    '.wbs-qp-icon-btn.wbs-qp-del:hover{color:#d64545}',
    '.wbs-qp-empty{font-size:12px;color:var(--wb-color-text-secondary,#666);text-align:center;padding:14px 0}',
    '.wbs-qp-empty-menu{padding:10px 0 4px}',
    '.wbs-qp-textarea{width:100%;min-height:96px;max-height:150px;resize:vertical;padding:8px 10px;border-radius:8px;border:1px solid var(--wb-border-default,#e5e5e5);background:var(--wb-bg-input,var(--wb-bg-primary,#fff));color:var(--wb-color-text-primary,#1f1f1f);font-size:13px;line-height:1.6;outline:none;box-sizing:border-box}',
    '.wbs-qp-textarea:focus{border-color:var(--wb-accent,#185fa5)}',
    '.wbs-password-field textarea.wbs-qp-textarea{margin-top:6px}',
    /* 暂存项禁拖 + 隐藏拖拽图标：data-wbs-stash 由 syncQueueTags 幂等标记，普通项不受影响 */
    '.cb-message-queue-item[data-wbs-stash="1"]{cursor:default}',
    '.cb-message-queue-item[data-wbs-stash="1"] .cb-message-queue-item-left .prompt-icon{visibility:hidden}',
    '.cb-message-queue-item[data-wbs-stash="1"] .cb-message-queue-item-left .prompt-ico,.cb-message-queue-item[data-wbs-stash="1"] .cb-message-queue-item-left .prompt-icon{display:none !important;width:0 !important;margin:0 !important}',
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
    '.wbs-pcard-title{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700;color:var(--wb-color-text-primary,#1f1f1f);margin-bottom:8px}',
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
    '.wbs-sess-filters{display:flex;flex-direction:row;align-items:center;gap:8px;margin-bottom:10px}',
    // 账号 + 时间筛选同一行：账号下拉缩窄，时间分段占用剩余宽度
    '.wbs-sess-filter-row{display:flex;align-items:center;gap:8px;flex:0 0 auto}',
    '.wbs-sess-filter-row:last-child{flex:1 1 auto;min-width:0}',
    '#wbs-sess-account-select{max-width:112px}',
    /* 会话页/模型页：卡片与列表贴底，减少底部留白 */
    '.wbs-pane[data-pane="sessions"]{padding-bottom:1px}',
    '.wbs-pane[data-pane="sessions"] > .wbs-pcard{margin-bottom:0;padding-bottom:4px}',
    '.wbs-pane[data-pane="sessions"] .wbs-sess-list{margin-bottom:0}',
    '.wbs-pane[data-pane="models"]{padding-bottom:1px}',
    '.wbs-pane[data-pane="models"] > .wbs-pcard{margin-bottom:0;padding-bottom:4px}',
    /* 批量操作行按钮与「批量操作」按钮同高 */
    '.wbs-sess-toolbar .wbs-sess-bbtn,#wbs-sess-batchbar .wbs-sess-bbtn{height:30px;padding:0 12px}',
    /* 会话页卡片纵向撑满面板剩余高度，列表 flex 吸收多余空间 */
    '.wbs-pane[data-pane="sessions"] > .wbs-pcard{display:flex;flex-direction:column;flex:1 1 auto;min-height:0}',
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
    '.wbs-sess-batchbar{display:flex;align-items:center;gap:5px;flex-wrap:nowrap;margin:0;padding:0;border:none;background:transparent}',
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
    '.wbs-model-batchbar{display:flex;align-items:center;gap:5px;flex-wrap:nowrap;margin:0;padding:0;border:none;background:transparent}',
    '.wbs-model-batch-count{font-size:11px;color:var(--wb-icon-tertiary,#999);white-space:nowrap}',
    '.wbs-model-batch-action:disabled{opacity:.45;cursor:not-allowed}',
    '.wbs-model-toolbar .wbs-sess-bbtn,#wbs-model-batchbar .wbs-sess-bbtn{height:30px;padding:0 12px}',
    '.wbs-sess-batch-count{font-size:11px;color:var(--wb-icon-tertiary,#999);white-space:nowrap}',
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
    '.wbs-sess-list{flex:1 1 auto;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:6px;margin-bottom:8px;scrollbar-width:thin;scrollbar-color:transparent transparent}',
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
    '.wbs-about-support{display:flex;align-items:center;justify-content:flex-start;gap:10px;width:100%;box-sizing:border-box;margin-top:3px;padding:9px 0;border-top:1px solid var(--wb-border-default,rgba(0,0,0,.08));border-bottom:1px solid var(--wb-border-default,rgba(0,0,0,.08));flex-wrap:nowrap}',
    '.wbs-about-name-row{display:flex;align-items:center;justify-content:center;gap:10px;flex-wrap:wrap}',
    '.wbs-about-name-row .wbs-about-ver{font-family:ui-monospace,SF Mono,Menlo,monospace;font-size:11px;font-weight:500;color:var(--wb-icon-tertiary,#999);letter-spacing:.3px;margin-top:3px}',
    '.wbs-about-support-text{min-width:0;flex:1 1 auto;font-size:11.5px;line-height:1.55;color:var(--wb-icon-tertiary,#777);text-align:left;white-space:normal;overflow-wrap:break-word}',
    '.wbs-telemetry-card{padding:6px 14px 8px;margin:2px 0 4px;background:transparent;border:none;opacity:.75}',
    '.wbs-telemetry-card .wbs-pcard-title{font-size:11px;color:var(--wb-icon-tertiary,#999)}',
    '.wbs-telemetry-card .wbs-telemetry-status{font-size:10.5px;color:var(--wb-icon-tertiary,#999)}',
    '.wbs-telemetry-ctrl{display:flex;align-items:center;gap:8px;flex-shrink:0}',
    '.wbs-telemetry-reco{font-size:10.5px;color:var(--wb-icon-tertiary,#999);white-space:nowrap}',
    '.wbs-telemetry-head{display:flex;align-items:center;justify-content:space-between;gap:12px}',
    '.wbs-telemetry-label{display:flex;align-items:center;gap:5px;min-width:0}',
    '.wbs-telemetry-label .wbs-pcard-title{margin-bottom:0}',
    '.wbs-telemetry-help{position:relative;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;color:var(--wb-icon-tertiary,#888);cursor:help;outline:none}',
    '.wbs-telemetry-help:hover,.wbs-telemetry-help:focus{color:var(--wb-color-text-primary,#1f1f1f)}',
    '.wbs-telemetry-tooltip{position:absolute;z-index:20;left:0;top:calc(100% + 7px);width:245px;padding:7px 9px;border:1px solid var(--wb-border-default,rgba(0,0,0,.14));border-radius:7px;background:var(--wb-bg-primary,#fff);box-shadow:0 6px 18px rgba(0,0,0,.14);color:var(--wb-color-text-primary,#1f1f1f);font-size:11px;font-weight:400;line-height:1.5;white-space:normal;opacity:0;visibility:hidden;pointer-events:none;transform:translateY(-2px);transition:opacity .12s,transform .12s,visibility .12s}',
    '.wbs-telemetry-help:hover .wbs-telemetry-tooltip,.wbs-telemetry-help:focus .wbs-telemetry-tooltip{opacity:1;visibility:visible;transform:translateY(0)}',
    '.wbs-telemetry-switch{flex:0 0 36px}',
    '.wbs-telemetry-status{margin-top:5px;font-size:10.5px;color:var(--wb-button-primary-bg,#1f1f1f);font-weight:600}',
    '.wbs-telemetry-status.is-off{color:var(--wb-icon-tertiary,#999);font-weight:500}',
    '.wbs-monitor-log-card{padding:7px 12px;margin:2px 0 4px;background:transparent;border:none}',
    '.wbs-monitor-log-inline{display:flex;flex-direction:column;gap:5px;min-width:0}',
    '.wbs-monitor-log-session-list{display:flex;flex-direction:column;gap:3px;max-height:92px;overflow-y:auto;overscroll-behavior:contain;padding:1px 0;scrollbar-width:thin}',
    '.wbs-monitor-log-session-btn{display:block;box-sizing:border-box;width:100%;min-height:25px;padding:4px 7px;border:1px solid var(--wb-border-subtle,#ededed);border-radius:7px;background:var(--wb-bg-secondary,#fafafa);color:var(--wb-icon-secondary,#666);font:600 10.5px/1.25 inherit;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;transition:background .15s,border-color .15s,color .15s}',
    '.wbs-monitor-log-session-btn:hover{background:var(--wb-bg-hover,#f5f5f5);color:var(--wb-color-text-primary,#1f1f1f)}',
    '.wbs-monitor-log-session-btn.active{border-color:var(--wb-button-primary-bg,#1f1f1f);background:color-mix(in srgb,var(--wb-button-primary-bg,#1f1f1f) 10%,var(--wb-bg-secondary,#fafafa));color:var(--wb-color-text-primary,#1f1f1f)}',
    '.wbs-monitor-log-list{min-height:62px;max-height:154px;overflow-y:auto;overscroll-behavior:contain;padding:5px 7px;border:1px solid var(--wb-border-subtle,#ededed);border-radius:7px;background:color-mix(in srgb,var(--wb-bg-secondary,#fafafa) 65%,transparent);font:10px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--wb-icon-secondary,#666);white-space:pre-wrap;overflow-wrap:anywhere;scrollbar-width:thin}',
    '.wbs-monitor-log-entry{padding:2px 0;border-bottom:1px solid color-mix(in srgb,var(--wb-border-subtle,#ededed) 70%,transparent);overflow-wrap:anywhere}',
    '.wbs-monitor-log-entry:last-child{border-bottom:none}',
    '.wbs-about-foot{display:flex;align-items:center;justify-content:center;gap:10px;margin-top:10px}',
    '.wbs-about-ver{font-family:ui-monospace,SF Mono,Menlo,monospace;font-size:11px;font-weight:500;color:var(--wb-icon-tertiary,#999);letter-spacing:.3px}',
    '.wbs-about-feedback{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:600;color:var(--wb-button-primary-bg,#1f1f1f);background:rgba(0,0,0,.05);padding:5px 12px;border-radius:999px;text-decoration:none;transition:background .15s;flex-shrink:0;white-space:nowrap}',
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
    /* 自定义壁纸网格：三列布局、删除按钮（悬浮显示）、选中矢量角标 */
    '.wbs-custom-wallpapers{grid-template-columns:repeat(3,1fr);margin-top:10px}',
    '.wbs-wp-custom .wbs-wp-del{position:absolute;top:4px;left:4px;z-index:3;width:20px;height:20px;border:none;border-radius:6px;background:rgba(0,0,0,.55);color:#fff;cursor:pointer;opacity:0;transition:opacity .15s;backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);padding:0;font-family:inherit;display:flex;align-items:center;justify-content:center}',
    '.wbs-wp-custom:hover .wbs-wp-del{opacity:1}',
    '.wbs-wp-custom .wbs-wp-del:hover{background:#e24b4a}',
    '.wbs-wp-del-ico{position:relative;display:block;width:10px;height:10px}',
    '.wbs-wp-del-ico::before,.wbs-wp-del-ico::after{content:"";position:absolute;left:50%;top:50%;width:10px;height:1.5px;background:currentColor;border-radius:1px;transform:translate(-50%,-50%) rotate(45deg)}',
    '.wbs-wp-del-ico::after{transform:translate(-50%,-50%) rotate(-45deg)}',
    '.wbs-wp-custom.active::after{content:"";position:absolute;top:4px;right:4px;width:16px;height:16px;border-radius:50%;background:var(--wb-button-primary-bg,#1f1f1f);box-shadow:0 0 0 2px rgba(255,255,255,.85)}',
    '.wbs-wp-custom.active::before{content:"";position:absolute;top:8px;right:8px;width:8px;height:5px;border-left:2px solid var(--wb-button-primary-fg,#fff);border-bottom:2px solid var(--wb-button-primary-fg,#fff);transform:rotate(-45deg);z-index:2}',
    '.wbs-wp-custom .wbs-wp-badge{background:rgba(0,0,0,.35)}',
    /* 主题切换 segmented（默认 / WorkDaddy / 官方内置深色主题）：样式与下方壁纸来源切换按钮统一 */
    '.wbs-theme-seg{display:flex;background:var(--wb-bg-tertiary,#f0f0f0);border-radius:10px;padding:3px;gap:3px;margin-bottom:8px}',
    '.wbs-theme-opt{flex:1;min-width:0;padding:6px 4px;border:none;border-radius:8px;background:transparent;color:var(--wb-icon-secondary,#666);font-size:12px;font-weight:600;cursor:pointer;transition:all .15s;font-family:inherit;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
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
    '.wbs-password-error{min-height:17px;margin-top:4px;color:#d14343;font-size:11px;line-height:1.5}',
    '.wbs-transfer-modal{display:flex;max-height:min(520px,calc(100% - 28px));flex-direction:column}',
    '.wbs-transfer-select-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 0 6px;color:var(--wb-icon-secondary,#666);font-size:12px}',
    '.wbs-transfer-toggle{border:0;padding:3px 0;background:transparent;color:var(--wb-button-primary-bg,#1f1f1f);font:inherit;font-size:11px;font-weight:600;cursor:pointer}',
    '.wbs-transfer-list{display:flex;min-height:0;max-height:190px;flex-direction:column;gap:5px;overflow-y:auto;margin:0 0 12px;padding-right:2px}',
    '.wbs-transfer-option{display:flex;align-items:center;gap:9px;box-sizing:border-box;width:100%;padding:8px 9px;border:1px solid var(--wb-border-default,#e5e5e5);border-radius:9px;background:var(--wb-bg-secondary,#fff);cursor:pointer;transition:background .15s,border-color .15s,box-shadow .15s}',
    '.wbs-transfer-option:hover{background:var(--wb-bg-hover,#f5f5f5);border-color:var(--wb-border-strong,#bbb)}',
    '.wbs-transfer-option.selected{border-color:var(--wb-button-primary-bg,#1f1f1f);background:color-mix(in srgb,var(--wb-button-primary-bg,#1f1f1f) 7%,var(--wb-bg-popover,#fff));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--wb-button-primary-bg,#1f1f1f) 12%,transparent)}',
    '.wbs-transfer-option input{width:15px;height:15px;flex:0 0 15px;margin:0;accent-color:var(--wb-button-primary-bg,#1f1f1f);cursor:pointer}',
    '.wbs-transfer-copy{display:flex;min-width:0;flex:1;flex-direction:column;gap:2px}',
    '.wbs-transfer-title{overflow:hidden;color:var(--wb-color-text-primary,#1f1f1f);font-size:12px;font-weight:650;line-height:1.35;text-overflow:ellipsis;white-space:nowrap}',
    '.wbs-transfer-sub{overflow:hidden;color:var(--wb-icon-tertiary,#888);font-size:11px;line-height:1.35;text-overflow:ellipsis;white-space:nowrap}',
    '.wbs-transfer-option:focus-within,.wbs-transfer-toggle:focus-visible,.wbs-modal-btn:focus-visible,.wbs-sess-bbtn:focus-visible,.wbs-acct-io:focus-visible{outline:2px solid var(--wb-accent-blue,#4f86ff);outline-offset:2px}',
    '.wbs-login-body{display:flex;flex-direction:column;gap:9px;margin-bottom:16px}',
    '.wbs-login-option{display:flex;align-items:flex-start;gap:10px;width:100%;box-sizing:border-box;padding:12px 13px;border:1px solid transparent;border-radius:11px;background:var(--wb-bg-popover,#fff);cursor:pointer;text-align:left;transition:border-color .16s,background .16s,box-shadow .16s;font-family:inherit}',
    '.wbs-login-option:hover{border-color:var(--wb-border-strong,#b9b9bd);background:var(--wb-bg-hover,#f5f5f5)}',
    '.wbs-login-option.selected{border-color:var(--wb-button-primary-bg,#1f1f1f);background:color-mix(in srgb,var(--wb-button-primary-bg,#1f1f1f) 7%,var(--wb-bg-popover,#fff));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--wb-button-primary-bg,#1f1f1f) 15%,transparent)}',
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
