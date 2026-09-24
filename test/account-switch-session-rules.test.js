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
    sqliteQuery: async () => owner ? [{ user_id: owner, cwd: '/current-workspace' }] : [],
    switchTo: (_, uid) => { events.push('switch'); return { uid }; },
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
  return { jobs, events, run: () => ctx.switchRoute({ method: 'POST', body: { uid: 'target', reload: true, currentConversationId: 'open' } }, {}) };
}

test('switch route reloads without syncing when no rule is enabled', async () => {
  const h = harness({ allSessions: false, sessionIds: [], workspaces: [] });
  const result = await h.run();
  assert.equal(result.status, 200);
  assert.equal(result.body.reloaded, true);
  assert.equal(h.jobs.length, 0);
  assert.deepEqual(h.events, ['switch', 'reload', 'release-reload', 'release-switch']);
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
