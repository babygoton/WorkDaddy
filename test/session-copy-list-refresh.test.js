'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const source = fs.readFileSync(require.resolve('../scripts/daemon.js'), 'utf8');

function harness({ kind = 'workbuddy', owner = 'target', connected = true, reject = false, status = 'copied', openSessionId = '' } = {}) {
  const stored = new Set(), visible = new Set(), calls = [];
  let activeSession = 'existing-session';
  const ctx = { crypto, Date, PROFILE: { kind }, cdp: { connected },
    currentAccount: () => ({ uid: owner }),
    autoCopyJobs: new Map(), autoCopyQueue: [],
    yieldAutoCopyToRenderer: async () => {},
    buildAutoCopyPlan: async () => [{ id: 'a' }, { id: 'b' }],
    copySessionRecord: async row => {
      await Promise.resolve();
      if (status === 'copied') stored.add(row.id);
      return { status, sourceId: row.id, targetId: row.id };
    },
    cdpSend: async (method, params) => {
      calls.push(method);
      assert.equal(stored.size, 2, 'refresh must follow the whole batch, not the first worker');
      assert.equal([...ctx.autoCopyJobs.values()][0].status, 'running');
      if (reject) throw Error('renderer disconnected');
      const value = await vm.runInNewContext(params.expression, {
        window: { wb: { conversations: {
          ensureList: async (space, filter) => {
            assert.equal(space, 'local');
            assert.equal(filter.view, 'active');
            for (const id of stored) visible.add(id);
          },
          setCurrentConversation() { activeSession = 'wrong'; },
        } } },
        setTimeout, clearTimeout,
      });
      return { result: { value } };
    },
    setTimeout, clearTimeout, log() {}, pruneAutoCopyJobs() {}, runAutoCopyQueue() {},
  };
  const start = source.indexOf('function startAutoCopyJob(');
  vm.runInNewContext(source.slice(start, source.indexOf('function activeAutoCopyJob(', start)), ctx);
  return { stored, visible, calls, active: () => activeSession, run: async () => {
    const job = ctx.startAutoCopyJob('source', 'target', [], { openSessionId });
    await ctx.autoCopyQueue[0].run();
    return job;
  } };
}

test('completed copy batches publish the new WorkBuddy list before reporting done without navigating', async () => {
  const h = harness();
  const job = await h.run();
  assert.equal(job.status, 'done');
  assert.deepEqual([...h.visible], [...h.stored], 'committed sessions must also reach the official list');
  assert.equal(h.calls.length, 1);
  assert.equal(h.active(), 'existing-session');
});

async function manualCopy({ kind = 'workbuddy', owner = 'target', connected = true, reject = false, status = 'copied' } = {}) {
  const stored = new Set(), visible = new Set(), calls = [];
  const ctx = {
    PROFILE: { kind }, cdp: { connected },
    currentAccount: () => ({ uid: owner }),
    readBody: async () => ({ ids: ['a', 'b'], targetUid: 'target' }),
    normalizeSessionIdBatch: ids => ids,
    accountSwitchInProgress: false, sessionCopyLocks: new Map(),
    sqlPlaceholders: () => '?,?',
    sqliteQuery: async () => [{ id: 'a' }, { id: 'b' }],
    copySessionRecord: async row => {
      if (status === 'copied') stored.add(row.id);
      return { status };
    },
    cdpSend: async (method, params) => {
      calls.push(method);
      assert.equal(stored.size, 2, 'manual refresh must follow the whole batch');
      if (reject) throw Error('renderer disconnected');
      const value = await vm.runInNewContext(params.expression, {
        window: { wb: { conversations: {
          ensureList: async () => { for (const id of stored) visible.add(id); },
        } } },
      });
      return { result: { value } };
    },
    reloadIdeWorkbenchWindows() {},
    json: (_res, code, body) => ({ code, body }),
    setTimeout, clearTimeout, log() {},
  };
  const refreshStart = source.indexOf('async function refreshWorkBuddySessionList(');
  vm.runInNewContext(source.slice(refreshStart, source.indexOf('async function refreshCopiedSessionList(', refreshStart)), ctx);
  const routeStart = source.indexOf("if (req.method === 'POST' && p === '/api/sessions/copy')");
  const routeEnd = source.indexOf('  // 迁移会话：', routeStart);
  vm.runInNewContext("function serve(req, res) { const p = '/api/sessions/copy';\n" + source.slice(routeStart, routeEnd) + '\n}', ctx);
  const response = await ctx.serve({ method: 'POST' }, {});
  assert.equal(ctx.sessionCopyLocks.size, 0);
  return { response, stored, visible, calls };
}

