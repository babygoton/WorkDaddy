'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { normalizeTimestamp, shouldRefreshAccessToken } = require('../scripts/token-refresh');

// Exercise the real crypto helpers without obtaining a user's WorkBuddy key.
const fixtureKey = Buffer.alloc(32, 7);
function cryptoHarness() {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/lib.js'), 'utf8');
  const start = source.indexOf('function isWbEncryptedEnvelope(');
  const end = source.indexOf('// ===================== [wd-compat] 适配层结束', start);
  return vm.runInNewContext(source.slice(start, end) + '\n({wdCompatEncryptAuthJson, wdCompatDecryptAuthJson, wdCompatContainsEncryptedFields});', {
    crypto, Buffer, WD_COMPAT: { key: fixtureKey, decOk: 0, decFail: 0 },
    wdCompatLog() {},
  });
}

// Independent fixture matching the official field-envelope wire format.
function envelope(value) {
  const lp = (value) => {
    const bytes = Buffer.from(value);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    return Buffer.concat([length, bytes]);
  };
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', fixtureKey, nonce);
  cipher.setAAD(Buffer.concat([
    Buffer.from('WB-AAD\0'), Buffer.from([1]), lp('WBEV1'), lp('sym-v1'),
    Buffer.from([0, 0, 0, 1]), lp('fixture-key'), Buffer.from([2, 0, 0]),
  ]));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return { $wbEncrypted: 1, envelope: Buffer.from(JSON.stringify({
    suite: 1, keyId: 'fixture-key', nonce: nonce.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64'),
  })).toString('base64') };
}

function fixture() {
  return {
    account: { uid: 'fixture', nickname: envelope('private-nickname') },
    auth: { accessToken: envelope('old-access'), refreshToken: envelope('old-refresh'),
      expiresAt: Date.now() + 7 * 86400000, lastRefreshTime: Date.now() - 86400000 },
  };
}

test('refreshed credentials retain official encrypted envelopes for every protected field', () => {
  const compat = cryptoHarness();
  const stored = fixture();
  const root = compat.wdCompatDecryptAuthJson(structuredClone(stored));
  Object.assign(root.auth, { accessToken: 'new-access', refreshToken: 'new-refresh', idToken: 'new-id' });
  const encrypted = compat.wdCompatEncryptAuthJson(root, stored);
  for (const value of ['new-access', 'new-refresh', 'new-id', 'private-nickname']) {
    assert.equal(JSON.stringify(encrypted).includes(value), false);
  }
  assert.equal(encrypted.auth.idToken.$wbEncrypted, 1);
  const roundtrip = compat.wdCompatDecryptAuthJson(structuredClone(encrypted));
  assert.equal(roundtrip.auth.accessToken, 'new-access');
  assert.equal(roundtrip.auth.refreshToken, 'new-refresh');
  assert.equal(roundtrip.auth.idToken, 'new-id');
  assert.equal(roundtrip.account.nickname, 'private-nickname');
  assert.notEqual(encrypted.auth.accessToken.envelope, stored.auth.accessToken.envelope);
  const tampered = structuredClone(encrypted);
  const inner = JSON.parse(Buffer.from(tampered.auth.accessToken.envelope, 'base64'));
  inner.keyId = 'wrong-key';
  tampered.auth.accessToken.envelope = Buffer.from(JSON.stringify(inner)).toString('base64');
  assert.equal(compat.wdCompatDecryptAuthJson(tampered).auth.accessToken.$wbEncrypted, 1);
});

function daemonHarness(t, options = {}) {
  const compat = cryptoHarness();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-token-persistence-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'accounts'));
  const file = path.join(dir, 'accounts/fixture.info');
  fs.writeFileSync(file, JSON.stringify(options.plaintext
    ? compat.wdCompatDecryptAuthJson(fixture()) : fixture()), { mode: 0o600 });
  let requests = 0;
  let failWrite = false;
  const context = {
    ...compat, fs: { ...fs, writeFileSync(...args) {
      if (failWrite && String(args[0]).startsWith(file)) throw new Error('fixture write failure');
      return fs.writeFileSync(...args);
    } }, path, process, DATA_DIR: dir, PROFILE: { apiHost: 'https://fixture.invalid' },
    normalizeTokenTimestamp: normalizeTimestamp, shouldRefreshAccessToken,
    todayStr: (d = new Date()) => d.toISOString().slice(0, 10),
    accountBackupFile: () => file,
    listAccounts: () => {
      const auth = JSON.parse(fs.readFileSync(file)).auth;
      return [{ uid: 'fixture', tokenExpiresAt: auth.expiresAt, lastRefreshTime: auth.lastRefreshTime }];
    },
    redactDiagnosticText: () => 'redacted', log() {},
    refreshAuthToken: async (auth) => {
      requests++;
      await Promise.resolve();
      if (options.onRefresh) options.onRefresh(file);
      return { ok: true, auth: { ...auth, accessToken: 'new-access', refreshToken: 'new-refresh',
        lastRefreshTime: Date.now(), expiresAt: Date.now() + 28 * 86400000 } };
    },
  };
  const source = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');
  const start = source.indexOf('const backupAuthRuntimeCache = new Map()');
  const end = source.indexOf('/**\n * 打开账号面板时按日保活', start);
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return {
    dir, file, refresh: context.refreshAccountBackupToken,
    list: context.listAccountsWithRuntimeTokenCache,
    read: () => compat.wdCompatDecryptAuthJson(JSON.parse(fs.readFileSync(file))),
    restart() { vm.runInContext('backupAuthRuntimeCache.clear(); tokenRefreshState = null;', context); },
    counts: () => requests,
    failWrite(value) { failWrite = value; },
    signature: context.accountBackupSignature,
  };
}

