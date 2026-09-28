'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const lib = require('../scripts/lib');
const source = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');

function harness(rules, owner = 'source') {
  const jobs = [], events = [];
  const ctx = vm.createContext({
    DATA_DIR: 'fixture', log() {}, isAutoCopySessionSelected: lib.isAutoCopySessionSelected,
    isValidSessionId: id => !!id,
    readBody: async req => req.body,
    json: (_, status, body) => ({ status, body }),
    beginRendererReloadPriority: () => () => events.push('release-reload'),
    assertAccountSwitchIdle: async () => () => events.push('release-switch'),
    currentAccount: () => ({ uid: 'source' }),
    preserveAccountSwitchTheme: async uid => { assert.equal(uid, 'target'); events.push('preserve-theme'); },
    sqliteQuery: async () => owner ? [{ user_id: owner, cwd: '/current-workspace' }] : [],
    switchAccountForProfile: (uid) => { events.push('switch'); return { uid }; },
    reloadWorkBuddyPage: async () => { events.push('reload'); },
    mainFrameNavigationSerial: 1, setTimeout() {},
    getAutoCopyRules: () => rules,
    hasPendingAutoCopyTo: () => false,
    startAutoCopyJob: (from, to, plan, labels) => {
      events.push('job');
      jobs.push({ from, to, ...labels });
      return { id: 'job', total: 0, openSessionId: labels.openSessionId };
    },
  });
  const helperStart = source.indexOf('function shouldStartAutoCopyJob(');
  vm.runInContext(source.slice(helperStart, source.indexOf('\nfunction pruneAutoCopyJobs', helperStart)), ctx);
  const routeStart = source.indexOf("  if (req.method === 'POST' && p === '/api/switch')");
  const routeEnd = source.indexOf('\n  return json(res, 404', routeStart);
  vm.runInContext('async function switchRoute(req, res) { const p = "/api/switch";\n' + source.slice(routeStart, routeEnd) + '\n}', ctx);
  return { jobs, events, run: (currentConversationId = 'open') => ctx.switchRoute({ method: 'POST', body: { uid: 'target', reload: true, currentConversationId } }, {}) };
}

test('switch route reloads without syncing when no rule is enabled', async () => {
  const h = harness({ allSessions: false, sessionIds: [], workspaces: [] });
  const result = await h.run();
  assert.equal(result.status, 200);
  assert.equal(result.body.reloaded, true);
  assert.equal(h.jobs.length, 0);
  assert.deepEqual(h.events, ['preserve-theme', 'switch', 'reload', 'release-reload', 'release-switch']);
});

for (const rules of [
  { allSessions: false, sessionIds: [], workspaces: ['/unrelated-workspace'] },
  { allSessions: false, sessionIds: ['another-session'], workspaces: [] },
]) {
  test('switch route never adds an unselected open conversation to another rule’s job: ' + JSON.stringify(rules), async () => {
    const h = harness(rules);
    const result = await h.run();
    assert.equal(result.status, 200);
    assert.equal(h.jobs.length, 1, 'the other rule still has its normal sync job');
    assert.equal(h.jobs[0].openSessionId, '', 'an unselected open conversation must not become a forced planner request');
    assert.equal(result.body.autoCopy.openSessionId, '');
    assert.ok(h.events.indexOf('reload') < h.events.indexOf('job'));
  });
}

for (const rules of [
  { allSessions: true, sessionIds: [], workspaces: [] },
  { allSessions: false, sessionIds: ['open'], workspaces: [] },
  { allSessions: false, sessionIds: [], workspaces: ['/current-workspace/'] },
]) {
  test('switch route preserves restoration for a selected open conversation: ' + JSON.stringify(rules), async () => {
    const h = harness(rules);
    assert.equal((await h.run()).status, 200);
    assert.equal(h.jobs[0].openSessionId, 'open');
  });
}

for (const owner of ['', 'other-account']) {
  test('switch route never carries a missing or foreign conversation: ' + owner, async () => {
    const h = harness({ allSessions: true, sessionIds: [], workspaces: [] }, owner);
    assert.equal((await h.run()).status, 200);
    assert.equal(h.jobs[0].openSessionId, '');
  });
}

const inject = fs.readFileSync(path.join(__dirname, '../scripts/inject.js'), 'utf8');
const captureSource = inject.slice(inject.indexOf('    function acActiveConversationId()'), inject.indexOf('    /** 会话身份签名：'));
const compat = require('../scripts/workbuddy-compat');

function rendererCapture(profileId, adapter, window = {}) {
  const node = { __reactFiber$test: { memoizedProps: { adapter }, return: null } };
  const context = vm.createContext({
    PROFILE_ID: profileId, CAPS: { enhance: false }, window,
    WBS_COMPAT: compat, URL, location: { href: 'https://client.invalid/agentManager.html' },
    document: { querySelector: selector => selector === '.chat-container' ? node : null, querySelectorAll: () => [] },
  });
  vm.runInContext(captureSource, context);
  return context;
}

for (const profile of ['codebuddy-cn', 'codebuddy-intl']) {
  test(profile + ': switch captures the live conversation without composer enhancement initialization', async () => {
    let queueCalls = 0;
    const adapter = { currentActiveSessionId: 'open',
      enqueueConversationMessageQueueItem() { queueCalls++; }, pauseConversationMessageQueue() { queueCalls++; } };
    const renderer = rendererCapture(profile, adapter);
    const h = harness({ allSessions: true, sessionIds: [], workspaces: [] });
    const result = await h.run(renderer.acSwitchConversationId());
    assert.equal(result.status, 200);
    assert.equal(h.jobs[0].openSessionId, 'open', 'the actual switch request must carry the source conversation');
    adapter.currentActiveSessionId = 'copied-target';
    assert.equal(renderer.acActiveConversationId(), 'copied-target', 'activation confirmation reads the live destination');
    adapter.currentActiveSessionId = '';
    renderer.window.__wbsAdapter = { currentActiveSessionId: 'stale-source' };
    assert.equal(renderer.acSwitchConversationId(), '', 'welcome page must not reuse a stale enhancement cache');
    assert.equal(queueCalls, 0, 'session capture must not mutate the composer or queue');
  });
}

for (const profile of ['workbuddy-cn', 'workbuddy-ai']) {
  test(profile + ': SDK, hydration fallback and legacy cache keep their switch behavior', async () => {
    const renderer = rendererCapture(profile, null, { wb: { conversations: { currentId: 'open' } }, __wbsAdapter: { currentActiveSessionId: 'stale' } });
    let nativeLookups = 0;
    renderer.WBS_COMPAT = { findQueueAdapter() { nativeLookups++; }, getSelectedConversationId() { nativeLookups++; } };
    assert.equal(renderer.acActiveConversationId(), 'open');
    const h = harness({ allSessions: true, sessionIds: [], workspaces: [] });
    await h.run(renderer.acSwitchConversationId());
    assert.equal(h.jobs[0].openSessionId, 'open');
    renderer.window.wb.conversations.currentId = '';
    renderer.document.querySelector = selector => selector === '.cr-document[data-root-id]' ? { getAttribute: () => 'mounted-session' } : null;
    assert.equal(renderer.acActiveConversationId(), '', 'SDK hydration remains authoritative for monitors');
    assert.equal(renderer.acSwitchConversationId(), 'mounted-session', 'switch keeps its mounted-document fallback');
    delete renderer.window.wb;
    assert.equal(renderer.acActiveConversationId(), 'stale', 'legacy WorkBuddy cache path is unchanged');
    assert.equal(nativeLookups, 0, 'CodeBuddy discovery must never run for WorkBuddy');
  });
}
