'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const compat = require('../scripts/workbuddy-compat.js');

function navigationFunction(name, context) {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/inject.js'), 'utf8');
  const start = source.indexOf('      function ' + name + '(');
  assert.ok(start >= 0, name + ' exists');
  const end = source.indexOf('\n      function ', start + 1);
  vm.runInNewContext(source.slice(start, end), context);
  return context[name];
}

test('navigation displays at most 20 evenly spaced markers while retaining both conversation ends', () => {
  const context = {};
  const indices = navigationFunction('markerTurnIndices', context);
  for (const count of [0, 1, 2, 19, 20, 21, 100, 1001]) {
    const result = Array.from(indices(count));
    assert.equal(result.length, Math.min(20, count));
    assert.equal(new Set(result).size, result.length);
    if (!count) continue;
    assert.equal(result[0], 0);
    assert.equal(result.at(-1), count - 1);
    if (count <= 20) assert.deepEqual(result, Array.from({ length: count }, (_, i) => i));
    const gaps = result.slice(1).map((value, i) => value - result[i]);
    if (gaps.length) assert.ok(Math.max(...gaps) - Math.min(...gaps) <= 1);
  }
});

test('moving between a marker, prompt list and detail keeps the hover surface open', () => {
  const list = {}, detail = {}, outside = {};
  let closes = 0;
  const context = { dragPointerId: null, root: { contains: node => node === list || node === detail },
    hideTooltip: () => { closes++; } };
  const pointerOut = navigationFunction('onPointerOut', context);
  pointerOut({ relatedTarget: list });
  pointerOut({ relatedTarget: detail });
  assert.equal(closes, 0);
  pointerOut({ relatedTarget: outside });
  assert.equal(closes, 1);
  pointerOut({ relatedTarget: null });
  assert.equal(closes, 2);
});

test('every prompt remains reachable when the rail is capped, including unsampled turns', () => {
  const element = (tag, className, textContent = '') => ({
    tag, className, textContent, children: [], attributes: {},
    appendChild(child) { this.children.push(child); },
    setAttribute(key, value) { this.attributes[key] = value; },
  });
  const turns = Array.from({ length: 101 }, (_, i) => ({ id: 'turn-' + i, userMessage: 'prompt-' + i }));
  turns[53].userMessage = '<img src=x onerror=alert(1)>';
  turns[54].userMessage = { content: [{ type: 'text', text: '长提示词'.repeat(25000) }] };
  turns.forEach(turn => {
    if (typeof turn.userMessage === 'string') turn.userMessage = { content: [{ type: 'text', text: turn.userMessage }] };
  });
  const context = { turns, rail: element('div'), tooltip: element('div'), detail: { id: 'detail' },
    buttons: {}, promptRows: {}, activeId: null, hideTooltip() {}, setActive() {},
    el: element };
  navigationFunction('messageText', context);
  navigationFunction('markerTurnIndices', context);
  navigationFunction('render', context)();
  assert.equal(context.rail.children.length, 20);
  assert.equal(context.tooltip.children.length, 101);
  assert.equal(context.promptRows['turn-53'].textContent, '<img src=x onerror=alert(1)>');
  assert.ok(context.promptRows['turn-54'].textContent.length <= 240, 'single-line previews must not lay out entire giant prompts');
  assert.ok(context.promptRows['turn-54'].textContent.endsWith('…'));
  assert.equal(turns[54].userMessage.content[0].text.length, 100000, 'the original prompt stays intact');
  for (let i = 0; i < turns.length; i++) {
    assert.equal(context.promptRows[turns[i].id].attributes['data-wbs-message-nav-id'], turns[i].id);
    assert.ok(context.rail.children.includes(context.buttons[turns[i].id]));
  }
  assert.equal(context.buttons['turn-100'], context.rail.children.at(-1));
});

