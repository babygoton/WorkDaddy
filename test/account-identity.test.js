'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { accountIdentity, createSessionAccountResolver } = require('../scripts/account-identity');
const { parameterCount, createSessionDb } = require('../scripts/session-db');
const lib = require('../scripts/lib');
const daemon = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');

test('personal upgrades keep their backup key; enterprises have independent stable keys', () => {
  for (const type of ['', 'personal', 'pro', 'free', 'enterprise-trial']) {
    assert.equal(accountIdentity({ uid: 'owner', type }), 'owner');
  }
  const first = accountIdentity({ uid: 'owner', type: 'ultimate', enterpriseId: 'company-a' });
  assert.match(first, /^wdent_[a-f0-9]{64}$/);
  assert.equal(accountIdentity({ uid: 'owner', type: 'exclusive', enterpriseId: 'company-a' }), first);
  assert.notEqual(accountIdentity({ uid: 'owner', type: 'ultimate', enterpriseId: 'company-b' }), first);
  assert.notEqual(accountIdentity({ uid: 'owner', type: 'ultimate' }), 'owner');
});

function harness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-identity-sql-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const db = createSessionDb({ dbPath: path.join(root, 'sessions.db') });
  const accounts = [];
  const ctx = { fs, path, DATA_DIR: root, parameterCount, SESSION_DB: db, CODEBUDDY_SESSIONS: null,
    listAccounts: () => accounts.slice(), knownAccountIdentities: lib.knownAccountIdentities, createSessionAccountResolver };
  vm.runInNewContext(daemon.slice(daemon.indexOf('let sessionAccountResolverCache ='), daemon.indexOf('// WorkBuddy 将会话正文保存在')), ctx);
  return { root, db, ctx, accounts };
}

test('session SQL uses raw official owners for queries and writes while returning backup ids', async t => {
  const { db, ctx, accounts } = harness(t);
  const uid = accountIdentity({ uid: 'official-owner', enterpriseId: 'company' });
  accounts.push({ uid, rawUid: 'official-owner' });
  await db.run('CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT, title TEXT)');
  await ctx.sqliteRun('INSERT INTO sessions (id,user_id,title) VALUES (?,?,?)', ['s', uid, uid]);
  const actual = await db.all('SELECT * FROM sessions');
  assert.equal(actual[0].user_id, 'official-owner');
  assert.equal(actual[0].title, uid, 'a user title that resembles an alias must stay unchanged');
  const rows = await ctx.sqliteQuery("SELECT * FROM sessions WHERE title = ? AND user_id = ? AND '?' = '?'", [uid, uid]);
  assert.equal(rows[0].user_id, uid);
  await ctx.sqliteRun('UPDATE sessions SET user_id = ?, title = ? WHERE id = ?', [uid, 'edited', 's']);
  assert.equal((await db.all('SELECT * FROM sessions'))[0].user_id, 'official-owner');
});

test('same official uid contexts block reads and mutations before SQL and remain blocked after backup deletion', async t => {
  const { root, ctx, accounts } = harness(t);
  const company = accountIdentity({ uid: 'same', enterpriseId: 'company' });
  accounts.push({ uid: company, rawUid: 'same' });
  fs.writeFileSync(path.join(root, 'meta.json'), JSON.stringify({ accounts: {}, accountIdentities: { same: ['same', company] } }));
  let writes = 0;
  ctx.SESSION_DB = { run() { writes++; }, all: async () => [{ id: 's', user_id: 'same' }] };
  assert.throws(() => ctx.sqliteRun('INSERT INTO sessions (id,user_id,title) VALUES (?,?,?)', ['s', company, 'title']), { code: 'WBS_AMBIGUOUS_SESSION_ACCOUNT' });
  await assert.rejects(ctx.sqliteQuery('SELECT * FROM sessions WHERE user_id = ?', [company]), { code: 'WBS_AMBIGUOUS_SESSION_ACCOUNT' });
  await assert.rejects(ctx.sqliteQuery('SELECT * FROM sessions'), { code: 'WBS_AMBIGUOUS_SESSION_ACCOUNT' });
  assert.equal(writes, 0);
});

