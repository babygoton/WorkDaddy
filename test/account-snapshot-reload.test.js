'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');
const oldSnapshot = { version: 1, uid: 'old', nickname: '旧账号', type: 'enterprise', savedAt: 1, editionType: 'free', enterpriseId: 'old-company' };
function harness(options = {}) {
  const url = new URL('file:///app/renderer/index.html?locale=zh-CN&windowKind=main&extra=a%26b#chat');
  if (!options.noSnapshot) url.searchParams.set('accountSnapshot', encodeURIComponent(JSON.stringify(oldSnapshot)));
  const location = { href: url.href };
  const calls = [], logs = [];
  let armed = false, settled = false, profileReads = 0, initialAccount;
  let live = { uid: 'target', nickname: '新账号 % &', type: 'personal', editionType: 'experience', isPro: false, accessToken: 'synthetic-secret' };
  if (Object.hasOwn(options, 'profile')) live = options.profile;
  const renderer = { URL, location, history: { state: null, replaceState: (_state, _title, url) => {
    location.href = url;
  } }, wb: options.missingApi ? undefined : { account: { profile: async () => {
    profileReads++;
    if (options.profileThrows) throw new Error('synthetic-secret');
    return live;
  } } } };
  const boot = () => {
    // WorkBuddy index.html decodes once after URLSearchParams (Electron double encoding).
    const raw = new URL(location.href).searchParams.get('accountSnapshot');
    initialAccount = raw ? JSON.parse(decodeURIComponent(raw)) : null;
  };
  const ctx = {
    PROFILE: { kind: options.kind || 'workbuddy' }, cdp: { connected: true },
    setTimeout, clearTimeout, URL, log: line => logs.push(line),
    armPendingReloadInjection: () => { armed = true; return { ready: options.ready || Promise.resolve(true) }; },
    settlePendingReloadInjection: () => { settled = true; },
    cdpSend: async (method, params) => {
      calls.push({ method, params });
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
      if (method === 'Runtime.evaluate') {
        if (options.evaluateThrows && params.expression.includes('account.profile')) throw new Error('synthetic-secret');
        if (options.exceptionDetails && params.expression.includes('account.profile')) return { exceptionDetails: { text: 'synthetic-secret' } };
        if (options.clearThrows && params.expression.includes('replaceState')) throw new Error('synthetic-secret');
        return { result: { value: await vm.runInNewContext(params.expression, renderer) } };
      }
      assert.equal(armed, true, 'arm injection before navigation or reload');
      if (method === 'Page.navigate') {
        if (options.navigateThrows) throw new Error('synthetic-secret');
        if (options.navigateError) return { errorText: 'synthetic-secret' };
        location.href = params.url; boot(); return { frameId: 'main', loaderId: 'next' };
      }
      if (method === 'Page.reload') {
        if (options.reloadThrows) throw new Error('reload failed');
        boot(); return {};
      }
      throw new Error('unexpected CDP method: ' + method);
    },
  };
  const start = source.indexOf('async function reloadWorkBuddyPage(');
  vm.runInNewContext(source.slice(start, source.indexOf('\nconst WORKBUDDY_TARGET', start)), ctx);
  return { calls, logs, location, initial: () => initialAccount, settled: () => settled, reads: () => profileReads,
    run: (opts = {}) => ctx.reloadWorkBuddyPage({ account: opts.account === undefined ? { uid: 'target' } : opts.account, ...opts }) };
}

test('switch rebuilds the first-screen account from the matching live profile', async () => {
  const h = harness();
  assert.equal(await h.run(), true);
  assert.equal(h.initial().uid, 'target');
  assert.equal(h.initial().nickname, '新账号 % &');
  assert.equal(h.initial().type, 'personal');
  assert.equal(h.initial().version, 1);
  assert.equal(h.initial().editionType, 'experience');
  assert.equal(h.initial().isPro, false);
  assert.ok(h.initial().savedAt > 1);
  assert.equal(h.initial().enterpriseId, undefined, 'never inherit previous-account optional fields');
  assert.equal(h.initial().accessToken, undefined, 'copy only the official public snapshot fields');
  const next = new URL(h.location.href);
  assert.equal(next.searchParams.get('locale'), 'zh-CN');
  assert.equal(next.searchParams.get('windowKind'), 'main');
  assert.equal(next.searchParams.get('extra'), 'a&b');
  assert.equal(next.hash, '#chat');
  assert.deepEqual(h.calls.map(c => c.method).filter(m => m.startsWith('Page.') && m !== 'Page.getFrameTree'), ['Page.navigate']);
});

for (const options of [
  { missingApi: true }, { profile: null }, { profile: { uid: 'old', nickname: '旧账号', type: 'personal' } },
  { profileThrows: true }, { evaluateThrows: true }, { exceptionDetails: true },
  { navigateError: true }, { navigateThrows: true },
]) test('snapshot failure falls back to reload without leaking profile or CDP details: ' + JSON.stringify(options), async () => {
  const h = harness(options);
  assert.equal(await h.run(), true);
  assert.equal(h.calls.at(-1).method, 'Page.reload');
  assert.equal(h.initial(), null, 'fallback must not hydrate the previous account or its entitlement');
  const next = new URL(h.location.href);
  assert.equal(next.searchParams.get('extra'), 'a&b');
  assert.equal(next.hash, '#chat');
  assert.doesNotMatch(h.logs.join('\n'), /synthetic-secret|accountSnapshot=/);
});

test('failed snapshot cleanup refuses to reload the old account', async () => {
  const h = harness({ missingApi: true, clearThrows: true });
  await assert.rejects(h.run(), /清除.*账号快照/);
  assert.equal(h.calls.some(c => c.method === 'Page.reload'), false);
  assert.equal(h.settled(), true);
  assert.doesNotMatch(h.logs.join('\n'), /synthetic-secret/);
});

for (const options of [{ kind: 'codebuddy' }]) test('clients without the WorkBuddy snapshot contract keep normal reload: ' + JSON.stringify(options), async () => {
  const h = harness(options);
  await h.run();
  assert.equal(h.calls.at(-1).method, 'Page.reload');
  assert.equal(h.reads(), 0);
});

test('ordinary reload does not rewrite the account URL', async () => {
  const h = harness();
  await h.run({ account: null });
  assert.equal(h.initial().uid, 'old');
  assert.equal(h.reads(), 0);
});

test('manual switch returns without waiting for injection; automation still waits', async () => {
  const pending = new Promise(() => {});
  assert.equal(await harness({ ready: pending }).run({ waitForInjection: false }), true);
  let finish, done = false;
  const h = harness({ ready: new Promise(resolve => { finish = resolve; }) });
  const run = h.run().then(() => { done = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(done, false);
  finish(true); await run;
  assert.equal(done, true);
});

test('failed fallback releases the pending injection', async () => {
  const h = harness({ navigateError: true, reloadThrows: true });
  await assert.rejects(h.run(), /reload failed/);
  assert.equal(h.settled(), true);
});
