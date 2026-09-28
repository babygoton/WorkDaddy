'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const source = fs.readFileSync(require.resolve('../scripts/daemon.js'), 'utf8');

function harness({ kind = 'workbuddy', owner = 'target', connected = true, reject = false, status = 'copied' } = {}) {
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
    const job = ctx.startAutoCopyJob('source', 'target', []);
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

for (const options of [{ kind: 'codebuddy' }, { owner: 'other-account' }, { connected: false }, { status: 'skipped' }]) {
  test('list refresh respects profile, account, connection and unchanged-copy boundaries: ' + JSON.stringify(options), async () => {
    const h = harness(options);
    assert.equal((await h.run()).status, 'done');
    assert.equal(h.calls.length, 0);
  });
}

test('an unavailable renderer never turns a committed session copy into failure', async () => {
  const h = harness({ reject: true });
  const job = await h.run();
  assert.equal(job.status, 'done');
  assert.equal(job.copied, 2);
  assert.equal(job.failed, 0);
});
