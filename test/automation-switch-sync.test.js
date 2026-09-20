'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness() {
  let active = { uid: 'a' }, reloadPriority = 0;
  const switches = [], jobs = [], phases = [];
  const ctx = {
    PROFILE: { kind: 'workbuddy' }, DATA_DIR: '/synthetic', log() {},
    cdp: { connected: true }, cdpSend: async () => ({ result: { value: false } }),
    currentAccount: () => active, switchTo: (_dir, uid) => { switches.push(uid); return (active = { uid }); },
    reloadWorkBuddyPage: async () => {}, pendingAutomationAccountSwitch: null,
    dispatchAutomationEvent() {}, mainFrameNavigationSerial: 1,
    beginRendererReloadPriority: () => { reloadPriority++; return () => { reloadPriority--; }; },
    getAutoCopyRules: () => ({ allSessions: true }),
    autoCopyJobs: new Map(), autoCopyQueue: [], autoCopyWorkerRunning: false,
    sessionCopyLocks: new Map(), sleep: tick,
    startAutoCopyJob: (_from, to) => {
      let complete;
      const job = { id: 'job-' + jobs.length, targetUid: to, status: 'running', total: 1, processed: 0,
        failed: 0, partial: 0, conflicts: 0, completion: new Promise(resolve => { complete = resolve; }) };
      job.finish = (status = 'done') => { job.status = status; job.processed = 1; ctx.autoCopyWorkerRunning = false; if (ctx.recordAccountSyncResult) ctx.recordAccountSyncResult(job); complete(job); };
      ctx.autoCopyWorkerRunning = true; ctx.autoCopyJobs.set(job.id, job); jobs.push(job); return job;
    },
  };
  vm.runInNewContext(source.slice(source.indexOf('let accountSwitchInProgress ='), source.indexOf('function startAutomationRun(')), ctx);
  const options = { onProgress: value => phases.push(value) };
  return { ctx, switches, jobs, phases, options, priority: () => reloadPriority, active: () => active };
}

test('switch waits for its exact sync job and releases reload priority before waiting', async () => {
  const h = harness(); let done = false;
  const run = h.ctx.automationSwitchAccount({ uid: 'b' }, h.options).then(() => { done = true; });
  await tick(); await tick();
  assert.equal(h.jobs.length, 1); assert.equal(h.priority(), 0);
  assert.equal(done, false, 'switch must not resolve merely because sync started');
  await assert.rejects(h.ctx.assertAccountSwitchIdle(), /账号正在切换/);
  h.jobs[0].finish(); await run;
  assert.equal(done, true); assert.ok(h.phases.some(p => p.phase === 'syncing-sessions'));
  (await h.ctx.assertAccountSwitchIdle())();
});

test('queued automation switches wait for preceding sync before switching', async () => {
  const h = harness();
  const first = h.ctx.automationSwitchAccount({ uid: 'b' }, h.options);
  const next = h.ctx.automationSwitchAccount({ uid: 'c' }, h.options);
  await tick(); await tick(); assert.deepEqual(h.switches, ['b']);
  h.jobs[0].finish(); await first; await tick(); await tick();
  assert.deepEqual(h.switches, ['b', 'c']);
  h.jobs[1].finish(); await next;
});

for (const status of ['partial', 'conflict', 'error']) test('failed sync blocks following switch and restoration: ' + status, async () => {
  const h = harness();
  const run = h.ctx.automationSwitchAccount({ uid: 'b' }, h.options);
  const rejected = assert.rejects(run, /同步/);
  await tick(); await tick(); h.jobs[0].finish(status); await rejected;
  await assert.rejects(h.ctx.automationSwitchAccount({ uid: 'a' }, { ...h.options, restore: true }), /同步/);
  assert.deepEqual(h.switches, ['b']);
});

test('same-account steps also wait for existing inbound sync', async () => {
  const h = harness(); const job = h.ctx.startAutoCopyJob('other', 'a'); let done = false;
  const run = h.ctx.automationSwitchAccount({ uid: 'a' }, h.options).then(() => { done = true; });
  await tick(); await tick(); assert.equal(done, false);
  job.finish(); await run; assert.deepEqual(h.switches, []);
});

test('cancellation drains writing before releasing the switch lock; restore is still safe', async () => {
  const h = harness(); let cancelled = false, done = false;
  const run = h.ctx.automationSwitchAccount({ uid: 'b' }, { ...h.options, isCancelled: () => cancelled });
  const rejected = assert.rejects(run, /停止/).then(() => { done = true; });
  await tick(); await tick(); cancelled = true; await tick();
  assert.equal(done, false);
  await assert.rejects(h.ctx.assertAccountSwitchIdle(), /账号正在切换/);
  h.jobs[0].finish(); await rejected;
  const restore = h.ctx.automationSwitchAccount({ uid: 'a' }, { ...h.options, restore: true });
  await tick(); await tick(); h.jobs[1].finish(); await restore;
  assert.equal(h.active().uid, 'a');
});

test('waiting for existing manual copy can be cancelled without a switch', async () => {
  const h = harness(); let cancelled = false;
  h.ctx.sessionCopyLocks.set('manual', Promise.resolve());
  const run = h.ctx.automationSwitchAccount({ uid: 'b' }, { isCancelled: () => cancelled });
  const rejected = assert.rejects(run, /停止/);
  await tick(); cancelled = true; await rejected;
  assert.deepEqual(h.switches, []);
});

test('pruning public job history cannot erase failed synchronization; successful retry clears it', async () => {
  const h = harness(); const failed = h.ctx.startAutoCopyJob('other', 'a');
  failed.finish('partial'); h.ctx.autoCopyJobs.clear();
  let outcome;
  const attempt = h.ctx.automationSwitchAccount({ uid: 'b' }).then(() => { outcome = 'success'; }, error => { outcome = error.message; });
  await tick(); await tick();
  if (h.jobs[1]) h.jobs[1].finish();
  await attempt;
  assert.match(outcome, /同步/);
  assert.deepEqual(h.switches, []);
  const retry = h.ctx.startAutoCopyJob('other', 'a'); retry.finish();
  const run = h.ctx.automationSwitchAccount({ uid: 'b' });
  await tick(); await tick(); h.jobs[2].finish(); await run;
  assert.deepEqual(h.switches, ['b']);
});