test('manual copies publish the whole batch in the current WorkBuddy list before returning success', async () => {
  const h = await manualCopy();
  assert.equal(h.response.code, 200);
  assert.equal(h.response.body.copied, 2);
  assert.deepEqual([...h.visible], ['a', 'b']);
  assert.deepEqual(h.calls, ['Runtime.evaluate'], 'copy must refresh without reloading or navigating');
});

for (const options of [{ kind: 'codebuddy' }, { owner: 'other-account' }, { connected: false }, { status: 'skipped' }]) {
  test('manual copy refresh respects profile, account, connection and unchanged-copy boundaries: ' + JSON.stringify(options), async () => {
    const h = await manualCopy(options);
    assert.equal(h.response.code, 200);
    assert.equal(h.calls.length, 0);
  });
}

test('manual copies remain successful if the renderer disconnects after the data is committed', async () => {
  const h = await manualCopy({ reject: true });
  assert.equal(h.response.code, 200);
  assert.equal(h.response.body.copied, 2);
  assert.equal(h.stored.size, 2);
  assert.equal(h.calls.length, 1);
});

for (const options of [{ kind: 'codebuddy' }, { owner: 'other-account' }, { connected: false }, { status: 'skipped' }]) {
  test('list refresh respects profile, account, connection and unchanged-copy boundaries: ' + JSON.stringify(options), async () => {
    const h = harness(options);
    assert.equal((await h.run()).status, 'done');
    assert.equal(h.calls.length, 0);
  });
}

test('an opened session still refreshes the official list when its copy is unchanged', async () => {
  const h = harness({ status: 'skipped', openSessionId: 'a' });
  const job = await h.run();
  assert.equal(job.status, 'done');
  assert.equal(h.calls.length, 1, 'the active session needs hydration even when its files were already present');
});

test('explicit migration wires the same official list refresh seam', () => {
  const routeStart = source.indexOf("if (req.method === 'POST' && p === '/api/sessions/migrate')");
  assert.notEqual(routeStart, -1);
  const route = source.slice(routeStart, routeStart + 2200);
  assert.match(route, /await refreshWorkBuddySessionList\(String\(\(currentAccount\(\) \|\| \{\}\)\.uid \|\| ''\)\.trim\(\), 'sessions-migrate'\)/);
});

test('account reload does not refresh the official list a second time', async () => {
  const start = source.indexOf('async function reloadWorkBuddyPage(');
  const end = source.indexOf('const WORKBUDDY_TARGET', start);
  assert.ok(start >= 0 && end > start);
  let refreshes = 0;
  const calls = [];
  const ctx = {
    cdp: { connected: true },
    cdpSend: async (method) => { calls.push(method); },
    armPendingReloadInjection: () => ({ ready: Promise.resolve(true) }),
    settlePendingReloadInjection: () => {},
    currentAccount: () => ({ uid: 'target' }),
    refreshWorkBuddySessionList: async () => { refreshes++; return true; },
    log: () => {},
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(source.slice(start, end), ctx);
  assert.equal(await ctx.reloadWorkBuddyPage({ waitForInjection: false }), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['Page.getFrameTree', 'Page.reload']);
  assert.equal(refreshes, 0);
});

test('an unavailable renderer never turns a committed session copy into failure', async () => {
  const h = harness({ reject: true });
  const job = await h.run();
  assert.equal(job.status, 'done');
  assert.equal(job.copied, 2);
  assert.equal(job.failed, 0);
});