test('ambiguous synchronization stops during planning before changing session lineage or files', async t => {
  const { root, ctx, accounts } = harness(t);
  const company = accountIdentity({ uid: 'same', enterpriseId: 'company' });
  accounts.push({ uid: 'same', rawUid: 'same' }, { uid: company, rawUid: 'same' });
  Object.assign(ctx, lib, { DATA_DIR: root, listAccounts: () => accounts.slice() });
  const start = daemon.indexOf('async function buildAutoCopyPlan(');
  vm.runInNewContext(daemon.slice(start, daemon.indexOf('const autoCopyJobs', start)), ctx);
  await assert.rejects(ctx.buildAutoCopyPlan('same', company), { code: 'WBS_AMBIGUOUS_SESSION_ACCOUNT' });
  assert.equal(fs.existsSync(path.join(root, 'meta.json')), false);
});

test('account imports keep personal and enterprise contexts through encrypted export roundtrips', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-identity-import-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const personal = { account: { uid: 'same-import', type: 'personal' }, auth: { accessToken: 'fixture-only', domain: 'https://www.workbuddy.cn' } };
  const enterprise = structuredClone(personal);
  Object.assign(enterprise.account, { type: 'ultimate', enterpriseId: 'company-import' });
  const context = { ...lib, fs, DATA_DIR: root, log() {}, req: { method: 'POST' }, p: '/api/accounts/import', res: {},
    json: (_, status, value) => ({ status, ...value }), readBody: async () => ({ format: 'plain-json', content: JSON.stringify([personal, enterprise]) }) };
  const start = daemon.indexOf("  if (req.method === 'POST' && p === '/api/accounts/import')");
  const route = '(async () => {' + daemon.slice(start, daemon.indexOf('  // 清空输入框', start)) + '})()';
  const imported = await vm.runInNewContext(route, context);
  assert.equal(imported.count, 2);
  assert.equal(lib.listAccounts(root).length, 2);
  const items = imported.imported.map(uid => ({ uid, info: fs.readFileSync(lib.backupPath(root, uid), 'utf8') }));
  // The export encryption layer is independent of identities; exercise its real codec.
  const { createEncryptedExport, openEncryptedExport } = require('../scripts/secure-transfer');
  const encrypted = createEncryptedExport('accounts', { exportType: 'WorkDaddy-accounts', version: 2, accounts: items }, 'fixture-password');
  const target = path.join(root, 'roundtrip');
  context.DATA_DIR = target;
  context.openEncryptedExport = openEncryptedExport;
  context.readBody = async () => ({ content: encrypted, password: 'fixture-password' });
  const restored = await vm.runInNewContext(route, context);
  assert.equal(restored.count, 2);
  for (const item of items) assert.equal(fs.readFileSync(lib.backupPath(target, item.uid), 'utf8'), item.info);
});

test('seamless login saves enterprise credentials under their scoped backup identity', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-identity-oauth-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const context = { ...lib, fs, DATA_DIR: root, accountIdentity, log() {}, normTs: value => value || null, currentAuthFile: () => null };
  const start = daemon.indexOf('function buildSeamlessAuthFile(');
  vm.runInNewContext(daemon.slice(start, daemon.indexOf('function scheduleOAuthStateCleanup', start)), context);
  const saveStart = daemon.indexOf('function saveSeamlessAccount(');
  vm.runInNewContext(daemon.slice(saveStart, daemon.indexOf('\n}', saveStart) + 2), context);
  const uid = accountIdentity({ uid: 'same-oauth', type: 'ultimate', enterpriseId: 'company' });
  const result = context.saveSeamlessAccount({ accessToken: 'fixture-only' }, { uid: 'same-oauth', type: 'ultimate', enterpriseId: 'company' });
  assert.equal(result.uid, uid);
  const stored = JSON.parse(fs.readFileSync(lib.backupPath(root, uid), 'utf8'));
  assert.equal(stored.account.uid, 'same-oauth');
  assert.equal(lib.listAccounts(root)[0].uid, uid);
});