test('hovering rail padding opens the nearest prompt immediately', () => {
  const button = {}, turn = { id: 'first' }, target = { closest: () => null };
  let shown;
  const context = { dragPointerId: null, tooltipTimer: null, turns: [turn], buttons: { first: button },
    rail: { contains: node => node === target }, dragIndexAt: () => 0,
    turnForButton: value => value === button ? turn : null,
    showTooltip: (value, anchor) => { shown = { value, anchor }; } };
  navigationFunction('onPointerOver', context)({ target, clientY: 12 });
  assert.deepEqual(shown, { value: turn, anchor: button });
});

test('flyout scrollbars stay hidden on centering and hide again after user scrolling stops', () => {
  const classes = new Set();
  const tooltip = { hidden: false, scrollTop: 90, classList: { add: value => classes.add(value), remove: value => classes.delete(value) } };
  const timers = new Map();
  let serial = 0;
  const context = { tooltip, centeredScrollTop: 90, scrollbarTimers: new Map(),
    clearTimeout: id => timers.delete(id),
    setBuildTimeout(fn) { timers.set(++serial, fn); return serial; } };
  navigationFunction('clearScrolling', context);
  const scroll = navigationFunction('onFlyoutScroll', context);
  scroll({ currentTarget: tooltip });
  assert.equal(classes.has('is-scrolling'), false, 'automatic centering must not flash a scrollbar');
  tooltip.scrollTop += 30;
  scroll({ currentTarget: tooltip });
  assert.equal(classes.has('is-scrolling'), true);
  scroll({ currentTarget: tooltip });
  assert.equal(timers.size, 1, 'continued scrolling replaces the idle timer');
  timers.values().next().value();
  assert.equal(classes.has('is-scrolling'), false);
  assert.equal(context.scrollbarTimers.size, 0);
  assert.equal(timers.size, 0);
  scroll({ currentTarget: tooltip });
  context.clearScrolling(tooltip);
  assert.equal(timers.size, 0, 'closing a flyout cancels its timer');
});

test('scroll events keep the last node selected when the last turn cannot align with the viewport top', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/inject.js'), 'utf8');
  const frames = [{ index: 1, top: 28, bottom: 350 }, { index: 2, top: 350, bottom: 410 }, { index: 3, top: 410, bottom: 600 }];
  const scroll = { scrollTop: 1200, scrollHeight: 1800, clientHeight: 600 };
  let selected;
  const context = {
    turns: [{ id: 'first', messageIndex: 0 }, { id: 'last', messageIndex: 2 }],
    surface: { scrollElement: scroll, viewportElement: { getBoundingClientRect: () => ({ top: 0, bottom: 600 }) },
      conversationElement: { querySelectorAll: () => frames.map(f => ({ getBoundingClientRect: () => f, getAttribute: () => String(f.index) })) } },
    setActive: id => { selected = id; },
  };
  const start = source.indexOf('      function updateActive()');
  vm.runInNewContext(source.slice(start, source.indexOf('\n      function scheduleActive()', start)), context);
  selected = 'last'; // navigateToTurn sets this before the official scroll event arrives.
  context.updateActive();
  assert.equal(selected, 'last');
  scroll.scrollTop = 1199.5;
  context.updateActive();
  assert.equal(selected, 'last', 'fractional scroll coordinates still count as the bottom');
  scroll.scrollTop = 900;
  context.updateActive();
  assert.equal(selected, 'first', 'scrolling up must release the last-node highlight');
  scroll.scrollTop = 0; scroll.scrollHeight = scroll.clientHeight;
  context.updateActive();
  assert.equal(selected, 'first', 'a non-scrollable conversation does not force the last node');
});

test('message navigation uses cr-message-list as the single stable surface seam', () => {
  const viewport = { name: 'viewport' };
  const messageList = { name: 'message-list', parentElement: viewport };
  const documentLike = {
    querySelector(selector) {
      if (selector === 'div.cr-message-list') return messageList;
      return null;
    },
  };

  const surface = compat.findMessageNavigationSurface(documentLike);
  assert.deepEqual(surface, {
    scrollElement: messageList,
    viewportElement: viewport,
    contentElement: messageList,
    conversationElement: messageList,
  });
});

