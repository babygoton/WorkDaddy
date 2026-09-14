'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const transfer = require('../scripts/secure-transfer.js');
const { scanTokenStats, scanTokenStatsCached, tokenStatsCacheReady } = require('../scripts/token-stats.js');

const now = Date.parse('2026-09-14T12:00:00+08:00');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-token-import-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessionAccounts = { source: 'account-A', copy: 'account-B', other: 'account-C' };
  const options = { now, days: 7, sessionAccounts };
  const file = id => path.join(root, 'projects', 'fixture', id + '.jsonl');
  function write(id, rows) {
    fs.mkdirSync(path.dirname(file(id)), { recursive: true });
    fs.writeFileSync(file(id), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  }
  const row = { uuid: 'message-1', requestId: 'request-1', sessionId: 'source',
    timestamp: '2026-09-13T12:00:00+08:00', model: 'model-a',
    message: { content: 'PRIVATE-FIXTURE-CONTENT', usage: {
      input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 80, cache_creation_input_tokens: 5,
    } } };
  return { root, file, write, row, options, sessionAccounts };
}

// Execute the actual encrypted import / file restore / SQL construction / copy
// functions. Only database execution is replaced with an in-memory owner map;
// no running daemon, real account, model request or renderer is involved.
function transferHelpers(root, sessionAccounts) {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');
  const context = { fs, path, crypto, Buffer, ...transfer, PROFILE: { dataRoot: root },
    MAX_SESSION_ID_LENGTH: 200, log: () => {}, currentAccount: () => ({ uid: 'account-A' }),
    sqliteRun: async (sql, values) => { sessionAccounts[values[0]] = values[2]; },
    deleteSessionFiles: () => { throw new Error('Unexpected import rollback'); } };
  function load(start, end, suffix = '') {
    const a = source.indexOf(start), b = source.indexOf(end, a);
    assert.ok(a >= 0 && b > a, start);
    vm.runInNewContext(source.slice(a, b) + suffix, context);
  }
  load('function isValidSessionId(', '\n}\n', '\n}');
  load('const MAX_SESSION_EXPORT_FILES', '\nfunction collectSessionArchiveFiles(');
  load('function ensureArchiveParentNoFollow(', '\nasync function copySessionRecord(');
  load('async function copySessionFiles(', '\nfunction sessionContentMtime(');
  return context;
}

test('repeated encrypted imports and account copies never multiply historical usage', async t => {
  const f = fixture(t), helpers = transferHelpers(f.root, f.sessionAccounts);
  f.write('source', [f.row]);
  const original = fs.readFileSync(f.file('source'));
  const content = transfer.createEncryptedExport('sessions', {
    exportType: 'WorkDaddy-sessions', version: 1, sessions: [{
      record: { id: 'source', user_id: 'account-A' },
      files: [{ path: 'projects/fixture/source.jsonl', data: original.toString('base64') }],
    }],
  }, 'fixture-password');
  const baseline = scanTokenStatsCached(f.root, f.options);
  const importedIds = [];
  for (let n = 0; n < 3; n++) {
    const result = await helpers.importSessions(content, 'fixture-password', 'account-B');
    assert.equal(result.failed, 0);
    importedIds.push(result.imported[0].id);
    assert.deepEqual(scanTokenStatsCached(f.root, f.options).totals, baseline.totals);
  }
  await helpers.copySessionFiles(f.root, 'source', 'copy');
  for (const scan of [scanTokenStats, scanTokenStatsCached]) {
    const result = scan(f.root, f.options);
    assert.deepEqual(result.totals, baseline.totals);
    assert.equal(scan(f.root, { ...f.options, account: 'account-A' }).totals.input, 100);
    assert.equal(scan(f.root, { ...f.options, account: 'account-B' }).totals.calls, 0);
  }
  for (const id of ['source', 'copy', ...importedIds]) assert.deepEqual(fs.readFileSync(f.file(id)), original);
});

test('continued conversations count new calls once under the account that made them', t => {
  const f = fixture(t);
  f.write('source', [f.row]);
  f.write('copy', [f.row]);
  scanTokenStatsCached(f.root, f.options);
  const next = { ...f.row, uuid: 'message-2', sessionId: 'copy', timestamp: now - 1000, model: 'model-b' };
  f.write('copy', [f.row, next]);
  f.write('other', [f.row, next]);
  for (const scan of [scanTokenStats, scanTokenStatsCached]) {
    assert.equal(scan(f.root, f.options).totals.input, 200);
    assert.equal(scan(f.root, { ...f.options, account: 'account-B' }).totals.input, 100);
    assert.equal(scan(f.root, { ...f.options, account: 'account-C' }).totals.input, 0);
    assert.equal(scan(f.root, { ...f.options, model: 'model-b', days: 1 }).totals.calls, 1);
    assert.equal(scan(f.root, { ...f.options, days: 1 }).totals.calls, 1);
  }
});

test('equal token values and shared request IDs do not merge distinct real records', t => {
  const f = fixture(t);
  const rows = [f.row, { ...f.row, uuid: 'message-2' }, { ...f.row, type: 'function_call' },
    { ...f.row, message: { ...f.row.message, content: 'different output' } }];
  f.write('source', rows);
  f.write('copy', rows);
  for (const scan of [scanTokenStats, scanTokenStatsCached]) assert.equal(scan(f.root, f.options).totals.calls, 4);
});

