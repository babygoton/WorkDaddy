'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');

function loadHelpers(sqliteQuery, sqliteRun, profile = { kind: 'workbuddy' }) {
  const start = source.indexOf('let sessionContextWindowState =');
  const end = source.indexOf('\n\n// This revision is the cheap fallback', start);
  assert.ok(start > 0 && end > start, 'session usage helpers must remain a contiguous unit');
  const context = { PROFILE: profile, sqliteQuery, sqliteRun, Number, String, Error, RegExp };
  vm.runInNewContext(
    source.slice(start, end) +
      '\nthis.helpers = { readSessionContextWindow, writeSessionContextWindow, copySessionUsage };',
    context
  );
  return context.helpers;
}

test('copies context window and usage details without requiring a duplicate target row', async () => {
  const queries = [];
  const writes = [];
  const helpers = loadHelpers(async (sql, params) => {
    queries.push({ sql, params });
    if (sql.includes('context_window')) return [{ context_window: '300000' }];
    if (sql.includes('FROM session_usage') && params[0] === 'source') {
      return [{ used: '123', size: '456', updated_at: '789', credit_json: '{"credit":1}' }];
    }
    return [];
  }, async (sql, params) => { writes.push({ sql, params }); });

  assert.equal(await helpers.readSessionContextWindow('source'), 300000);
  await helpers.writeSessionContextWindow('target', 300000);
  await helpers.copySessionUsage('source', 'target');

  assert.equal(writes.length, 2);
  assert.deepEqual(Array.from(writes[0].params), [300000, 'target']);
  assert.deepEqual(Array.from(writes[1].params), ['target', 123, 456, 789, '{"credit":1}']);
  assert.equal(queries.filter(item => item.sql.includes('session_usage')).length, 2);
});

test('disables optional session storage after an older schema reports a missing column/table', async () => {
  let writes = 0;
  const helpers = loadHelpers(async () => { throw new Error('no such column: context_window'); }, async () => { writes++; });
  assert.equal(await helpers.readSessionContextWindow('source'), null);
  await helpers.writeSessionContextWindow('target', 300000);
  assert.equal(writes, 0);

  const usage = loadHelpers(async () => { throw new Error('no such table: session_usage'); }, async () => { writes++; });
  await usage.copySessionUsage('source', 'target');
  await usage.copySessionUsage('source', 'target');
  assert.equal(writes, 0);
});

test('does not turn a missing context window into zero', async () => {
  const helpers = loadHelpers(async sql => {
    if (sql.includes('context_window')) return [{ context_window: '' }];
    return [];
  }, async () => { throw new Error('context window must stay absent'); });
  assert.equal(await helpers.readSessionContextWindow('source'), null);
  await helpers.writeSessionContextWindow('target', null);
});
