'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const compat = require('../scripts/workbuddy-compat.js');
const lib = require('../scripts/lib.js');

function visibleElement(className) {
  return {
    className: className || '',
    children: [],
    getBoundingClientRect() { return { width: 120, height: 32, left: 20 }; },
  };
}

test('composer toolbar selection prefers the modern DOM and falls back to legacy DOM', () => {
  const modern = visibleElement('cr-input-toolbar__right');
  const legacy = visibleElement('_item_hash _gapLarge_hash');
  const modernDocument = {
    querySelector(selector) { return selector === 'div.cr-input-toolbar__right' ? modern : null; },
    querySelectorAll() { return [legacy]; },
  };
  assert.deepEqual(compat.findComposerToolbar(modernDocument), { kind: 'modern', element: modern });

  const legacyDocument = {
    querySelector() { return null; },
    querySelectorAll() { return [legacy]; },
  };
  assert.deepEqual(compat.findComposerToolbar(legacyDocument), { kind: 'legacy', element: legacy });
});

test('queue adapter selection prefers prototype-capable modern adapter and retains legacy fallback', () => {
  const modernAdapter = Object.create({
    enqueueConversationMessageQueueItem() {},
    pauseConversationMessageQueue() {},
  });
  const modernRoot = visibleElement();
  modernRoot.__reactFiber$test = { memoizedProps: { adapter: modernAdapter }, return: null };
  const modernDocument = {
    querySelector(selector) { return selector === '#root > div' ? modernRoot : null; },
  };
  assert.deepEqual(compat.findQueueAdapter(modernDocument), { kind: 'modern', adapter: modernAdapter });

  const legacyAdapter = {
    enqueueConversationMessageQueueItem() {},
    pauseConversationMessageQueue() {},
  };
  const legacyRoot = visibleElement();
  legacyRoot.__reactFiber$test = { memoizedProps: { value: legacyAdapter }, return: null };
  const legacyDocument = {
    querySelector(selector) { return selector === '.voice-mic-wrap' ? legacyRoot : null; },
  };
  assert.deepEqual(compat.findQueueAdapter(legacyDocument), { kind: 'legacy', adapter: legacyAdapter });
});

test('conversation activation exposes the official session lookup and jump event', async () => {
  const emitted = [];
  const modernAdapter = Object.create({
    enqueueConversationMessageQueueItem() {},
    pauseConversationMessageQueue() {},
    emit(name, payload) { emitted.push({ name, payload }); },
  });
  modernAdapter.sessionsResource = {
    on() {}, off() {},
    getByIds(ids) { return Promise.resolve({ conversations: ids.map(id => ({ id })), missingIds: [] }); },
  };
  const modernRoot = visibleElement();
  modernRoot.__reactFiber$test = { memoizedProps: { adapter: modernAdapter }, return: null };
  const documentLike = { querySelector(selector) { return selector === '#root > div' ? modernRoot : null; } };

  const activation = compat.findConversationActivationApi(documentLike);
  assert.ok(activation);
  assert.equal(await activation.hasSession('copied-session'), true);
  activation.activate('copied-session');
  assert.deepEqual(emitted, [{
    name: 'jump-to-conversation',
    payload: { source: 'tencent-docs', sessionId: 'copied-session', reason: 'already-active' },
  }]);
});

test('conversation activation prefers the official React navigation handler', async () => {
  const calls = [];
  const navigate = async function handleConversationClick(id, cwd, skipLocalCheck, preserveListView, options) {
    // The markers mirror WorkBuddy's current handler without depending on its
    // minified component names.
    function dismissHoverPeek() {}
    function syncTaskRouteFromClick() {}
    dismissHoverPeek();
    syncTaskRouteFromClick();
    calls.push([id, cwd, skipLocalCheck, preserveListView, options]);
  };
  const adapter = {
    enqueueConversationMessageQueueItem() {},
    pauseConversationMessageQueue() {},
    emit() { throw new Error('legacy activation must not be used'); },
  };
  const root = visibleElement();
  root.__reactFiber$test = {
    memoizedProps: {},
    memoizedState: { memoizedState: { current: navigate }, next: null },
    return: null,
  };
  const documentLike = {
    querySelector(selector) { return selector === '#root > div' ? root : null; },
  };
  const activation = compat.findConversationActivationApi(documentLike);
  assert.ok(activation);
  assert.equal(activation.activate('official-session'), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [['official-session', '', false, false, {}]]);
});