test('encrypted refresh survives cache loss and same-day daily keepalive reads the saved credentials', async t => {
  const h = daemonHarness(t);
  const result = await h.refresh('fixture', { dailyKeepalive: true, force: true });
  assert.equal(result.persisted, true);
  assert.equal(h.read().auth.accessToken, 'new-access');
  assert.equal(fs.readFileSync(h.file, 'utf8').includes('new-access'), false);
  if (process.platform !== 'win32') assert.equal(fs.statSync(h.file).mode & 0o777, 0o600);
  h.restart();
  const next = await h.refresh('fixture', { dailyKeepalive: true, force: true });
  assert.equal(next.skipped, true);
  assert.equal(next.root.auth.refreshToken, 'new-refresh');
  assert.equal(h.counts(), 1);
});

test('legacy public refresh dates never suppress refresh or replace durable token expiry', async t => {
  const h = daemonHarness(t);
  const storedExpiry = h.read().auth.expiresAt;
  fs.writeFileSync(path.join(h.dir, 'token-refresh-state.json'), JSON.stringify({ accounts: { fixture: {
    signature: h.signature(h.file), lastRefreshTime: Date.now(), expiresAt: Date.now() + 28 * 86400000,
  } } }));
  assert.equal(h.list()[0].tokenExpiresAt, storedExpiry);
  assert.equal((await h.refresh('fixture', { dailyKeepalive: true, force: true })).persisted, true);
  assert.equal(h.counts(), 1);
});

test('overlapping panel and other refresh callers exchange a refresh token only once', async t => {
  const h = daemonHarness(t);
  await Promise.all([h.refresh('fixture', { force: true }), h.refresh('fixture', { dailyKeepalive: true })]);
  assert.equal(h.counts(), 1);
  assert.equal(h.read().auth.refreshToken, 'new-refresh');
});

test('failed persistence retains refreshed credentials and retries saving before another exchange', async t => {
  const h = daemonHarness(t);
  const original = fs.readFileSync(h.file, 'utf8');
  h.failWrite(true);
  const failed = await h.refresh('fixture', { force: true });
  assert.equal(failed.persisted, false);
  assert.ok(failed.error);
  assert.equal(fs.readFileSync(h.file, 'utf8'), original);
  h.failWrite(false);
  const retried = await h.refresh('fixture', { dailyKeepalive: true });
  assert.equal(retried.persisted, true);
  assert.equal(h.read().auth.refreshToken, 'new-refresh');
  assert.equal(h.counts(), 1);
});

test('a concurrent official login backup is preserved when refresh completes', async t => {
  let replacement;
  const h = daemonHarness(t, { onRefresh(file) {
    replacement = JSON.stringify({ account: { uid: 'fixture' }, auth: { accessToken: 'official-login', refreshToken: 'official-refresh' } });
    fs.writeFileSync(file, replacement);
  } });
  const result = await h.refresh('fixture', { force: true });
  assert.ok(result.error);
  assert.equal(fs.readFileSync(h.file, 'utf8'), replacement);
});

test('legacy plaintext backups still persist refreshed credentials', async t => {
  const h = daemonHarness(t, { plaintext: true });
  assert.equal((await h.refresh('fixture', { force: true })).persisted, true);
  assert.equal(h.read().auth.refreshToken, 'new-refresh');
});

test('unusable encryption templates stop before requesting a rotating refresh', async t => {
  const h = daemonHarness(t);
  const stored = JSON.parse(fs.readFileSync(h.file));
  const env = JSON.parse(Buffer.from(stored.auth.refreshToken.envelope, 'base64'));
  env.keyId = 'tampered-key';
  stored.auth.refreshToken.envelope = Buffer.from(JSON.stringify(env)).toString('base64');
  const source = JSON.stringify(stored);
  fs.writeFileSync(h.file, source);
  assert.ok((await h.refresh('fixture', { force: true })).error);
  assert.equal(h.counts(), 0);
  assert.equal(fs.readFileSync(h.file, 'utf8'), source);
});
