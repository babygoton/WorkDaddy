'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createSessionDb, normalizeSessionIdBatch } = require('../scripts/session-db');
const lib = require('../scripts/lib');
const source = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-upgrade-deletion-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = createSessionDb({ dbPath: path.join(root, 'sessions.db') });
  await db.run('CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT, deleted_at INTEGER, updated_at INTEGER, is_background_automation INTEGER DEFAULT 0)');
  const lineage = lib.ensureAutoCopySession(root, 'one', 'a');
  for (const [id, uid, deletedAt] of [['a', 'one', 100], ['b', 'two', null], ['c', 'three', null]]) {
    lib.addAutoCopySessionMember(root, lineage, uid, id);
    await db.run('INSERT INTO sessions (id, user_id, deleted_at, updated_at) VALUES (?, ?, ?, 200)', [id, uid, deletedAt]);
    fs.writeFileSync(path.join(root, id + '.jsonl'), JSON.stringify({ type: 'message', sessionId: id, content: 'synthetic' }) + '\n');
  }
  const calls = [];
  const context = {
    normalizeSessionIdBatch, assertSessionAccountIdentity: uid => uid,
    readBody: async req => req.body, currentAccount: () => ({ uid: 'two' }),
    json: (_, status, body) => ({ status, body }), isValidSessionId: id => /^[a-z-]+$/.test(id),
    markSessionDirty: (...args) => calls.push(['dirty', ...args]),
    markSessionDirtyBaseline: uid => calls.push(['baseline', uid]),
    getSessionDirtyIndex: () => ({ isInitialized: () => true }),
    // Notifications must remain an index update, not a deletion authority.
    getSessionDeletionSync() { throw Error('unexpected deletion propagation'); },
    sqliteRun: (sql, params) => db.run(sql, Array.from(params)),
    sqlPlaceholders: ids => ids.map(() => '?').join(','),
  };
  for (const [name, route] of [['dirty', '/api/sessions/dirty'], ['restore', '/api/sessions/restore']]) {
    const start = source.indexOf("  if (req.method === 'POST' && p === '" + route + "')");
    const end = source.indexOf('\n  }', start) + 4;
    assert.ok(start > 0 && end > start);
    vm.runInNewContext('async function ' + name + '(req,res) { const p=' + JSON.stringify(route) + ';\n' + source.slice(start, end) + '\n}', context);
  }
  return { root, db, calls, context,
    rows: () => db.all('SELECT * FROM sessions ORDER BY id'),
    call: (name, body) => context[name]({ method: 'POST', body }, {}),
  };
}

for (const body of [
  { uid: 'two', ready: true, events: [] },
  { uid: 'two', events: [{ id: 'b', event: 'sessionUpdated' }] },
  { uid: 'two', events: [{ id: 'b', event: 'sessionDeleted' }] },
]) test('renderer notification cannot spread a historical deletion: ' + JSON.stringify(body), async t => {
  const f = await fixture(t);
  const before = await f.rows();
  const meta = fs.readFileSync(path.join(f.root, 'meta.json'));
  const messages = ['a', 'b', 'c'].map(id => fs.readFileSync(path.join(f.root, id + '.jsonl')));
  for (let reload = 0; reload < 2; reload++) {
    const result = await f.call('dirty', body);
    assert.equal(result.status, 200);
    assert.deepEqual(await f.rows(), before, 'startup and lifecycle notifications must not change any deletion marker');
  }
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'meta.json')), meta);
  for (const [index, id] of ['a', 'b', 'c'].entries()) assert.deepEqual(fs.readFileSync(path.join(f.root, id + '.jsonl')), messages[index]);
  assert.ok(f.calls.length > 0, 'incremental dirty indexing still receives notifications');
});

test('stale renderer account remains rejected before marking sessions dirty', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('dirty', { uid: 'one', events: [{ id: 'a', event: 'sessionDeleted' }] })).status, 409);
  assert.deepEqual(f.calls, []);
});

test('explicit restore only restores requested ids, preserving other intentional deletions', async t => {
  const f = await fixture(t);
  await f.db.run('UPDATE sessions SET deleted_at = 200 WHERE id = ?', ['b']);
  const result = await f.call('restore', { ids: ['b'] });
  assert.equal(result.status, 200);
  const rows = await f.rows();
  assert.equal(rows.find(row => row.id === 'a').deleted_at, 100);
  assert.equal(rows.find(row => row.id === 'b').deleted_at, null);
  assert.equal(rows.find(row => row.id === 'c').deleted_at, null);
});
