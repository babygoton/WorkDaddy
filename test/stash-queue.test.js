'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  composerBlocksFromTree,
  composerTextFromTree,
  contentToBlocks,
  isStashQueueItem,
  stashContentMatches,
} = require('../scripts/inject.js');
const compat = require('../scripts/workbuddy-compat.js');

test('ordinary queue items are not classified as stash items by a text substring', () => {
  const stashIds = ['stash-1'];
  const stashTexts = ['整理今天的会议记录'];

  assert.equal(
    isStashQueueItem({ id: 'normal-1', contentBlocks: [{ type: 'text', text: '整理今天的会议记录并发送给团队' }] }, stashIds, stashTexts),
    false,
  );
  assert.equal(
    isStashQueueItem({ id: 'normal-2', contentBlocks: [{ type: 'text', text: '整理今天的会议记录' }] }, stashIds, stashTexts),
    false,
  );
  assert.equal(
    isStashQueueItem({ id: 'stash-1', contentBlocks: [{ type: 'text', text: '内容已被 WorkBuddy 规范化' }] }, stashIds, stashTexts),
    true,
  );
  assert.equal(
    isStashQueueItem({ contentBlocks: [{ type: 'text', text: '整理今天的会议记录' }] }, stashIds, stashTexts),
    false,
  );
});

test('text fallback remains exact and only applies when queue items have no stable IDs', () => {
  const stashTexts = ['整理今天的会议记录'];
  assert.equal(
    isStashQueueItem({ contentBlocks: [{ type: 'text', text: '整理今天的会议记录' }] }, [], stashTexts),
    true,
  );
  assert.equal(
    isStashQueueItem({ contentBlocks: [{ type: 'text', text: '整理今天的会议记录并发送给团队' }] }, [], stashTexts),
    false,
  );
});

test('async stash cleanup only clears the content captured at click time', () => {
  const captured = { text: '先暂存这条', items: [] };
  assert.equal(stashContentMatches(captured, { text: '先暂存这条', items: [] }), true);
  assert.equal(stashContentMatches(captured, { text: '用户随后输入的普通消息', items: [] }), false);
  assert.equal(stashContentMatches(captured, { text: '先暂存这条', items: [{ type: 'image', uri: 'new-image' }] }), false);
});

function text(value) {
  return { nodeType: 3, nodeValue: value, childNodes: [] };
}

function element(attributes, children) {
  const attrs = attributes || {};
  return {
    nodeType: 1,
    childNodes: children || [],
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name); },
    getAttribute(name) { return attrs[name] == null ? null : String(attrs[name]); },
  };
}

test('stash composer text excludes Slate placeholder text', () => {
  const editor = element({}, [
    element({}, [text('喵喵喵')]),
    element({ 'data-slate-placeholder': 'true' }, [
      text('今天帮你做些什么？ @ 引用对话文件，/ 调用技能与指令'),
    ]),
  ]);

  assert.equal(composerTextFromTree(editor), '喵喵喵');
});

test('stash composer blocks retain inline selection quote order and skip rendered labels', () => {
  const quoteMeta = (selectedText) => ({
    displayAsPhrase: true,
    displayAsContext: false,
    displayText: '引用文本',
    selectionQuote: true,
    mentionType: 'selection',
    selectedText,
    title: '引用文本',
  });
  const quote1 = {
    type: 'resource_link',
    name: '引用文本',
    uri: 'selection://document-selection',
    _meta: quoteMeta('原文1'),
  };
  const quote2 = {
    type: 'resource_link',
    name: '引用文本',
    uri: 'selection://document-selection',
    _meta: quoteMeta('原文2'),
  };
  const editor = element({}, [
    element({}, [
      element({ 'data-contentblock': JSON.stringify(quote1) }, [text('引用文本')]),
      text('111 '),
      element({ 'data-contentblock': JSON.stringify(quote2) }, [text('引用文本')]),
      text('222'),
    ]),
    element({}, [text('333')]),
  ]);
  const blocks = composerBlocksFromTree(editor);
  assert.deepEqual(blocks.map((block) => block.type), ['resource_link', 'text', 'resource_link', 'text']);
  assert.deepEqual(contentToBlocks({ orderedBlocks: blocks }), [
    { type: 'resource_link', name: '引用文本', uri: 'selection://document-selection', title: '引用文本', _meta: quoteMeta('原文1') },
    { type: 'text', text: '111 ' },
    { type: 'resource_link', name: '引用文本', uri: 'selection://document-selection', title: '引用文本', _meta: quoteMeta('原文2') },
    { type: 'text', text: '222\n333' },
  ]);
});