test('selected conversation lookup is capability based rather than profile based', () => {
  const selected = {
    className: 'conversation-item',
    firstElementChild: { className: '_card_hash _selected_hash' },
    getAttribute(name) { return name === 'data-conversation-id' ? 'conversation-modern' : null; },
  };
  const documentLike = {
    querySelectorAll(selector) {
      return selector === '.conversation-item[data-conversation-id]' ? [selected] : [];
    },
    querySelector() { return null; },
  };
  assert.equal(compat.getSelectedConversationId(documentLike), 'conversation-modern');
});

test('account import accepts legacy plaintext and preserves encrypted token envelopes', () => {
  const envelope = { $wbEncrypted: 1, envelope: 'opaque-envelope' };
  const plaintext = {
    account: { uid: 'legacy-user', nickname: 'Legacy' },
    auth: { accessToken: 'legacy-access', refreshToken: 'legacy-refresh', domain: 'https://www.workbuddy.cn' },
  };
  const encrypted = {
    account: { uid: 'encrypted-user', nickname: envelope },
    auth: { accessToken: envelope, refreshToken: envelope, domain: 'https://www.workbuddy.cn' },
  };

  const plainResult = lib.normalizeAccountImportJson(plaintext);
  assert.equal(plainResult.uid, 'legacy-user');
  assert.equal(plainResult.normalized.auth.accessToken, 'legacy-access');

  const encryptedResult = lib.normalizeAccountImportJson(encrypted);
  assert.equal(encryptedResult.uid, 'encrypted-user');
  assert.deepEqual(encryptedResult.normalized.auth.accessToken, envelope);
  assert.deepEqual(encryptedResult.normalized.auth.refreshToken, envelope);
  assert.deepEqual(encryptedResult.normalized.account.nickname, envelope);
  assert.equal(lib.wdCompatAuthToken(encryptedResult.normalized.auth), '');
  assert.equal(lib.wdCompatText(envelope), '(已加密)');
});

test('account backup keeps both legacy plaintext and encrypted source bytes unchanged', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-compat-'));
  try {
    const dataDir = path.join(root, 'WorkDaddy');
    const authDir = path.join(root, 'auth');
    fs.mkdirSync(authDir, { recursive: true });
    lib.ensureDirs(dataDir);
    const envelope = { $wbEncrypted: 1, envelope: 'opaque-envelope' };
    const fixtures = [
      {
        uid: 'legacy-user',
        value: { account: { uid: 'legacy-user', nickname: 'Legacy' }, auth: { accessToken: 'legacy-access', domain: 'https://www.workbuddy.cn' } },
      },
      {
        uid: 'encrypted-user',
        value: { account: { uid: 'encrypted-user', nickname: envelope }, auth: { accessToken: envelope, domain: 'https://www.workbuddy.cn' } },
      },
    ];
    for (const fixture of fixtures) {
      const source = path.join(authDir, fixture.uid + '.info');
      const raw = JSON.stringify(fixture.value, null, 2);
      fs.writeFileSync(source, raw);
      lib.backupAuthFile(dataDir, source);
      assert.equal(fs.readFileSync(lib.backupPath(dataDir, fixture.uid), 'utf8'), raw);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('injected compatibility is packaged and AI theme access is no longer profile-gated', () => {
  const root = path.join(__dirname, '..');
  const daemon = fs.readFileSync(path.join(root, 'scripts', 'daemon.js'), 'utf8');
  const inject = fs.readFileSync(path.join(root, 'scripts', 'inject.js'), 'utf8');
  const macBuild = fs.readFileSync(path.join(root, 'scripts', 'build-mac-dmg.sh'), 'utf8');
  const winVerify = fs.readFileSync(path.join(root, 'scripts', 'verify-win.cmd'), 'utf8');

  assert.match(daemon, /workbuddy-compat\.js/);
  assert.match(macBuild, /workbuddy-compat\.js/);
  assert.match(winVerify, /workbuddy-compat\.js/);
  assert.match(inject, /WBS_COMPAT\.findComposerToolbar\(document\)/);
  assert.match(inject, /WBS_COMPAT\.findQueueAdapter\(document\)/);
  assert.match(inject, /if \(!CAPS\.theme\)/);
  assert.doesNotMatch(inject, /if \(!CAPS\.theme \|\| WBS_PROFILE_IS_AI\)/);
  assert.doesNotMatch(inject, /migrateWorkBuddyAiThemeOnce/);
});
