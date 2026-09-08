'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');
const begin = source.indexOf("  if (req.method === 'POST' && p === '/api/logout')");
const end = source.indexOf('  // /api/batch-claim', begin);
const route = new Function('req', 'p', 'res', 'resolveLogoutAuth', 'quitWorkBuddy', 'relaunchWorkBuddy', 'fs', 'log', 'json', source.slice(begin, end));
async function run(resolution, exists, quitError) {
  const actions = [];
  const result = await route({ method: 'POST' }, '/api/logout', {}, () => resolution,
    async () => { actions.push('quit'); if (quitError) throw new Error(quitError); },
    async () => { actions.push('relaunch'); },
    { existsSync: () => exists, unlinkSync: () => { actions.push('unlink'); exists = false; } },
    () => {}, (_, status, body) => ({ status, body }));
  return { actions, ...result };
}
test('logout retry with no file still restarts the login page without unlinking data', async () => {
  const result = await run({ file: '/fixture/auth.info', ambiguous: false }, false);
  assert.deepEqual(result.actions, ['quit', 'relaunch']);
  assert.equal(result.status, 200);
  assert.equal(result.body.relaunched, true);
});
test('logout refuses ambiguity and never deletes auth when stopping the host fails', async () => {
  for (const resolution of [{ file: null }, { file: '/fixture/auth.info', ambiguous: true }]) {
    const result = await run(resolution, true);
    assert.equal(result.status, 409);
    assert.deepEqual(result.actions, []);
  }
  const denied = await run({ file: '/fixture/auth.info' }, true, 'standard privilege required');
  assert.equal(denied.status, 502);
  assert.deepEqual(denied.actions, ['quit']);
  const success = await run({ file: '/fixture/auth.info' }, true);
  assert.deepEqual(success.actions, ['quit', 'unlink', 'relaunch']);
});