test('all navigation turns are built from the structured message store regardless of DOM virtualization', () => {
  const initialAssistant = { id: 'timeline:initial', messageType: 'assistant', content: [] };
  const userOne = { id: 'user-1', requestId: 'request-1', messageType: 'user', content: [{ type: 'text', text: 'one' }] };
  const assistantOne = { id: 'assistant-1', requestId: 'request-1', messageType: 'assistant', content: [{ type: 'text', text: 'answer one' }] };
  const userTwo = { id: 'user-2', requestId: 'request-2', messageType: 'user', content: [{ type: 'text', text: 'two' }] };
  const assistantTwo = { id: 'assistant-2', requestId: 'request-2', messageType: 'assistant', content: [{ type: 'text', text: 'answer two' }] };
  const turns = compat.collectMessageNavigationTurnsFromMessages([
    initialAssistant,
    userOne,
    assistantOne,
    userTwo,
    assistantTwo,
  ]);

  assert.equal(turns.length, 2);
  assert.deepEqual(turns.map((turn) => turn.id), ['user-1', 'user-2']);
  assert.equal(turns[0].messageIndex, 1);
  assert.equal(turns[0].userMessage, userOne);
  assert.equal(turns[0].assistantMessage, assistantOne);
  assert.equal(turns[1].assistantMessage, assistantTwo);
});

test('message navigation preview hides only the assistant completion marker at the end', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/inject.js'), 'utf8');
  const start = source.indexOf('      function messageText(message, limit, preserveMarkdown) {');
  const end = source.indexOf('\n      function ensureRoot()', start);
  assert.ok(start >= 0 && end > start);
  const context = {};
  vm.runInNewContext(source.slice(start, end), context);

  const assistant = content => ({ messageType: 'assistant', content });
  const text = value => ({ type: 'text', text: value });
  assert.equal(context.messageText(assistant([text('6\n[wbs-reply-done]: #')]), 320), '6');
  assert.equal(context.messageText(assistant([text('6'), text('[wbs-reply-done]: #')]), 320), '6');
  assert.equal(context.messageText(assistant([text('[wbs-reply-done]: #')]), 320), '');
  assert.equal(context.messageText(assistant([text('The [wbs-reply-done]: # syntax is internal, not a final marker here.')]), 320),
    'The [wbs-reply-done]: # syntax is internal, not a final marker here.');
  assert.equal(context.messageText({ messageType: 'user', content: [text('[wbs-reply-done]: #')] }, 320),
    '[wbs-reply-done]: #');
});

test('pending in-flight user messages (req-* requestId only) are skipped from navigation turns', () => {
  const realUser = { id: 'real-1', messageType: 'user', content: [] };
  const pendingUser = { requestId: 'req-1788055901657776', messageType: 'user', content: [] };
  const realUser2 = { id: 'real-2', messageType: 'user', content: [] };
  const turns = compat.collectMessageNavigationTurnsFromMessages([realUser, pendingUser, realUser2]);
  assert.equal(turns.length, 2);
  assert.deepEqual(turns.map((turn) => turn.id), ['real-1', 'real-2']);
  // 有真实 id 时 messageId 用真实 id（滚动定位 DOM 帧用），而非 requestId
  assert.equal(turns[0].messageId, 'real-1');
});

test('message navigation adapter discovers the complete store and official virtual-list handle by capability', () => {
  const messageStore = { getState() {}, subscribe() {} };
  const controller = {
    conversationId: 'conversation-1',
    messageStore,
    getMessagesViewState() {},
  };
  const navigationHandle = {
    scrollToMessage() {},
    getScrollMetrics() {},
  };
  const controllerFiber = { memoizedProps: { value: controller }, return: null };
  const handleFiber = { memoizedProps: { value: { handle: navigationHandle } }, return: controllerFiber };
  const conversationElement = {
    __reactFiber$test: controllerFiber,
    getAttribute(name) { return name === 'data-root-id' ? 'conversation-1' : null; },
  };
  const scrollElement = { __reactFiber$test: handleFiber };
  const viewportElement = { __reactFiber$test: handleFiber };
  const contentElement = {};
  const documentLike = {
    querySelector(selector) {
      if (selector === 'div.cr-message-list') return scrollElement;
      return null;
    },
  };

  const adapter = compat.findMessageNavigationAdapter(documentLike);
  assert.equal(adapter.controller, controller);
  assert.equal(adapter.messageStore, messageStore);
  assert.equal(adapter.navigationHandle, navigationHandle);
});