test('modern draft cleanup is scoped to the exact active conversation store', () => {
  assert.equal(compat.draftStorageKey(' conversation-a '), 'cb-draft:conversation-a');
  assert.equal(compat.draftStorageKey(''), null);

  const matchingStore = {
    api: {
      clear() {},
      setBlocks() {},
      getDraft() { return { blocks: [] }; },
    },
    getSnapshot() { return { activeSessionId: 'conversation-a' }; },
  };
  const otherConversationStore = {
    ...matchingStore,
    getSnapshot() { return { activeSessionId: 'conversation-b' }; },
  };
  const unrelatedStore = {
    api: { clear() {}, setBlocks() {} },
    getSnapshot() { return { activeSessionId: 'conversation-a' }; },
  };

  assert.equal(compat.isComposerStore(matchingStore, 'conversation-a'), true);
  assert.equal(compat.isComposerStore(otherConversationStore, 'conversation-a'), false);
  assert.equal(compat.isComposerStore(unrelatedStore, 'conversation-a'), false);
});

test('stash cleanup clears the official composer store and persistent conversation draft before DOM fallback', () => {
  const inject = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'inject.js'), 'utf8');
  assert.match(inject, /function clearModernComposerDraft\(ed, sessionId\)/);
  assert.match(inject, /WBS_COMPAT\.isComposerStore\(store, sessionId\)/);
  assert.match(inject, /store\.api\.clear\(\)/);
  assert.match(inject, /WBS_COMPAT\.draftStorageKey\(sessionId\)/);
  assert.match(inject, /localStorage\.removeItem\(draftKey\)/);
  assert.match(inject, /clearModernComposerDraft\(ed, stashSessionAtClick\)/);
  const start = inject.indexOf('function clearComposerViaOnChange(expectedContent)');
  const end = inject.indexOf('\n    // 队列操作超时包装', start);
  assert.match(inject.slice(start, end), /var modernDraftCleared = clearModernComposerDraft\(ed, stashSessionAtClick\)/);
  assert.match(inject.slice(start, end), /if \(modernDraftCleared\) return/);
});

test('theme tab is capability-gated and available to WorkBuddy AI', () => {
  const inject = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'inject.js'), 'utf8');
  assert.match(inject, /if \(!CAPS\.theme\)/);
  assert.doesNotMatch(inject, /if \(!CAPS\.theme \|\| WBS_PROFILE_IS_AI\)/);
  assert.doesNotMatch(inject, /migrateWorkBuddyAiThemeOnce/);
});

