'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { SCHEMA_VERSION, validateTask, executeTask, installBuiltinTask, readAutomations, writeAutomations } = require('../scripts/automation.js');
const { normalizeAutomationModelId, selectAutomationModel, verifyAutomationModel, restoreNewTaskModelPreference } = require('../scripts/automation-model.js');

const builtIn = JSON.parse(fs.readFileSync(path.join(__dirname, '../scripts/builtin/automations/keep-accounts-active.json'), 'utf8'));

test('V2 session sends accept a model ID without changing the protocol version', async () => {
  assert.equal(SCHEMA_VERSION, 2);
  const seen = [];
  const task = validateTask({ schemaVersion: 2, id: 'choose-model', name: 'choose-model', variables: { model: 'deepseek-v4.1-flash' }, steps: [
    { op: 'session.create', message: 'hi', model: '{{vars.model}}' },
    { op: 'session.send', conversationId: 'c', message: 'again', model: 'deepseek-v4.1-flash' },
  ] });
  await executeTask(task, { sessionAction: async (op, detail) => { seen.push({ op, model: detail.model }); return { ok: true }; } });
  assert.deepEqual(seen, [
    { op: 'session.create', model: 'deepseek-v4.1-flash' },
    { op: 'session.send', model: 'deepseek-v4.1-flash' },
  ]);
  assert.equal(builtIn.schemaVersion, 2);
  assert.equal(builtIn.steps[0].steps.find(step => step.op === 'session.create').model, 'deepseek-v4.1-flash');
  assert.doesNotThrow(() => validateTask(builtIn));
});

test('the revised builtin upgrades only the unchanged installed task', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-model-builtin-'));
  const file = path.join(__dirname, '../scripts/builtin/automations/keep-accounts-active.json');
  try {
    const old = structuredClone(builtIn);
    old.schemaVersion = 1;
    delete old.revision;
    delete old.upgradeFromContentHashes;
    old.description = '依次切换所有账号，新建会话发送 1+1=，按会话回执等待回复完成，最后恢复开始时的账号。';
    delete old.steps[0].steps.find(step => step.op === 'session.create').model;
    const oldFile = path.join(dir, 'old.json');
    fs.writeFileSync(oldFile, JSON.stringify(old));
    installBuiltinTask(dir, oldFile);
    const installed = readAutomations(dir);
    installed[0].enabled = false;
    writeAutomations(dir, installed);
    assert.equal(installBuiltinTask(dir, file).status, 'upgraded');
    const upgraded = readAutomations(dir)[0];
    assert.equal(upgraded.enabled, false);
    assert.equal(upgraded.schemaVersion, 2);
    assert.equal(upgraded.steps[0].steps.find(step => step.op === 'session.create').model, 'deepseek-v4.1-flash');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid or missing model IDs stop before session sending', async () => {
  for (const model of [42, '', '  ', 'x'.repeat(121), 'model\nother']) {
    assert.throws(() => validateTask({ schemaVersion: 2, id: 'bad', steps: [{ op: 'session.create', message: 'hi', model }] }), /model/);
  }
  assert.throws(() => validateTask({ schemaVersion: 1, id: 'old', steps: [{ op: 'session.create', message: 'hi', model: 'a' }] }), /V2/);
  assert.equal(normalizeAutomationModelId(' custom-local:Deepseek-V4 '), 'custom-local:Deepseek-V4');
  assert.throws(() => normalizeAutomationModelId(undefined), /model/);
  let sent = false;
  await assert.rejects(executeTask({ schemaVersion: 2, id: 'missing-model', steps: [{ op: 'session.create', message: 'hi', model: '{{vars.absent}}' }] }, {
    sessionAction: async () => { sent = true; return { ok: true }; },
  }), /model/);
  assert.equal(sent, false);
});

