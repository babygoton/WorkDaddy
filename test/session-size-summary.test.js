'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../scripts/daemon.js'), 'utf8');
async function query(range, sizes) {
  const rows = [{ id: 'old', user_id: 'owner', created_at: 10 }, { id: 'new', user_id: 'owner', created_at: 200 }];
  const ctx = vm.createContext({
    req: { method: 'GET' }, p: '/api/sessions', url: new URL('http://localhost/api/sessions?range=' + range), res: {}, DATA_DIR: '', PROFILE: { dataRoot: '' },
    normalizeAutoCopyLineages() {}, currentAccount: () => ({ uid: 'owner' }), sessionRangeMs: r => r === 'all' ? 0 : 100,
    sqliteQuery: async (sql, params) => { assert.ok(params.includes('owner')); return sql.includes('>= ?') ? rows.slice(1) : rows; },
    getAutoCopyRules: () => ({ sessionIds: [], workspaces: [], allLineages: {} }), canonicalWorkspace: String,
    dedupeAutoCopySessionRows: rows => rows,
    sessionSync: { readSessionSizes: async () => new Map(sizes) }, json: (_, status, body) => { assert.equal(status, 200); return body; },
  });
  const start = source.indexOf("  if (req.method === 'GET' && p === '/api/sessions')");
  return vm.runInContext('(async () => {' + source.slice(start, source.indexOf('  // 会话空间列表', start)) + '})()', ctx);
}
test('account total includes all sessions even when the time filter hides old sessions', async () => {
  const result = await query('today', [['old', 1000], ['new', 2000]]);
  assert.deepEqual(Array.from(result.sessions, s => s.id), ['new']);
  assert.equal(result.totalBytes, 3000);
  assert.equal((await query('all', [['old', 1000], ['new', 2000]])).totalBytes, 3000);
});
test('an unreadable session cannot silently understate the account total', async () => {
  assert.equal((await query('today', [['old', null], ['new', 2000]])).totalBytes, null);
});
