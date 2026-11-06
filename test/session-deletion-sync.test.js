const assertSessionAccountIdentity = require('../scripts/account-identity').createSessionAccountResolver([]).assertUnambiguous;
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSessionDb } = require('../scripts/session-db');
const lib = require('../scripts/lib');
const { createSessionDeletionSync } = require('../scripts/session-deletion-sync');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-deletion-sync-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = createSessionDb({ dbPath: path.join(root, 'sessions.db') });
  await db.run('CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT, deleted_at INTEGER, updated_at INTEGER, is_background_automation INTEGER DEFAULT 0)');
  const lineage = lib.ensureAutoCopySession(root, 'one', 'a');
  for (const [id, uid] of [['a', 'one'], ['b', 'two'], ['c', 'three']]) {
    lib.addAutoCopySessionMember(root, lineage, uid, id);
    await db.run('INSERT INTO sessions (id, user_id, updated_at) VALUES (?, ?, 1)', [id, uid]);
  }
  await db.run('INSERT INTO sessions (id, user_id, updated_at) VALUES (?, ?, 1)', ['unrelated', 'one']);
  const locks = new Map();
  const make = () => createSessionDeletionSync({ query: db.all, run: db.run, locks,
    members: ids => lib.collectLineageMembersForDelete(root, ids) });
  const alive = async () => (await db.all('SELECT id FROM sessions WHERE deleted_at IS NULL ORDER BY id')).map(r => r.id);
  return { root, db, locks, lineage, sync: make(), make, alive };
}

test('official soft deletion propagates across known copies and survives restart; restore is lineage-wide', async t => {
  const f = await fixture(t);
  await f.db.run('UPDATE sessions SET deleted_at = 100 WHERE id = ?', ['a']);
  assert.equal(await f.sync.hasDeletion('b', 'two'), true);
  await f.sync.reconcileAll();
  assert.deepEqual(await f.alive(), ['unrelated']);
  assert.equal(await f.make().hasDeletion('c', 'three'), true);
  assert.equal(await f.make().reconcileAll(), 0, 'repeated reconciliation must not rewrite deleted records');
  await f.sync.restore(['b']);
  assert.deepEqual(await f.alive(), ['a', 'b', 'c', 'unrelated']);
  assert.equal(await f.make().hasDeletion('a', 'one'), false);
});

test('explicit hard deletion requires known owner; mere absence never means deletion', async t => {
  const f = await fixture(t);
  await f.db.run('DELETE FROM sessions WHERE id = ?', ['a']);
  assert.equal(await f.sync.hasDeletion('b', 'two'), false);
  await f.sync.reconcileAll();
  assert.deepEqual(await f.alive(), ['b', 'c', 'unrelated']);
  await f.sync.observeDeleted('foreign', ['a']);
  assert.deepEqual(await f.alive(), ['b', 'c', 'unrelated']);
  await f.sync.observeDeleted('one', ['a']);
  assert.deepEqual(await f.alive(), ['unrelated']);
  assert.equal(await f.make().hasDeletion('b', 'two'), true);
});

test('live records, foreign owners and background automation cannot authorize cascade deletion', async t => {
  const f = await fixture(t);
  await f.sync.observeDeleted('one', ['a']);
  assert.deepEqual(await f.alive(), ['a', 'b', 'c', 'unrelated']);
  await f.db.run('UPDATE sessions SET deleted_at = 100, user_id = ? WHERE id = ?', ['foreign', 'a']);
  await f.sync.reconcileAll();
  assert.deepEqual(await f.alive(), ['b', 'c', 'unrelated']);
  await f.db.run('UPDATE sessions SET user_id = ?, is_background_automation = 1 WHERE id = ?', ['one', 'a']);
  await f.sync.reconcileAll();
  assert.deepEqual(await f.alive(), ['b', 'c', 'unrelated']);
});

test('deletion waits for in-flight copy, then includes the copy published before lock release', async t => {
  const f = await fixture(t);
  let release;
  const inFlight = new Promise(resolve => { release = resolve; });
  f.locks.set(f.lineage, inFlight);
  await f.db.run('UPDATE sessions SET deleted_at = 100 WHERE id = ?', ['a']);
  let finished = false;
  const deletion = f.sync.observeDeleted('one', ['a']).then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  lib.addAutoCopySessionMember(f.root, f.lineage, 'four', 'd');
  await f.db.run('INSERT INTO sessions (id, user_id, updated_at) VALUES (?, ?, 1)', ['d', 'four']);
  release(); await deletion;
  assert.deepEqual(await f.alive(), ['unrelated']);
  assert.equal(f.locks.size, 0);
});

test('a failed database write leaves deletion evidence for a later retry', async t => {
  const f = await fixture(t);
  await f.db.run('UPDATE sessions SET deleted_at = 100 WHERE id = ?', ['a']);
  const failing = createSessionDeletionSync({ query: f.db.all, run: async () => { throw Error('locked'); }, locks: f.locks,
    members: ids => lib.collectLineageMembersForDelete(f.root, ids) });
  await assert.rejects(failing.reconcileAll(), /locked/);
  assert.equal(f.locks.size, 0);
  await f.make().reconcileAll();
  assert.deepEqual(await f.alive(), ['unrelated']);
});

test('renderer deletion route rejects a stale account and reconciles missed deletion on baseline', async () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');
  const start = source.indexOf("  if (req.method === 'POST' && p === '/api/sessions/dirty')");
  const end = source.indexOf('\n  }', start) + 4;
  const calls = [];
  const context = { assertSessionAccountIdentity,
    readBody: async req => req.body, currentAccount: () => ({ uid: 'one' }),
    json: (_, status, body) => ({ status, body }), isValidSessionId: id => /^[a-z-]+$/.test(id),
    markSessionDirty: (...args) => calls.push(['dirty', ...args]), markSessionDirtyBaseline() {},
    getSessionDirtyIndex: () => ({ isInitialized: () => true }),
    getSessionDeletionSync: () => ({
      observeDeleted: async (uid, ids) => { calls.push(['deleted', uid, ...ids]); return 1; },
      reconcileAll: async () => { calls.push(['reconcile']); return 1; },
    }),
    refreshWorkBuddySessionList: async uid => calls.push(['refresh', uid]),
  };
  vm.runInNewContext('async function route(req,res) { const p="/api/sessions/dirty";\n' + source.slice(start,end) + '\n}', context);
  const call = body => context.route({ method: 'POST', body }, {});
  assert.equal((await call({ uid: 'two', events: [{ id: 'a', event: 'sessionDeleted' }] })).status, 409);
  assert.deepEqual(calls, []);
  assert.equal((await call({ uid: 'one', events: [{ id: 'a', event: 'sessionDeleted' }] })).status, 200);
  assert.deepEqual(calls, [['dirty', 'one', 'a', 'sessionDeleted'], ['deleted', 'one', 'a'], ['refresh', 'one']]);
  calls.length = 0;
  assert.equal((await call({ uid: 'one', ready: true })).status, 200);
  assert.deepEqual(calls, [['reconcile'], ['refresh', 'one']]);
});