function rendererHarness(session, options = {}) {
  let selected = 'original-model';
  let coreModel = selected;
  let menuOpen = false;
  let selectedCalls = 0;
  const storage = new Map([['cb-newtask:model:account', JSON.stringify({ id: selected, reasoningEffort: 'high' })]]);
  const names = { 'original-model': 'Original', 'deepseek-v4.1-flash': 'Deepseek-V4.1-Flash' };
  const trigger = {
    innerText: names[selected],
    getBoundingClientRect: () => ({ width: 90, height: 25 }),
    click: () => { menuOpen = !menuOpen; },
  };
  const items = Object.keys(names).map(id => ({
    __reactFiber$test: { return: null, get memoizedProps() { return {
      option: { id, name: names[id] }, isSelected: selected === id,
      onSelect() {
        selectedCalls++;
        selected = id;
        trigger.innerText = names[id];
        storage.set('cb-newtask:model:account', JSON.stringify({ id, reasoningEffort: 'high' }));
        if (session && !(options.failCoreForTarget && id === 'deepseek-v4.1-flash')) coreModel = id;
        menuOpen = false;
      },
    }; } },
  }));
  const controller = {
    conversationId: 'conversation',
    sessionStore: { getState: () => ({ model: selected }) },
    config: { getConversation: () => ({ configManager: { model: coreModel } }) },
  };
  const document = {
    querySelector(selector) {
      if (selector === '.cr-model-selector__popover') return menuOpen ? {} : null;
      if (selector === '.cr-document[data-root-id]') return session ? { getAttribute: () => 'conversation' } : null;
      if (selector === 'button.conversation-list-tab-button.active') return session ? null : { textContent: '新建任务', getAttribute: () => null };
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'button.cr-model-selector__trigger') return [trigger];
      if (selector === '.cr-model-selector__item') return menuOpen ? items : [];
      return [];
    },
  };
  const window = {
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    __wbsWorkBuddyCompat: { findConversationControllers: () => session ? [controller] : [] },
  };
  const run = options => vm.runInNewContext('(' + selectAutomationModel.toString() + ')(' + JSON.stringify(options) + ')', { document, window, setTimeout });
  const verify = options => vm.runInNewContext('(' + verifyAutomationModel.toString() + ')(' + JSON.stringify(options) + ')', { document, window });
  const restore = selection => vm.runInNewContext('(' + restoreNewTaskModelPreference.toString() + ')(' + JSON.stringify(selection) + ')', { window });
  return { run, verify, restore, state: () => ({ selected, coreModel, menuOpen, selectedCalls, raw: storage.get('cb-newtask:model:account') }) };
}

test('renderer invokes the official model option handler and confirms the selection', async () => {
  const home = rendererHarness(false);
  const created = await home.run({ model: 'deepseek-v4.1-flash', accountUid: 'account' });
  assert.equal(created.previousModel, 'original-model');
  assert.equal(created.changed, true);
  assert.equal(home.state().selected, 'deepseek-v4.1-flash');
  assert.equal(home.state().selectedCalls, 1);
  assert.equal(home.state().menuOpen, false);
  assert.equal(home.verify({ model: 'deepseek-v4.1-flash', displayName: 'Deepseek-V4.1-Flash', accountUid: 'account' }), true);
  assert.equal(home.restore(created).restored, true);
  assert.equal(home.state().raw, created.previousRaw);

  const session = rendererHarness(true);
  const sent = await session.run({ model: 'deepseek-v4.1-flash', conversationId: 'conversation' });
  assert.equal(sent.previousModel, 'original-model');
  assert.equal(session.state().coreModel, 'deepseek-v4.1-flash');
  assert.equal(session.state().selectedCalls, 1);
  assert.equal(session.verify({ model: 'deepseek-v4.1-flash', displayName: 'Deepseek-V4.1-Flash', conversationId: 'conversation' }), true);
  await assert.rejects(session.run({ model: 'missing', conversationId: 'conversation' }), /未知模型/);
  assert.equal(session.state().selectedCalls, 1);
  assert.equal(session.state().menuOpen, false);
});

test('an unconfirmed core switch restores the previously selected model', async () => {
  const session = rendererHarness(true, { failCoreForTarget: true });
  await assert.rejects(session.run({ model: 'deepseek-v4.1-flash', conversationId: 'conversation' }), /模型切换未确认/);
  assert.equal(session.state().selected, 'original-model');
  assert.equal(session.state().coreModel, 'original-model');
  assert.equal(session.state().menuOpen, false);
});

test('daemon selects and checks the model before sending, and ships the renderer helper', () => {
  const daemon = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');
  const selectAt = daemon.indexOf('modelSelection = await withInput(() => selectAutomationModelById(');
  const sendAt = daemon.indexOf("await withInput(() => acSendPhrase(String(detail.message || '')");
  assert.ok(selectAt > 0 && sendAt > selectAt);
  assert.match(daemon, /if \(modelId\) await confirmAutomationModel\(modelId/);
  assert.match(daemon, /restoreAutomationNewTaskPreference\(modelSelection\)/);
  assert.match(daemon, /const DAEMON_VERSION = '1\.2\.74'/);
  const staging = fs.readFileSync(path.join(__dirname, '../scripts/build-mac-dmg.sh'), 'utf8');
  assert.match(staging, /automation-model\.js/);
});
