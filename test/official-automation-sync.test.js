'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSessionDb } = require('../scripts/session-db');
const { createOfficialAutomationSync } = require('../scripts/official-automation-sync');

async function fixture(t, accounts = ['a', 'b', 'h']) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-official-sync-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const db = createSessionDb({ dbPath: path.join(dataDir, 'tasks.db') });
  // Real WorkBuddy constraints: the former mock accepted invalid NULL rrules
  // and did not execute UPDATEs, hiding both copy and rename regressions.
  await db.run(`CREATE TABLE automations (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL,
    schedule_type TEXT NOT NULL DEFAULT 'recurring', next_run_at INTEGER, last_run_at INTEGER,
    cwds TEXT NOT NULL DEFAULT '[]', rrule TEXT NOT NULL DEFAULT '', scheduled_at TEXT,
    valid_from TEXT, valid_until TEXT, model_id TEXT, model_is_thinking INTEGER NOT NULL DEFAULT 0,
    skills_json TEXT NOT NULL DEFAULT '[]', push_to_wechat INTEGER NOT NULL DEFAULT 0,
    push_to_wecom_bot INTEGER NOT NULL DEFAULT 0, owner_user_id TEXT,
    owner_status TEXT NOT NULL DEFAULT 'legacy_unassigned', owner_source TEXT, expert_id TEXT,
    expert_marketplace TEXT, connector_ids_json TEXT NOT NULL DEFAULT '[]', permission_mode TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER,
    wecom_bot_source TEXT, context_window INTEGER, reasoning_effort TEXT, workspace_scope TEXT,
    wecom_bot_chat_id TEXT)`);
  const insert = async (id, owner, extra = {}) => {
    const row = { id, owner_user_id: owner, name: 'AI 信息汇总', prompt: 'fixture prompt',
      status: 'ACTIVE', rrule: 'FREQ=DAILY;BYHOUR=10', created_at: 1, updated_at: 1, ...extra };
    const columns = Object.keys(row);
    await db.run(`INSERT INTO automations (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, Object.values(row));
  };
  const mappingFile = path.join(dataDir, 'official-automation-sync.json');
  const buildSync = (options = {}) => createOfficialAutomationSync({ dataDir, db, getAccountUids: () => accounts, ...options });
  const live = owner => db.all("SELECT * FROM automations WHERE owner_user_id = ? AND deleted_at IS NULL AND status <> 'ARCHIVED' ORDER BY name", [owner]);
  const names = async owner => (await live(owner)).map(r => r.name);
  return { db, insert, mappingFile, buildSync, live, names };
}

test('account round trip: A rename, B rename, back to A, all saved accounts converge without new IDs', async t => {
  const f = await fixture(t);
  await f.insert('a-original', 'a');
  await f.insert('h-once', 'h', { name: '111', schedule_type: 'once', rrule: '', scheduled_at: '2030-01-01T10:00:00Z' });
  let sync = f.buildSync();
  await sync('a', 'b');
  const ids = await f.db.all('SELECT id FROM automations ORDER BY id');
  await f.db.run('UPDATE automations SET name = ?, updated_at = ? WHERE id = ?', ['改名 A', 2, 'a-original']);
  await sync('a', 'b');
  for (const owner of ['a', 'b', 'h']) assert.deepEqual(await f.names(owner), ['111', '改名 A']);
  const bId = (await f.live('b')).find(r => r.name === '改名 A').id;
  await f.db.run('UPDATE automations SET name = ?, updated_at = ? WHERE id = ?', ['改名 B', 3, bId]);
  sync = f.buildSync(); // Daemon restart must keep the lineage and edit baseline.
  for (const [from, to] of [['b', 'a'], ['a', 'h'], ['h', 'b'], ['b', 'a']]) {
    await sync(from, to);
    for (const owner of ['a', 'b', 'h']) assert.deepEqual(await f.names(owner), ['111', '改名 B']);
  }
  assert.deepEqual(await f.db.all('SELECT id FROM automations ORDER BY id'), ids);
});

test('legacy mapping graph includes reverse/transitive edges and retires only proven duplicates', async t => {
  const f = await fixture(t);
  await f.insert('a-old', 'a', { updated_at: 1 });
  await f.insert('a-copy', 'a', { name: '最新名称', updated_at: 5 });
  await f.insert('b-copy', 'b', { name: '中间名称', updated_at: 3 });
  await f.insert('h-copy', 'h', { updated_at: 2 });
  await f.insert('h-unique', 'h', { name: '独有任务' });
  fs.writeFileSync(f.mappingFile, JSON.stringify({
    'a:a-old:b': { targetAutomationId: 'b-copy' },
    'h:h-copy:b': { targetAutomationId: 'b-copy' },
    'h:h-copy:a': { targetAutomationId: 'a-copy' },
  }));
  const sync = f.buildSync();
  for (const pair of [['b', 'h'], ['h', 'a'], ['a', 'b']]) {
    await sync(...pair);
    for (const owner of ['a', 'b', 'h']) assert.deepEqual(await f.names(owner), ['最新名称', '独有任务']);
  }
  const retired = (await f.db.all('SELECT deleted_at FROM automations WHERE id = ?', ['a-old']))[0];
  assert.ok(retired.deleted_at, 'duplicate is recoverable, not physically deleted');
});

test('execution bookkeeping cannot overwrite a rename with a stale definition', async t => {
  const f = await fixture(t);
  await f.insert('a', 'a', { next_run_at: 100, last_run_at: 50 });
  const sync = f.buildSync();
  await sync('a', 'b');
  await f.db.run('UPDATE automations SET name = ?, updated_at = ? WHERE id = ?', ['新名称', 10, 'a']);
  await f.db.run('UPDATE automations SET updated_at = ?, last_run_at = ?, next_run_at = ? WHERE owner_user_id = ?', [20, 200, 300, 'b']);
  await sync('a', 'b');
  assert.deepEqual(await f.names('b'), ['新名称']);
  const b = (await f.live('b'))[0];
  assert.equal(b.last_run_at, 200);
  assert.equal(b.next_run_at, 300);
});

test('same-timestamp edits propagate; paused state and schedule changes propagate too', async t => {
  const f = await fixture(t);
  await f.insert('a', 'a');
  const sync = f.buildSync();
  await sync('a', 'b');
  await f.db.run('UPDATE automations SET name = ?, status = ?, rrule = ?, next_run_at = ? WHERE owner_user_id = ?', ['同毫秒改名', 'PAUSED', 'FREQ=WEEKLY', 888, 'b']);
  await sync('b', 'a');
  for (const owner of ['a', 'b', 'h']) {
    const row = (await f.live(owner))[0];
    assert.equal(row.name, '同毫秒改名');
    assert.equal(row.status, 'PAUSED');
    assert.equal(row.rrule, 'FREQ=WEEKLY');
    assert.equal(row.next_run_at, 888);
  }
});

test('adoption is one-to-one; intentional identical tasks and different once schedules survive', async t => {
  const f = await fixture(t);
  await f.insert('a1', 'a');
  await f.insert('a2', 'a');
  await f.insert('b1', 'b');
  await f.insert('once-a', 'a', { name: 'once', schedule_type: 'once', rrule: '', scheduled_at: '2030-01-01' });
  await f.insert('once-b', 'b', { name: 'once', schedule_type: 'once', rrule: '', scheduled_at: '2030-01-02' });
  const sync = f.buildSync();
  await sync('a', 'b');
  await sync('b', 'h');
  for (const owner of ['a', 'b', 'h']) assert.equal((await f.live(owner)).length, 4);
});

test('deletion of a mapped task propagates and never resurrects on reverse switching', async t => {
  const f = await fixture(t);
  await f.insert('a', 'a');
  await f.insert('already-deleted', 'a', { deleted_at: 2, updated_at: 2 });
  const sync = f.buildSync();
  await sync('a', 'b');
  assert.equal((await f.live('b')).length, 1);
  await f.db.run('UPDATE automations SET deleted_at = ?, updated_at = ? WHERE owner_user_id = ?', [10, 10, 'b']);
  for (const pair of [['b', 'h'], ['h', 'a'], ['a', 'b']]) await sync(...pair);
  for (const owner of ['a', 'b', 'h']) assert.deepEqual(await f.names(owner), []);
});

test('mapping persistence failure does not leave untracked new copies in SQLite', async t => {
  const f = await fixture(t);
  await f.insert('a', 'a');
  fs.mkdirSync(f.mappingFile);
  await assert.rejects(f.buildSync()('a', 'b'));
  assert.deepEqual(await f.names('b'), []);
});

test('invalid or identical accounts do not write the database', async t => {
  const f = await fixture(t);
  await f.insert('a', 'a');
  const sync = f.buildSync();
  await sync('../bad', 'b');
  await sync('a', 'a');
  assert.deepEqual(await f.names('b'), []);
});

test('failed SQL transaction is retried with the reserved lineage; concurrent calls do not duplicate', async t => {
  const f = await fixture(t);
  await f.insert('a', 'a');
  let failOnce = true;
  const sync = f.buildSync({ db: { ...f.db, async transaction(statements) {
    if (failOnce) { failOnce = false; throw new Error('fixture busy'); }
    return f.db.transaction(statements);
  } } });
  await assert.rejects(sync('a', 'b'), /fixture busy/);
  await Promise.all([sync('a', 'b'), sync('a', 'h'), sync('h', 'b')]);
  for (const owner of ['a', 'b', 'h']) assert.equal((await f.live(owner)).length, 1);
});

test('historical NULL optional settings use official defaults when copied', async t => {
  const f = await fixture(t);
  await f.insert('a', 'a', { schedule_type: 'once', rrule: '', scheduled_at: '2030-01-01' });
  const sync = f.buildSync({ db: { ...f.db, async all(sql, params) {
    return (await f.db.all(sql, params)).map(row => ({ ...row, rrule: null, skills_json: null }));
  } } });
  await sync('a', 'b');
  const copy = (await f.live('b'))[0];
  assert.equal(copy.rrule, '');
  assert.equal(copy.skills_json, '[]');
});

test('corrupt lineage records fail closed and accounts outside the saved set stay untouched', async t => {
  const f = await fixture(t);
  await f.insert('a', 'a');
  await f.insert('outside', 'outside', { name: '不参与同步' });
  fs.writeFileSync(f.mappingFile, '{broken');
  await assert.rejects(f.buildSync()('a', 'b'), /同步记录无法读取/);
  assert.deepEqual(await f.names('b'), []);
  fs.unlinkSync(f.mappingFile);
  await f.buildSync()('a', 'b');
  assert.deepEqual(await f.names('outside'), ['不参与同步']);
  for (const owner of ['a', 'b', 'h']) assert.deepEqual(await f.names(owner), ['AI 信息汇总']);
});
