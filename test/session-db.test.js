'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const {
  bindCliSql,
  createSessionDb,
  normalizeSessionIdBatch,
} = require('../scripts/session-db.js');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-session-db-'));
  return { dir, file: path.join(dir, 'sessions.db') };
}

function generatedTextCorpus() {
  const alphabet = ['a', 'Z', '0', "'", '"', '`', '[', ']', '?', '-', '/', '*', '|', '\n', '\r', '\t', '雪', '🙂'];
  const values = ['', "'", '??', '-- comment', '/* block */', '雪🙂tail'];
  let state = 0x5eed1234;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  for (let sample = 0; sample < 128; sample++) {
    const length = next() % 65;
    let value = '';
    for (let i = 0; i < length; i++) value += alphabet[next() % alphabet.length];
    values.push(value);
  }
  return values;
}

async function exerciseRoundTrip(adapter) {
  await adapter.run('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, owner TEXT, enabled INTEGER)');
  const title = "left|right\n'); DELETE FROM sessions; --";
  await adapter.run('INSERT INTO sessions (id, title, owner, enabled) VALUES (?, ?, ?, ?)', ['session-1', title, null, true]);

  const rows = await adapter.all('SELECT id, title, owner, enabled FROM sessions WHERE id = ?', ['session-1']);
  assert.deepEqual(rows, [{ id: 'session-1', title, owner: null, enabled: 1 }]);
  assert.equal((await adapter.all('SELECT COUNT(*) AS count FROM sessions'))[0].count, 1);

  await assert.rejects(adapter.all('DELETE FROM sessions'), /sqlite|readonly|只读|write/i);
  assert.equal((await adapter.all('SELECT COUNT(*) AS count FROM sessions'))[0].count, 1);
  await assert.rejects(adapter.run('INSERT INTO sessions (id, title) VALUES (?, ?)', ['bad-undefined', undefined]), /参数类型|undefined/);
  await assert.rejects(adapter.run('INSERT INTO sessions (id, title) VALUES (?, ?)', ['bad-nan', Number.NaN]), /参数类型|number/);
  await assert.rejects(adapter.run('INSERT INTO sessions (id, title) VALUES (?, ?)', ['bad-bigint', 2n ** 100n]), /安全整数|safe integer/i);
  await assert.rejects(adapter.run('INSERT INTO sessions (id, title) VALUES (?, ?)', ['bad-nul', 'left\0right']), /NUL/);

  await assert.rejects(
    adapter.all('SELECT id FROM sessions WHERE id = ? AND title = ?', ['session-1']),
    /参数数量不匹配/
  );

  const corpus = generatedTextCorpus();
  await adapter.run('CREATE TABLE text_corpus (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
  await adapter.transaction(corpus.map((value, index) => ({
    sql: 'INSERT INTO text_corpus (id, value) VALUES (?, ?)',
    params: [`sample-${String(index).padStart(3, '0')}`, value],
  })));
  assert.deepEqual(
    await adapter.all('SELECT id, value FROM text_corpus ORDER BY id'),
    corpus.map((value, index) => ({ id: `sample-${String(index).padStart(3, '0')}`, value }))
  );
}

async function exerciseRollback(adapter) {
  await adapter.run('CREATE TABLE tx_items (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
  await assert.rejects(
    adapter.transaction([
      { sql: 'INSERT INTO tx_items (id, value) VALUES (?, ?)', params: ['same-id', 'first'] },
      { sql: 'INSERT INTO tx_items (id, value) VALUES (?, ?)', params: ['same-id', 'second'] },
    ]),
    /sqlite/i
  );
  assert.deepEqual(await adapter.all('SELECT id, value FROM tx_items'), []);
}

async function exerciseSingleStatementTransaction(adapter) {
  await adapter.run('CREATE TABLE tx_escape (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
  await adapter.transaction([
    { sql: "INSERT INTO tx_escape (id, value) VALUES (?, 'quoted;value'); /* trailing; comment */", params: ['allowed'] },
    { sql: 'INSERT INTO tx_escape (id, value) VALUES (?, ?) -- line; comment\n', params: ['allowed-line', 'line'] },
    { sql: 'INSERT INTO tx_escape (id, value) VALUES (?, ?) -- trailing comment without newline', params: ['allowed-line-eof', 'line-eof'] },
    { sql: "INSERT INTO tx_escape (id, value) VALUES (?, 'line one\n.print is literal')", params: ['allowed-dot-literal'] },
  ]);
  assert.deepEqual(await adapter.all('SELECT id, value FROM tx_escape ORDER BY id'), [
    { id: 'allowed', value: 'quoted;value' },
    { id: 'allowed-dot-literal', value: 'line one\n.print is literal' },
    { id: 'allowed-line', value: 'line' },
    { id: 'allowed-line-eof', value: 'line-eof' },
  ]);
  await adapter.run('DELETE FROM tx_escape');

  await assert.rejects(
    adapter.transaction([
      { sql: 'INSERT INTO tx_escape (id, value) VALUES (?, ?); COMMIT; -- escape rollback', params: ['escaped', 'first'] },
      { sql: 'INSERT INTO tx_escape (id, value) VALUES (?, ?)', params: ['escaped', 'duplicate'] },
    ]),
    /单条|single statement/i
  );
  assert.deepEqual(await adapter.all('SELECT id, value FROM tx_escape'), []);

  await assert.rejects(
    adapter.transaction([
      { sql: 'INSERT INTO tx_escape (id, value) VALUES (?, ?)', params: ['before-commit', 'first'] },
      { sql: ' /* leading comment */ CoMmIt ; -- transaction escape' },
      { sql: 'INSERT INTO missing_table (id) VALUES (?)', params: ['boom'] },
    ]),
    /事务控制|transaction control/i
  );
  assert.deepEqual(await adapter.all('SELECT id, value FROM tx_escape'), []);

  await assert.rejects(
    adapter.transaction([
      { sql: 'INSERT INTO tx_escape (id, value) VALUES (?, ?)', params: ['before-rollback', 'first'] },
      { sql: '\n-- leading comment\nRoLlBaCk;' },
      { sql: 'INSERT INTO tx_escape (id, value) VALUES (?, ?)', params: ['after-rollback', 'autocommit'] },
    ]),
    /事务控制|transaction control/i
  );
  assert.deepEqual(await adapter.all('SELECT id, value FROM tx_escape'), []);

  await assert.rejects(
    adapter.transaction([{ sql: '.print sqlite-cli-meta-command-must-not-run' }]),
    /meta|点命令|dot command/i
  );
  await assert.rejects(adapter.run('.print sqlite-cli-meta-command-must-not-run'), /meta|点命令|dot command/i);
  await assert.rejects(adapter.all('.print sqlite-cli-meta-command-must-not-run'), /meta|点命令|dot command/i);
  await assert.rejects(adapter.run('\ufeff  .print sqlite-cli-meta-command-must-not-run'), /meta|点命令|dot command/i);
}

async function exerciseNumericBoundaries(adapter) {
  await adapter.run('CREATE TABLE numeric_values (id TEXT PRIMARY KEY, value)');
  await adapter.transaction([
    { sql: 'INSERT INTO numeric_values (id, value) VALUES (?, ?)', params: ['max-number', Number.MAX_SAFE_INTEGER] },
    { sql: 'INSERT INTO numeric_values (id, value) VALUES (?, ?)', params: ['min-bigint', BigInt(Number.MIN_SAFE_INTEGER)] },
    { sql: 'INSERT INTO numeric_values (id, value) VALUES (?, ?)', params: ['float', 1.25] },
    { sql: 'INSERT INTO numeric_values (id, value) VALUES (?, ?)', params: ['null', null] },
    { sql: 'INSERT INTO numeric_values (id, value) VALUES (?, ?)', params: ['text', '42'] },
    { sql: 'INSERT INTO numeric_values (id, value) VALUES (?, ?)', params: ['bool', true] },
  ]);
  assert.deepEqual(await adapter.all('SELECT id, value FROM numeric_values ORDER BY id'), [
    { id: 'bool', value: 1 },
    { id: 'float', value: 1.25 },
    { id: 'max-number', value: Number.MAX_SAFE_INTEGER },
    { id: 'min-bigint', value: Number.MIN_SAFE_INTEGER },
    { id: 'null', value: null },
    { id: 'text', value: '42' },
  ]);
  for (const value of [
    Number.MAX_SAFE_INTEGER + 1,
    Number.MIN_SAFE_INTEGER - 1,
    BigInt(Number.MAX_SAFE_INTEGER) + 1n,
    BigInt(Number.MIN_SAFE_INTEGER) - 1n,
  ]) {
    await assert.rejects(
      adapter.run('INSERT INTO numeric_values (id, value) VALUES (?, ?)', [`unsafe-${String(value)}`, value]),
      /安全整数|safe integer/i
    );
  }
}

test('node:sqlite adapter preserves structured values and rolls back a failed transaction', async (t) => {
  const tmp = tempDb();
  try {
    const adapter = createSessionDb({ dbPath: tmp.file });
    if (adapter.backend !== 'node:sqlite') {
      t.skip('node:sqlite is unavailable; CLI fallback is covered below');
      return;
    }
    assert.equal(adapter.backend, 'node:sqlite');
    await exerciseRoundTrip(adapter);
    await exerciseRollback(adapter);
    await exerciseSingleStatementTransaction(adapter);
    await exerciseNumericBoundaries(adapter);
  } finally {
    fs.rmSync(tmp.dir, { recursive: true, force: true });
  }
});

test('sqlite3 CLI fallback preserves structured values and rolls back a failed transaction', async (t) => {
  const sqliteCommand = process.env.WORKDADDY_SQLITE3 || 'sqlite3';
  const probe = spawnSync(sqliteCommand, ['--version'], { encoding: 'utf8', windowsHide: true });
  if (probe.error || probe.status !== 0) {
    if (process.env.WORKDADDY_SQLITE3) {
      assert.fail(`WORKDADDY_SQLITE3 is unavailable: ${probe.error ? probe.error.message : probe.stderr}`);
    }
    t.skip('sqlite3 CLI not found on PATH');
    return;
  }

  const tmp = tempDb();
  try {
    const adapter = createSessionDb({ dbPath: tmp.file, disableNodeSqlite: true, sqliteCommand });
    assert.equal(adapter.backend, 'sqlite3-cli');
    await exerciseRoundTrip(adapter);
    await exerciseRollback(adapter);
    await exerciseSingleStatementTransaction(adapter);
    await exerciseNumericBoundaries(adapter);

    const longText = "雪|'\n".repeat(12000);
    assert.ok(bindCliSql('INSERT INTO long_values (id, value) VALUES (?, ?)', ['long-1', longText]).length > 32767);
    await adapter.run('CREATE TABLE long_values (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
    await adapter.run('INSERT INTO long_values (id, value) VALUES (?, ?)', ['long-1', longText]);
    assert.deepEqual(await adapter.all('SELECT value FROM long_values WHERE id = ?', ['long-1']), [{ value: longText }]);
  } finally {
    fs.rmSync(tmp.dir, { recursive: true, force: true });
  }
});

test('CLI fallback encodes text as UTF-8 hex and fails clearly without -json support', async () => {
  const compiled = bindCliSql("SELECT ?, ?, ?, '?' /* ? */", ['雪|\nquote\'', 42, null]);
  assert.match(compiled, /CAST\(X'[0-9a-f]+' AS TEXT\)/i);
  assert.doesNotMatch(compiled, /雪|quote/);
  assert.match(compiled, /SELECT CAST\(X'/);
  assert.match(compiled, /, 42, NULL, '\?' \/\* \? \*\//);

  const adapter = createSessionDb({
    dbPath: path.join(os.tmpdir(), 'unused-workdaddy-session.db'),
    disableNodeSqlite: true,
    sqliteCommand: process.execPath,
  });
  await assert.rejects(adapter.all('SELECT 1'), /不支持 -json/);
});

test('session ID batches validate raw input, cap work, and deduplicate in order', () => {
  assert.deepEqual(normalizeSessionIdBatch(['a', 'a', 'b', 'a', 'c']), ['a', 'b', 'c']);
  assert.throws(() => normalizeSessionIdBatch(null), /数组/);
  assert.throws(() => normalizeSessionIdBatch(['valid', 7]), /非空字符串/);
  assert.throws(() => normalizeSessionIdBatch(['']), /非空字符串/);
  assert.throws(() => normalizeSessionIdBatch(['x'.repeat(201)]), /200|过长/);
  assert.throws(() => normalizeSessionIdBatch(Array(500).fill('same')), /100|上限|过多/);
  assert.throws(
    () => normalizeSessionIdBatch(Array.from({ length: 101 }, (_, index) => `session-${index}`)),
    /100|上限|过多/
  );
});

test('session ID batches can opt out of the cap for deletion-style operations', () => {
  const ids = Array.from({ length: 101 }, (_, index) => `session-${index}`);
  assert.deepEqual(normalizeSessionIdBatch(ids, { maxBatch: null }), ids);
});

test('daemon session SQL uses bound parameters without delimiter serialization', () => {
  const daemon = fs.readFileSync(path.join(repoRoot, 'scripts', 'daemon.js'), 'utf8');
  const verifyWin = fs.readFileSync(path.join(repoRoot, 'scripts', 'verify-win.cmd'), 'utf8');
  const macBuild = fs.readFileSync(path.join(repoRoot, 'scripts', 'build-mac-dmg.sh'), 'utf8');
  assert.doesNotMatch(daemon, /Object\.values\([^\n]+join\(['"]\|['"]\)/);
  assert.doesNotMatch(daemon, /function sqlQuote\(/);
  assert.doesNotMatch(daemon, /id IN \(['"]?\s*\+\s*esc/);
  assert.match(daemon, /createSessionDb/);
  assert.equal((daemon.match(/normalizeSessionIdBatch\(body\s*&&\s*body\.ids\)/g) || []).length, 3);
  assert.match(daemon, /normalizeSessionIdBatch\(body\s*&&\s*body\.ids,\s*\{\s*maxBatch:\s*null\s*\}\)/);
  assert.ok((daemon.match(/catch \(e\) \{ return json\(res, 400, \{ ok: false, error: e\.message \}\); \}/g) || []).length >= 4);
  assert.doesNotMatch(daemon, /body\.ids\.filter\(/);
  assert.match(daemon, /sqliteQuery\([^,]+,\s*\[[^\]]/s);
  assert.match(verifyWin, /daemon\.js session-db\.js secure-transfer\.js lib\.js/);
  const copyList = (macBuild.match(/for f in ([^;]+); do/) || [])[1] || '';
  assert.match(copyList, /(?:^|\s)session-db\.js(?:\s|$)/);
  assert.match(copyList, /(?:^|\s)secure-transfer\.js(?:\s|$)/);
  assert.match(copyList, /(?:^|\s)windows-process-boundary\.js(?:\s|$)/);
  assert.match(macBuild, /chmod 644[\s\S]*session-db\.js/);
  assert.match(macBuild, /chmod 644[\s\S]*secure-transfer\.js/);
  assert.match(macBuild, /chmod 644[\s\S]*windows-process-boundary\.js/);
});