test('daemon stash restore has an AI composer fallback when voice-mic-wrap is absent', () => {
  const daemon = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'daemon.js'), 'utf8');
  assert.match(daemon, /const clearExpr = `\(function\(\)\{[\s\S]*?if \(!ed\) \{[\s\S]*?contenteditable/);
  assert.match(daemon, /var allEd = document\.querySelectorAll\('\[contenteditable="true"\]'\)/);
});

test('modern conversation id comes from the selected sidebar card, not message req ids', () => {
  const id = compat.selectedConversationId([
    {
      conversationId: 'background-conversation',
      className: 'conversation-item',
      childClassName: '_card_hash_1 _compact_hash_26',
    },
    {
      conversationId: 'selected-conversation',
      className: 'conversation-item',
      childClassName: '_card_hash_1 _selected_hash_20 _compact_hash_26',
    },
  ]);
  assert.equal(id, 'selected-conversation');
  assert.notEqual(id, 'req-1787762196288001-user');
  assert.notEqual(id, 'req-1787762196288001-assistant');
});

test('modern selected conversation resolver also supports aria-selected and rejects arbitrary rows', () => {
  assert.equal(compat.selectedConversationId([
    { conversationId: 'arbitrary', className: 'conversation-item' },
    { conversationId: 'aria-selected', ariaSelected: 'true', className: 'conversation-item' },
  ]), 'aria-selected');
  assert.equal(compat.selectedConversationId([
    { conversationId: 'arbitrary', className: 'conversation-item' },
  ]), null);
});

test('modern queue path uses the top-level notifying adapter and clears stale adapter cache', () => {
  const inject = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'inject.js'), 'utf8');
  assert.match(inject, /delete window\.__wbsAdapter/);
  assert.match(inject, /var target = found\.adapter/);
  assert.doesNotMatch(inject, /var srX = p\.adapter\.sessionsResource/);
  assert.match(inject, /WBS_COMPAT\.getSelectedConversationId\(document\)/);
  assert.match(inject, /function syncModernQueueSnapshot\(sessionId, snapshot\)/);
  assert.match(inject, /store\.setPromptQueue\(queueItems\)/);
  assert.match(inject, /__wbsQueueMirrorInstalled/);
  assert.match(inject, /manager\.__wbsQueueMirrorItems = queueItems\.slice\(\)/);
  assert.match(inject, /manager\.delete = function \(itemId\)/);
  assert.match(inject, /adapter\.removeConversationMessageQueueItem\(sessionId, itemId\)/);
  assert.match(inject, /adapter\.sendConversationMessageQueueItemNow\(sessionId, itemId\)/);
  assert.match(inject, /function handleModernQueueActionClick\(event\)/);
  assert.match(inject, /listen\(document, 'click', handleModernQueueActionClick, true\)/);
  assert.match(inject, /function waitForModernQueueAdapter\(maxMs\)/);
  assert.match(inject, /var pauseWait = modernAdapter\s*\?/);
  assert.match(inject, /WBS_COMPAT\.isModernQueueAdapter\(adapter\)/);
  assert.match(inject, /enqueue:not-ready-no-fallback/);
  assert.match(inject, /function warmModernQueueAdapter\(\)/);
  assert.match(inject, /var stashInFlight = null/);
  assert.match(inject, /if \(stashBusy \|\| stashInFlight\) return/);
  assert.match(inject, /stashInFlight = stashWork/);
  assert.match(inject, /stashInFlight = null/);
  assert.match(inject, /controller\.promptQueue\.emitQueueUpdate\(\)/);
  assert.match(inject, /stashSessionAtClick = sessionId/);
});

test('real modern queue actions remain owned by WorkBuddy official handlers', () => {
  const inject = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'inject.js'), 'utf8');
  const start = inject.indexOf('function handleModernQueueActionClick(event)');
  const end = inject.indexOf("listen(document, 'click', handleModernQueueActionClick, true);", start);
  assert.ok(start >= 0 && end > start);
  const handler = inject.slice(start, end);

  assert.match(handler, /itemId\.indexOf\('wbs-pending-'\) !== 0\) return/);
  assert.doesNotMatch(handler, /sendConversationMessageQueueItemNow/);
  assert.doesNotMatch(handler, /removeConversationMessageQueueItem/);
  assert.doesNotMatch(inject, /function writeModernQueueItemToComposer\(item\)/);
});

test('modern stash pauses before enqueue and refreshes incomplete snapshots', () => {
  const inject = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'inject.js'), 'utf8');
  const start = inject.indexOf('function enqueueToWorkBuddyQueue(content)');
  const end = inject.indexOf('\n    var stashBusy = false;', start);
  assert.ok(start >= 0 && end > start);
  const queuePath = inject.slice(start, end);
  assert.match(queuePath, /pauseWait[\s\S]*pauseConversationMessageQueue\(sessionId, 'manual'\)/);
  assert.ok(queuePath.indexOf('pauseConversationMessageQueue(sessionId, \'manual\')') < queuePath.indexOf('enqueueConversationMessageQueueItem(sessionId, blocks)'), 'pause must be requested before enqueue');
  assert.match(queuePath, /getModernQueueSnapshot\(adapter, sessionId, snapshot\)/);
  assert.match(inject, /function getModernQueueSnapshot\(adapter, sessionId, preferred\)/);
  assert.match(inject, /__wbsOptimistic/);
  assert.match(inject, /id: 'wbs-pending-'/);
  assert.match(inject, /dropModernOptimisticItem\(stashSessionAtClick\)/);
  assert.match(inject, /queueItems\.length === 0[\s\S]*currentItems\.length > 0[\s\S]*snapshot\.runtime == null/);
});
