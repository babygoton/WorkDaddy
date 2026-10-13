'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const persona = require('../scripts/persona');
const daemon = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');
const routes = daemon.slice(daemon.indexOf("  if (req.method === 'GET' && p === '/api/persona')"), daemon.indexOf("  if (req.method === 'GET' && p === '/api/accounts')"));
function harness(t, profile = 'workbuddy-cn') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-persona-api-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, profile);
  fs.mkdirSync(path.join(dataRoot, 'user-b-personal'), { recursive: true });
  for (const file of ['IDENTITY.md', 'USER.md', 'SOUL.md', 'MEMORY.md']) fs.writeFileSync(path.join(dataRoot, file), 'fixture ' + file);
  fs.writeFileSync(path.join(dataRoot, 'user-b-personal/BOOTSTRAP.md'), 'fixture onboarding');
  let reloads = 0, locked = false;
  const context = vm.createContext({
    PROFILE: { kind: profile.startsWith('workbuddy') ? 'workbuddy' : 'codebuddy', dataRoot, capabilities: { accounts: true } },
    DATA_DIR: path.join(root, 'WorkDaddy'), URL, ...persona,
    currentAccount: () => ({ uid: 'b' }), listAccounts: () => [{ uid: 'a' }],
    assertAccountSwitchIdle: async () => { if (locked) throw new Error('busy'); locked = true; return () => { locked = false; }; },
    reloadWorkBuddyPage: async () => { reloads++; }, log: () => {}, readBody: req => Promise.resolve(req.body),
    json: (res, status, body) => ({ status, body }),
  });
  const run = vm.runInContext('(async function(req) { const res = {}; const url = new URL(req.url, "http://127.0.0.1"); const p = url.pathname; ' + routes + '})', context);
  return { dataRoot, context, run, reloads: () => reloads, locked: () => locked };
}
for (const profile of ['workbuddy-cn', 'workbuddy-ai']) test('persona API uses ' + profile + ' root, consent, backup and current-account CDP reload', async t => {
  const h = harness(t, profile);
  const get = await h.run({ method: 'GET', url: '/api/persona' });
  assert.equal(get.body.eligible, true);
  assert.equal(JSON.stringify(get).includes('fixture MEMORY'), false, 'private contents never leave the API');
  const body = { uid: 'b', sourceUid: 'legacy', revision: get.body.revision };
  assert.equal((await h.run({ method: 'POST', url: '/api/persona-copy', body })).status, 400);
  assert.equal(fs.existsSync(path.join(h.dataRoot, 'user-b-personal/MEMORY.md')), false);
  assert.equal(h.locked(), false);
  const copy = await h.run({ method: 'POST', url: '/api/persona-copy', body: { ...body, confirmed: true } });
  assert.equal(copy.status, 200);
  assert.equal(copy.body.reloaded, true);
  assert.equal(copy.body.backedUp, true);
  assert.equal(h.reloads(), 1);
  assert.equal(h.locked(), false);
  assert.equal((await h.run({ method: 'GET', url: '/api/persona' })).body.eligible, false);
});
test('repairing destination leaves current renderer alone until normal switch', async t => {
  const h = harness(t);
  h.context.currentAccount = () => ({ uid: 'a' });
  h.context.listAccounts = () => [{ uid: 'a' }, { uid: 'b' }];
  const preview = await h.run({ method: 'GET', url: '/api/persona?uid=b' });
  const result = await h.run({ method: 'POST', url: '/api/persona-copy', body: { uid: 'b', sourceUid: 'legacy', confirmed: true, revision: preview.body.revision } });
  assert.equal(result.body.reloaded, false);
  assert.equal(h.reloads(), 0);
});
test('reload failure reports saved repair without claiming successful refresh', async t => {
  const h = harness(t);
  h.context.reloadWorkBuddyPage = async () => { throw new Error('disconnected'); };
  const preview = await h.run({ method: 'GET', url: '/api/persona' });
  const result = await h.run({ method: 'POST', url: '/api/persona-copy', body: { uid: 'b', sourceUid: 'legacy', confirmed: true, revision: preview.body.revision } });
  assert.equal(result.status, 200);
  assert.equal(result.body.reloaded, false);
  assert.ok(result.body.hint.includes('下次刷新'));
});
test('unknown accounts and non-WorkBuddy profiles cannot copy', async t => {
  const h = harness(t);
  assert.equal((await h.run({ method: 'GET', url: '/api/persona?uid=unknown' })).status, 400);
  h.context.PROFILE.kind = 'codebuddy';
  assert.equal((await h.run({ method: 'GET', url: '/api/persona' })).body.status, 'unsupported');
  assert.equal((await h.run({ method: 'POST', url: '/api/persona-copy', body: { uid: 'b', confirmed: true } })).status, 400);
});