test('injected navigation rail is theme-aware, glassy, accessible, and profile agnostic', () => {
  const root = path.join(__dirname, '..');
  const inject = fs.readFileSync(path.join(root, 'scripts', 'inject.js'), 'utf8');

  assert.match(inject, /function createMessageNavigation\(/);
  assert.match(inject, /WBS_COMPAT\.findMessageNavigationSurface\(document\)/);
  assert.match(inject, /WBS_COMPAT\.findMessageNavigationAdapter\(document/);
  assert.match(inject, /WBS_COMPAT\.collectMessageNavigationTurnsFromMessages\(messageState\.messages\)/);
  assert.match(inject, /messageStore\.subscribe\(/);
  assert.match(inject, /turns\.length <= 1/);
  assert.match(inject, /className = 'wbs-message-nav-root'/);
  assert.match(inject, /className = 'wbs-message-nav-tooltip'/);
  assert.match(inject, /aria-label/);
  assert.match(inject, /aria-current/);
  assert.match(inject, /\.wbs-message-nav-tooltip\{[^\n]*backdrop-filter:blur\(/);
  assert.match(inject, /var\(--wb-bg-popover/);
  assert.match(inject, /var\(--wb-border-subtle/);
  assert.match(inject, /var\(--wb-color-text-primary/);
  assert.match(inject, /\.wbs-message-nav-rail\{[^\n]*border:1px solid transparent[^\n]*box-shadow:none[^\n]*backdrop-filter:none/);
  assert.match(inject, /\.wbs-message-nav-rail:hover,\.wbs-message-nav-rail:focus-within\{[^\n]*backdrop-filter:blur\(/);
  assert.match(inject, /\.wbs-message-nav-marker\{[^\n]*background:color-mix\(in srgb,var\(--wb-bg-popover/);
  assert.doesNotMatch(inject, /\.wbs-message-nav-marker:hover[^']*\{/);
  assert.doesNotMatch(inject, /\.wbs-message-nav-marker:hover \.wbs-message-nav-dot/);
  assert.doesNotMatch(inject, /wbs-message-nav-highlight|@keyframes wbs-message-nav-highlight/);
  assert.match(inject, /\.wbs-message-nav-response\{display:block/);
  assert.doesNotMatch(inject, /\.wbs-message-nav-response\{-webkit-line-clamp/);
  assert.match(inject, /prefers-reduced-motion:reduce/);
  assert.match(inject, /querySelectorAll\('\.wbs-message-nav-root'\)/);

  const navigationStart = inject.indexOf('function createMessageNavigation(');
  const navigationEnd = inject.indexOf('\n    // =====', navigationStart);
  const navigationSource = inject.slice(navigationStart, navigationEnd);
  assert.doesNotMatch(navigationSource, /WBS_PROFILE_IS_AI|PROFILE_ID/);
  assert.doesNotMatch(navigationSource, /scrollIntoView/);
  assert.match(navigationSource, /scrollToMessage\(turn\.messageId, \{ behavior: 'auto'/);
  assert.match(navigationSource, /surface\.viewportElement\.getBoundingClientRect\(\)/);
  assert.match(navigationSource, /rect\.left \+ 12/);
  assert.doesNotMatch(navigationSource, /rect\.height \* 0\.7|420/);
  assert.match(navigationSource, /Math\.min\(desiredRailHeight, rect\.height\)/);
  assert.match(navigationSource, /--wbs-message-nav-marker-height/);
  assert.match(navigationSource, /setPointerCapture\(event\.pointerId\)/);
  assert.match(navigationSource, /function onNavPointerMove\(/);
  assert.match(navigationSource, /navigateToTurn\(turns\[nextIndex\], true\)/);
  assert.match(inject, /\.wbs-message-nav-rail\{[^\n]*touch-action:none/);
  assert.match(inject, /\.wbs-message-nav-marker\{[^\n]*height:var\(--wbs-message-nav-marker-height/);
  assert.doesNotMatch(navigationSource, /button\.focus\(/);
  assert.doesNotMatch(inject, /\.wbs-message-nav-root\.is-dragging[^\n]*cursor:/);
  assert.match(inject, /\.wbs-message-nav-marker:focus-visible/);
  assert.match(inject, /workdaddy\.session\.messageNavigationEnabled/);
  assert.match(inject, /localStorage\.getItem\(MESSAGE_NAV_ENABLED_KEY\) !== '0'/);
  assert.match(navigationSource, /function setEnabled\(enabled\)/);
  assert.match(inject, /messageNavigation\.setEnabled\(sessState\.messageNav\)/);
  assert.match(inject, /mount = surface && surface\.viewportElement/);

  const stashSwitch = inject.indexOf('id="wbs-sess-stash"');
  const navigationSwitch = inject.indexOf('id="wbs-sess-message-nav"');
  const phraseSwitch = inject.indexOf('id="wbs-sess-phrase"');
  assert.ok(stashSwitch >= 0 && navigationSwitch > stashSwitch && phraseSwitch > navigationSwitch);
  assert.match(inject, /会话消息索引/);
  assert.match(inject, /<span class="wbs-nd-hint">悬停预览，点击或拖动快速定位消息<\/span>/);
});

test('floating robot keeps the website shell and upright eyes', () => {
  const root = path.join(__dirname, '..');
  const inject = fs.readFileSync(path.join(root, 'scripts', 'inject.js'), 'utf8');
  assert.match(inject, /--wbs-robot-shell:#fff;--wbs-robot-eye:#111/);
  assert.match(inject, /\.wbs-fab \.eye\{[^\n]*width:12px;height:18px[^\n]*background:var\(--wbs-robot-eye\)/);
  assert.match(inject, /\.wbs-fab:hover \.eye\{scale:1\.18\}/);
  assert.match(inject, /wbs-robot-blink 7s/);
  assert.match(inject, /\.wbs-fab \.button\{[^\n]*width:82px;height:64px/);
  assert.doesNotMatch(inject, /\.wbs-fab \.eye:before/);
});


test('assistant hover previews preserve Markdown line structure while prompt summaries remain compact', () => {
  const context = {};
  const read = navigationFunction('messageText', context);
  const markdown = '# 标题\n\n- **重点**\n- 第二项\n\n```js\nconst a = 1;\n```';
  const message = { messageType: 'assistant', content: [{ type: 'markdown', text: markdown + '\n[wbs-reply-done]: #' }] };
  assert.equal(read(message, 20000, true), markdown);
  assert.equal(read(message, 240).includes('\n'), false);
  assert.equal(read(message, 10, true).length, 10);
});

test('detail preview mounts the local Markdown component with a safe text fallback', () => {
  const nodes = [];
  const context = {
    detail: { textContent: '', appendChild: node => nodes.push(node), classList: { add() {} } },
    hideDetail() {}, positionFlyouts() {},
    messageText: (m, limit, preserve) => { if (m.role === 'assistant') assert.equal(preserve, true); return m.text; },
    el: (tag, cls, text) => ({ className: cls, textContent: text, appendChild: child => nodes.push(child) }),
    window: { __wbsMarkdownPreview: { render: text => ({ rendered: text }) } },
  };
  const show = navigationFunction('showDetail', context);
  show({ userMessage: { text: '问题' }, assistantMessage: { role: 'assistant', text: '**回答**' } }, { classList: { add() {} } });
  assert.ok(nodes.some(node => node.rendered === '**回答**'));
  assert.ok(nodes.some(node => node.className === 'wbs-message-nav-response'));
});
