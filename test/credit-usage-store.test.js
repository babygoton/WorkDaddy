'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createCreditUsageStore } = require('../scripts/credit-usage-store.js');

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-credit-usage-'));
  return {
    dir,
    store: createCreditUsageStore({
      dbPath: path.join(dir, 'credit-usage.db'),
      profileId: 'workbuddy-cn',
    }),
  };
}

function record(requestId, usageDate, credit, requestTime) {
  return {
    requestId,
    usageDate,
    credit,
    requestTime,
    model: 'model-a',
    client: 'desktop',
    agentPurpose: 'chat',
  };
}

test('persists usage by profile, uid and request id and aggregates all cached accounts', async (t) => {
  const tmp = tempStore();
  t.after(() => fs.rmSync(tmp.dir, { recursive: true, force: true }));

  await tmp.store.saveSuccessfulSync({
    uid: 'u1',
    records: [
      record('r1', '2026-08-28', 1.25, 1000),
      record('r2', '2026-08-28', 2.5, 2000),
    ],
    anchorRequestId: 'r2',
    syncedAt: 3000,
  });
  await tmp.store.saveSuccessfulSync({
    uid: 'u2',
    records: [record('r3', '2026-08-28', 4, 2500)],
    anchorRequestId: 'r3',
    syncedAt: 3500,
  });
  await tmp.store.saveSuccessfulSync({
    uid: 'u3',
    records: [],
    anchorRequestId: '',
    syncedAt: new Date(2026, 7, 28, 12, 0, 0).getTime(),
  });

  const summaries = await tmp.store.listDailyUsage(['u1', 'u2', 'u3', 'u4'], '2026-08-28');
  assert.deepEqual(summaries, {
    u1: { date: '2026-08-28', used: 3.75, count: 2, synced: true },
    u2: { date: '2026-08-28', used: 4, count: 1, synced: true },
    u3: { date: '2026-08-28', used: 0, count: 0, synced: true },
  });
  assert.equal(Object.prototype.hasOwnProperty.call(summaries, 'u4'), false);
});

test('repeated official request ids update instead of double counting and preserve sync state', async (t) => {
  const tmp = tempStore();
  t.after(() => fs.rmSync(tmp.dir, { recursive: true, force: true }));

  await tmp.store.saveSuccessfulSync({
    uid: 'u1',
    records: [record('same-request', '2026-08-28', 1, 1000)],
    anchorRequestId: 'same-request',
    syncedAt: 2000,
  });
  await tmp.store.saveSuccessfulSync({
    uid: 'u1',
    records: [record('same-request', '2026-08-28', 2, 1000)],
    anchorRequestId: 'new-anchor',
    syncedAt: 3000,
  });

  assert.deepEqual(await tmp.store.dailyUsageForUid('u1', '2026-08-28'), {
    date: '2026-08-28',
    used: 2,
    count: 1,
    synced: true,
  });
  assert.deepEqual(await tmp.store.getSyncState('u1'), {
    anchorRequestId: 'new-anchor',
    lastSuccessAt: 3000,
  });
});

test('persists verified daily check-in marks by profile, uid and date', async (t) => {
  const tmp = tempStore();
  t.after(() => fs.rmSync(tmp.dir, { recursive: true, force: true }));
  await tmp.store.saveDailyCheckin({ uid: 'u1', date: '2026-08-28', checkedAt: 3000, code: 0, message: 'OK' });
  assert.deepEqual(await tmp.store.getDailyCheckin('u1', '2026-08-28'), {
    date: '2026-08-28', ok: true, already: false, code: 0, message: 'OK', at: 3000, verified: true,
  });
  assert.deepEqual(await tmp.store.listDailyCheckins(['u1', 'u2'], '2026-08-28'), {
    u1: { date: '2026-08-28', ok: true, already: false, code: 0, message: 'OK', at: 3000, verified: true },
  });
  assert.equal(await tmp.store.getDailyCheckin('u1', '2026-08-27'), null);
});

test('history backfill preserves the today anchor, deduplicates, and distinguishes verified zero from missing days', async t => {
  const tmp=tempStore();t.after(()=>fs.rmSync(tmp.dir,{recursive:true,force:true}));
  await tmp.store.saveSuccessfulSync({uid:'u1',records:[],anchorRequestId:'today',syncedAt:9000});
  const input={uid:'u1',from:'2026-08-27',to:'2026-08-28',syncedAt:10000,records:[record('r1','2026-08-28',2.5,1000)]};
  await tmp.store.saveHistoryUsage(input);await tmp.store.saveHistoryUsage(input);
  assert.deepEqual(await tmp.store.getSyncState('u1'),{anchorRequestId:'today',lastSuccessAt:9000});
  const rows=await tmp.store.listDailyUsageRange(['u1','missing'],'2026-08-26','2026-08-28');
  assert.equal(rows.length,2);
  assert.equal(rows.find(r=>r.date==='2026-08-27').used,0);
  assert.equal(rows.find(r=>r.date==='2026-08-27').complete,true);
  assert.equal(rows.find(r=>r.date==='2026-08-28').used,2.5);
  assert.equal(rows.find(r=>r.date==='2026-08-28').count,1);
});