test('legacy rows without IDs and repeated identical rows within one file retain multiplicity', t => {
  const f = fixture(t);
  const row = { timestamp: f.row.timestamp, usage: { input_tokens: 7 }, message: 'legacy fixture' };
  f.write('source', [row, row]);
  f.write('copy', [row, row]);
  for (const scan of [scanTokenStats, scanTokenStatsCached]) {
    assert.equal(scan(f.root, f.options).totals.input, 14);
    assert.equal(scan(f.root, f.options).totals.calls, 2);
    assert.equal(scan(f.root, f.options).accounts.length, 0, 'conflicting owners without provenance stay unattributed');
  }
});

test('source deletion, changed copies and cache rebuilds retain only surviving distinct usage', t => {
  const f = fixture(t);
  f.write('source', [f.row]); f.write('copy', [f.row]);
  assert.equal(scanTokenStatsCached(f.root, f.options).totals.calls, 1);
  fs.unlinkSync(f.file('source'));
  delete f.sessionAccounts.source;
  const result = scanTokenStatsCached(f.root, f.options);
  assert.equal(result.totals.calls, 1);
  assert.equal(result.accounts.length, 0, 'missing original owner is not charged to the copy owner');
  f.write('copy', [{ ...f.row, uuid: 'new-message', sessionId: 'copy' }]);
  assert.equal(scanTokenStatsCached(f.root, f.options).totals.calls, 1);
  fs.unlinkSync(path.join(f.root, '.workdaddy-token-stats-cache.json'));
  assert.equal(scanTokenStatsCached(f.root, f.options).totals.calls, 1);
  fs.unlinkSync(f.file('copy'));
  assert.equal(scanTokenStatsCached(f.root, f.options).totals.calls, 0);
});

test('cached ownership changes resolve without rereading unchanged message files', t => {
  const f = fixture(t);
  f.write('source', [f.row]); f.write('copy', [f.row]);
  scanTokenStatsCached(f.root, f.options);
  const read = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function(file, ...args) { if (String(file).endsWith('.jsonl')) reads++; return read.call(this, file, ...args); };
  t.after(() => { fs.readFileSync = read; });
  f.sessionAccounts.source = 'account-D';
  for (const days of [1, 7, 30, 90]) scanTokenStatsCached(f.root, { ...f.options, days });
  const result = scanTokenStatsCached(f.root, { ...f.options, account: 'account-D' });
  assert.equal(result.totals.input, 100);
  assert.equal(reads, 0);
});

test('old inflated cache is invalidated and cache contains no message content', t => {
  const f = fixture(t);
  f.write('source', [f.row]); f.write('copy', [f.row]);
  scanTokenStatsCached(f.root, f.options);
  const file = path.join(f.root, '.workdaddy-token-stats-cache.json');
  const cache = JSON.parse(fs.readFileSync(file, 'utf8'));
  cache.version = 7;
  fs.writeFileSync(file, JSON.stringify(cache));
  assert.equal(tokenStatsCacheReady(f.root, f.options), false);
  const result = scanTokenStatsCached(f.root, f.options);
  assert.equal(result.cacheHit, false);
  assert.equal(result.totals.calls, 1);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /PRIVATE-FIXTURE-CONTENT|message-1|request-1/);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-FIXTURE-CONTENT|message-1|request-1/);
});

test('explicit account metadata wins, snapshots and subagent copies remain excluded', t => {
  const f = fixture(t);
  f.write('copy', [{ ...f.row, accountUid: 'account-original' }, { ...f.row, isSnapshotUpdate: true }]);
  fs.mkdirSync(path.join(f.root, 'projects', 'fixture', 'subagents'));
  fs.writeFileSync(path.join(f.root, 'projects', 'fixture', 'subagents', 'duplicate.jsonl'), JSON.stringify(f.row));
  for (const scan of [scanTokenStats, scanTokenStatsCached]) {
    const result = scan(f.root, f.options);
    assert.equal(result.totals.calls, 1);
    assert.equal(result.accounts[0].account, 'account-original');
  }
});

test('AI providerData usage copies preserve all counters and newly appended calls', t => {
  const f = fixture(t);
  const row = { id: 'ai-1', conversationId: 'source', timestamp: now - 1000, type: 'function_call',
    providerData: { model: 'ai-model', usage: { inputTokens: 42, outputTokens: 7, cacheReadTokens: 20, cacheWriteTokens: 3 } } };
  f.write('source', [row]); f.write('copy', [row]);
  for (const scan of [scanTokenStats, scanTokenStatsCached]) {
    assert.deepEqual(scan(f.root, f.options).totals, { input: 42, output: 7, cacheRead: 20, cacheWrite: 3, calls: 1 });
  }
  f.write('copy', [row, { ...row, id: 'ai-2', conversationId: 'copy' }]);
  for (const scan of [scanTokenStats, scanTokenStatsCached]) {
    assert.equal(scan(f.root, f.options).totals.calls, 2);
    assert.equal(scan(f.root, { ...f.options, account: 'account-B' }).totals.input, 42);
  }
});

test('importing an undated legacy row does not move its cached usage to today', t => {
  const f = fixture(t), row = { uuid: 'undated', usage: { input_tokens: 8 } };
  f.write('source', [row]);
  const first = scanTokenStatsCached(f.root, { ...f.options, now: now - 86400000 });
  f.write('copy', [row]);
  const later = scanTokenStatsCached(f.root, f.options);
  assert.equal(later.totals.input, 8);
  assert.deepEqual(later.daily, first.daily);
  assert.equal(scanTokenStatsCached(f.root, { ...f.options, days: 1 }).totals.calls, 0);
});
