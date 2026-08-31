'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const inject = require('../scripts/inject.js');
const compat = require('../scripts/workbuddy-compat.js');
const fs = require('node:fs');
const path = require('node:path');

const injectSource = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'inject.js'), 'utf8');

test('approval gate accepts attached background approval cards without visibility checks', () => {
  const classify = inject.classifyNoDisturbApprovalCandidate;
  assert.equal(classify({
    label: '1允许',
    context: '任务 B 检测到受保护文件修改',
    hasDeny: true,
    hasOnce: true,
    buttonCount: 3,
  }), 'once');
  assert.equal(classify({
    label: '始终允许',
    context: '权限 approval\n拒绝',
    hasDeny: true,
    hasOnce: true,
    buttonCount: 2,
  }), 'session');
});

test('approval gate handles simultaneous cards and rejects unrelated confirmations', () => {
  const classify = inject.classifyNoDisturbApprovalCandidate;
  const cards = [
    { label: '允许', context: '沙箱外写入\n拒绝', hasDeny: true, hasOnce: true, buttonCount: 2 },
    { label: 'Allow', context: '系统级工具\nDeny', hasDeny: true, hasOnce: true, buttonCount: 2 },
    { label: '确认', context: '确认生成图片，消耗 10 积分\n取消', hasDeny: false, buttonCount: 2 },
  ];
  assert.deepEqual(cards.map(classify), ['once', 'once', null]);
  assert.equal(classify({
    label: '允许',
    context: '普通设置确认',
    hasDeny: false,
    buttonCount: 2,
    disabled: true,
  }), null);
});

test('session monitor registry keeps bounded per-session logs in memory', () => {
  const registry = inject.createSessionMonitorRegistry({ maxLogs: 2, maxSessions: 2 });
  registry.ensure('a', { title: '任务 A', status: 'running' });
  registry.append('a', 'state', { status: 'running' });
  registry.append('a', 'approval-clicked', { source: 'api' });
  registry.append('a', 'continue-sent', { source: 'api' });
  assert.equal(registry.list().length, 1);
  assert.equal(registry.get('a').logs.length, 2);
  assert.equal(registry.get('a').logs[0].event, 'approval-clicked');
  assert.equal(registry.get('a').logs[1].event, 'continue-sent');
  registry.ensure('b');
  registry.ensure('c');
  assert.equal(registry.get('a'), null);
  assert.deepEqual(registry.list().map((item) => item.id), ['b', 'c']);
});

test('session monitor progress gate excludes completed and idle snapshots', () => {
  const inProgress = inject.isSessionMonitorInProgress;
  assert.equal(inProgress({ busy: true }), true);
  assert.equal(inProgress({ blocked: true }), true);
  assert.equal(inProgress({ hydrating: true }), true);
  assert.equal(inProgress({ complete: true, busy: false }), false);
  assert.equal(inProgress({ state: 'done', busy: false }), false);
});

test('session resource normalizer treats background terminal updates as final', () => {
  const normalize = inject.normalizeSessionMonitorResourceRecord;
  assert.deepEqual(normalize({
    id: 'task-b',
    status: 'working',
    protocolStatus: 'completed',
    name: '任务 B',
  }, 'sessionUpdated'), {
    id: 'task-b',
    title: '任务 B',
    status: 'completed',
    pendingInputKind: '',
    active: false,
    terminal: true,
    event: 'sessionUpdated',
  });
  assert.equal(normalize({ id: 'task-b', status: 'model_streaming' }, 'sessionUpdated').active, true);
  assert.equal(normalize({ id: 'task-b', status: 'pending' }, 'sessionUpdated').active, false);
  assert.equal(normalize({ id: 'task-b', status: 'pending', activePromptStartedAt: 123 }, 'sessionUpdated').active, true);
  assert.equal(normalize({ id: 'task-b', status: 'pending', pendingInputKind: 'permission' }, 'sessionUpdated').active, true);
  assert.equal(normalize({
    id: 'task-b',
    status: 'pending',
    messageQueueRuntime: { pendingItemCount: 1, paused: false },
  }, 'sessionUpdated').active, true);
});

