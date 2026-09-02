'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const compat = require('../scripts/workbuddy-compat.js');

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
  assert.match(inject, /\.wbs-message-nav-marker:hover,\.wbs-message-nav-marker:focus-visible\{[^\n]*border-color:[^\n]*box-shadow:[^\n]*backdrop-filter:blur\(/);
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
  assert.match(inject, /悬停预览，点击或拖动快速定位消息。/);
});

test('robot pupils use the antenna glass treatment instead of opaque black', () => {
  const root = path.join(__dirname, '..');
  const inject = fs.readFileSync(path.join(root, 'scripts', 'inject.js'), 'utf8');
  assert.match(inject, /\.wbs-fab \.eye:before\{[^\n]*background:rgba\(20,20,22,\.55\)[^\n]*backdrop-filter:blur\(14px\) saturate\(1\.3\)/);
  assert.doesNotMatch(inject, /\.wbs-fab \.eye:before\{[^\n]*background:rgba\(20,20,22,\.92\)/);
});