test('session lifecycle adds unknown background work and removes terminal sessions', () => {
  const action = inject.sessionMonitorLifecycleAction;
  assert.equal(action({ id: 'task-b', active: true, terminal: false }, false), 'add');
  assert.equal(action({ id: 'task-b', active: true, terminal: false }, true), 'update');
  assert.equal(action({ id: 'task-b', active: false, terminal: true }, true), 'remove');
  assert.equal(action({ id: 'task-b', active: false, terminal: true }, false), 'ignore');
  assert.equal(action({ id: 'task-b', active: false, terminal: false }, false), 'ignore');
});

test('multi-session monitor subscribes while idle and detaches switched controllers without deleting sessions', () => {
  assert.match(injectSource, /function acStartMultiMonitor\(\)[\s\S]*var hasResource = acMultiBindSessionResource\(\);[\s\S]*if \(!hasResource && !hasSidebar && !Object\.keys\(acMulti\.sessions\)\.length\)/);
  assert.match(injectSource, /function acMultiDetachController\(session\)[\s\S]*session\.controller = null;/);
  assert.match(injectSource, /function acMultiFinishSession\(session\)[\s\S]*delete acMulti\.sessions\[session\.id\];/);
});

test('session resource subscription delivers non-active completion without controller changes', () => {
  const handlers = new Map();
  const resource = {
    on(event, handler) { handlers.set(event, handler); },
    off(event, handler) { if (handlers.get(event) === handler) handlers.delete(event); },
  };
  const updates = [];
  const unsubscribe = inject.subscribeSessionMonitorResource(resource, (update) => updates.push(update));

  handlers.get('sessionUpdated')({ id: 'task-b', status: 'completed' });
  handlers.get('sessionsChanged')([
    { id: 'task-a', status: 'working' },
    { id: 'task-c', status: 'failed' },
  ]);

  assert.deepEqual(updates.map((item) => [item.id, item.status, item.terminal]), [
    ['task-b', 'completed', true],
    ['task-a', 'working', false],
    ['task-c', 'failed', true],
  ]);
  unsubscribe();
  assert.equal(handlers.size, 0);
});

test('monitor log card stays hidden until the five-click logo unlock', () => {
  assert.match(injectSource, /id="wbs-monitor-log-card"' \+ \(hiddenToolsUnlocked \? '' : ' style="display:none"'\)/);
  assert.match(injectSource, /if \(piClickCount >= 5\)[\s\S]*hiddenToolsUnlocked = true;[\s\S]*monitorLogCard\.style\.display = '';/);
});

test('compat discovers multiple capability-shaped controllers and de-duplicates fibers', () => {
  const controllers = [
    { conversationId: 'a', messageStore: { getState() {}, subscribe() {} }, getMessagesViewState() {} },
    { conversationId: 'b', messageStore: { getState() {}, subscribe() {} }, getMessagesViewState() {} },
  ];
  const root = { children: [], __reactFiber$root: { memoizedProps: { value: controllers[0] }, return: null } };
  const child = { children: [], __reactFiber$child: { memoizedProps: { controller: controllers[1] }, return: root.__reactFiber$root } };
  root.children.push(child);
  const doc = { querySelector(selector) { return selector === '#root > div' ? root : null; } };
  assert.deepEqual(compat.findConversationControllers(doc).map((c) => c.conversationId), ['a', 'b']);
});

test('compat discovers the global session resource by capabilities', () => {
  const resource = { on() {}, off() {}, list() {}, getByIds() {} };
  const adapter = {
    sessionsResource: resource,
    enqueueConversationMessageQueueItem() {},
    pauseConversationMessageQueue() {},
  };
  const root = { children: [], __reactFiber$root: { memoizedProps: { adapter }, return: null } };
  const doc = { querySelector(selector) { return selector === '#root > div' ? root : null; } };
  assert.equal(compat.findSessionsResource(doc), resource);
});

test('compat reads the sidebar conversation status snapshot from a narrow fiber root', () => {
  const records = [
    { id: 'task-a', title: '任务 A', status: 'running' },
    { id: 'task-b', title: '任务 B', status: 'completed' },
  ];
  const ownerFiber = { memoizedProps: { allConversations: records }, return: null };
  const item = { __reactFiber$item: { memoizedProps: {}, return: ownerFiber } };
  const doc = {
    querySelector(selector) {
      if (selector === '.conversation-list .conversation-item') return item;
      return null;
    },
  };
  assert.deepEqual(compat.findConversationListRecords(doc), records);
});
