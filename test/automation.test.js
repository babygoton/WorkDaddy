'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const {
  normalizeTask,
  validateTask,
  executeTask,
  CAPABILITIES,
  SUPPORTED_OPS,
  AGENT_EXAMPLES,
  capabilityText,
  agentBridgePaths,
  ensureAgentBridge,
  createAgentRequest,
  importAgentInbox,
  readAutomations,
  writeAutomations,
} = require('../scripts/automation.js');

test('automation tasks normalize lifecycle triggers and expose examples', () => {
  const task = normalizeTask({ id: 'demo', name: 'demo', trigger: { type: 'pageLoaded' }, steps: [] });
  assert.equal(task.trigger.type, 'pageLoaded');
  assert.equal(task.trigger.oncePerNavigation, true);
  assert.equal(normalizeTask({ id: 'ready', name: 'ready', trigger: { type: 'pageReady' }, steps: [] }).trigger.type, 'pageReady');
  assert.ok(CAPABILITIES.some((item) => item.id === 'event.pageReady'));
  assert.ok(CAPABILITIES.some((item) => item.id === 'event.pageLoaded'));
  assert.ok(CAPABILITIES.some((item) => item.id === 'event.accountSwitched'));
});

test('automation execution exposes lifecycle event and account context to steps', async () => {
  const seen = [];
  const task = validateTask({
    id: 'event-context', name: 'event-context', trigger: { type: 'accountSwitched' },
    steps: [{ op: 'state.set', key: 'eventType', value: '{{event.type}}' }, { op: 'state.set', key: 'uid', value: '{{account.uid}}' }],
  });
  const result = await executeTask(task, {
    event: { type: 'accountSwitched', account: { uid: 'u1', nickname: 'Demo' } },
    setState: async (_scope, _uid, key, value) => seen.push([key, value]),
  });
  assert.deepEqual(seen, [['eventType', 'accountSwitched'], ['uid', 'u1']]);
  assert.equal(result.context.account.uid, 'u1');
});

test('account loops can physically switch each account and restore the original', async () => {
  const accounts = [{ uid: 'a', nickname: 'A' }, { uid: 'b', nickname: 'B' }];
  const switched = [];
  let active = accounts[0];
  const task = validateTask({
    id: 'physical-account-loop', name: 'physical-account-loop', steps: [{
      op: 'account.forEach', accounts: 'all', switch: true,
      steps: [{ op: 'state.set', scope: 'account', key: 'visited', value: '{{account.uid}}' }],
    }],
  });
  await executeTask(task, {
    listAccounts: async () => accounts,
    currentAccount: async () => active,
    accountSwitch: async (account) => { switched.push(account.uid); active = account; },
    setState: async () => {},
  });
  assert.deepEqual(switched, ['a', 'b', 'a']);
  assert.equal(active.uid, 'a');
});

test('capability protocol documents every supported step and rejects event ids as steps', () => {
  const documented = new Set(CAPABILITIES.map((item) => item.id));
  for (const op of SUPPORTED_OPS) assert.equal(documented.has(op), true, `missing capability documentation for ${op}`);
  assert.match(capabilityText('zh'), /WorkDaddy 自动化任务协议 v1/);
  assert.match(capabilityText('en'), /WorkDaddy Automation Task Protocol v1/);
  assert.match(capabilityText('zh'), /基础接口总目录：[\s\S]*logic:[\s\S]*account:[\s\S]*http:[\s\S]*dom:[\s\S]*session:[\s\S]*state:[\s\S]*notify:/);
  assert.match(capabilityText('zh'), /HTTP 输入：[\s\S]*响应：\{ok,status,headers,text,json\}/);
  assert.match(capabilityText('en'), /Capability index:[\s\S]*Per-operation reference and minimal examples:/);
  assert.throws(() => validateTask({ id: 'bad-event-step', name: 'bad', steps: [{ op: 'event.pageLoaded' }] }), /不支持能力/);
  assert.throws(() => validateTask({ id: 'reserved-step', name: 'bad', steps: [{ op: 'notify.session', message: 'done' }] }), /不支持能力/);
});

test('switch and catch capabilities execute their documented branches', async () => {
  const values = [];
  const task = {
    id: 'logic-branches', name: 'logic-branches', variables: { code: 200 },
    steps: [
      { op: 'logic.switch', value: '{{vars.code}}', cases: { 200: [{ op: 'state.set', key: 'branch', value: 'ok' }] }, default: [] },
      { op: 'logic.catch', steps: [{ op: 'logic.assert', condition: { left: false, operator: 'truthy' }, message: 'expected' }], onError: [{ op: 'state.set', key: 'caught', value: '{{vars.error.message}}' }] },
    ],
  };
  await executeTask(task, { setState: async (_scope, _uid, key, value) => values.push([key, value]) });
  assert.deepEqual(values, [['branch', 'ok'], ['caught', 'expected']]);
});

test('automation execution records step-level failures even when logic.catch handles them', async () => {
  const logs = [];
  const result = await executeTask({
    id: 'step-logs', name: 'step logs',
    steps: [{ op: 'logic.catch', steps: [{ op: 'logic.assert', condition: { left: false, operator: 'truthy' }, message: 'expected failure' }], onError: [] }],
  }, { log: (message) => logs.push(message) });
  assert.equal(result.result.ok, false);
  assert.ok(logs.some((line) => /step:start:\d+:logic\.assert/.test(line)));
  assert.ok(logs.some((line) => /step:error:\d+:logic\.assert:expected failure/.test(line)));
  assert.ok(logs.some((line) => /step:complete:\d+:logic\.catch/.test(line)));
});

test('automation panel uses its published picker and wider protocol surfaces', () => {
  const inject = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'inject.js'), 'utf8');
  const paneStart = inject.indexOf('function buildAutomationPane()');
  const paneEnd = inject.indexOf('// ===== 会话 pane', paneStart);
  const pane = inject.slice(paneStart, paneEnd);
  assert.match(pane, /window\.__wbsStartAutomationPicker\(\)/);
  assert.doesNotMatch(pane, /window\.__wbsStartPicked\(\)/);
  assert.doesNotMatch(pane, /document\.addEventListener\('mousemove'/);
  assert.match(pane, /wbs-auto-protocol/);
  assert.match(inject, /\.wbs-modal\.wbs-auto-cap-modal\{[^}]*width:calc\(100% - 24px\)/);
  assert.doesNotMatch(inject, /['"]\.wbs-auto-cap-modal\{/);
  assert.match(inject, /\.wbs-panel\{[^}]*width:720px/);
  assert.match(inject, /data-wbs-language="en"\] \.wbs-panel\{width:880px/);
});

test('automation panel uses compact controls and preserves page-ready editing', () => {
  const inject = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'inject.js'), 'utf8');
  const paneStart = inject.indexOf('function buildAutomationPane()');
  const paneEnd = inject.indexOf('// ===== 会话 pane', paneStart);
  const pane = inject.slice(paneStart, paneEnd);
  assert.match(pane, /data-auto-enabled=/);
  assert.match(pane, /wbs-auto-pick-btn/);
  assert.match(pane, /data-auto-field="trigger"/);
  assert.match(pane, /value="pageReady"/);
  assert.doesNotMatch(pane, /id="wbs-auto-refresh"/);
  assert.doesNotMatch(pane, /wbs-auto-runstate/);
  assert.match(pane, /id="wbs-auto-batch-apply"/);
  assert.match(pane, /id="wbs-auto-select-all"/);
  assert.match(pane, /id="wbs-auto-clear-logs"/);
  assert.doesNotMatch(pane, /wbs-auto-log-note/);
  assert.match(pane, /任务已启用/);
  assert.match(pane, /is-running/);
  assert.match(pane, /aria-busy="true"/);
  assert.match(pane, /item\.status === 'running'/);
});

test('agent bridge materializes complete bilingual protocol files in the persistent profile directory', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-automation-agent-'));
  try {
    const paths = ensureAgentBridge(dataDir, { profileId: 'workbuddy-cn' });
    assert.deepEqual(paths, agentBridgePaths(dataDir));
    assert.equal(fs.readFileSync(paths.protocolZh, 'utf8'), capabilityText('zh') + '\n');
    assert.equal(fs.readFileSync(paths.protocolEn, 'utf8'), capabilityText('en') + '\n');
    assert.match(fs.readFileSync(paths.guide, 'utf8'), /inbox[\s\S]*results[\s\S]*不要直接修改 automations\.json/);
    assert.equal(fs.statSync(paths.inboxDir).isDirectory(), true);
    assert.equal(fs.statSync(paths.resultsDir).isDirectory(), true);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('agent inbox validates and imports one task without overwriting an existing id', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-automation-inbox-'));
  try {
    const paths = ensureAgentBridge(dataDir, { profileId: 'workbuddy-cn' });
    writeAutomations(dataDir, [{ id: 'existing', name: 'Existing', steps: [] }]);
    fs.writeFileSync(path.join(paths.inboxDir, 'request-ok.json'), JSON.stringify({
      id: 'agent-created', name: 'Agent created', trigger: { type: 'manual' }, steps: [{ op: 'logic.delay', ms: 1 }],
    }));
    const imported = importAgentInbox(dataDir, { settleMs: 0 });
    assert.deepEqual(imported.map((item) => [item.requestId, item.ok, item.taskId]), [['request-ok', true, 'agent-created']]);
    assert.equal(readAutomations(dataDir).some((task) => task.id === 'agent-created'), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(paths.resultsDir, 'request-ok.json'), 'utf8')).ok, true);
    assert.equal(fs.existsSync(path.join(paths.inboxDir, 'request-ok.json')), false);

    fs.writeFileSync(path.join(paths.inboxDir, 'request-duplicate.json'), JSON.stringify({ id: 'existing', name: 'Overwrite', steps: [] }));
    const duplicate = importAgentInbox(dataDir, { settleMs: 0 });
    assert.equal(duplicate[0].ok, false);
    assert.match(duplicate[0].error, /已存在/);
    assert.equal(readAutomations(dataDir).find((task) => task.id === 'existing').name, 'Existing');

    fs.writeFileSync(path.join(paths.inboxDir, 'request-duplicate.json'), JSON.stringify({ id: 'retry-with-new-id', name: 'Fixed', steps: [] }));
    const retried = importAgentInbox(dataDir, { settleMs: 0 });
    assert.equal(retried[0].ok, true);
    assert.equal(retried[0].taskId, 'retry-with-new-id');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('agent examples produce a one-time prompt with exact local protocol, inbox and result paths', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-automation-prompt-'));
  try {
    const request = createAgentRequest(dataDir, { exampleId: 'page-loaded-notice', language: 'zh', profileId: 'workbuddy-cn', now: 1700000000000 });
    assert.equal(AGENT_EXAMPLES.length >= 1, true);
    assert.match(request.prompt, /剩余积分和连续活跃天数/);
    assert.equal(AGENT_EXAMPLES.some((example) => example.id === 'close-buddy-fuel'), false);
    assert.match(request.prompt, new RegExp(request.protocolPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(request.prompt, new RegExp(request.inboxFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(request.prompt, new RegExp(request.resultFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(path.dirname(request.inboxFile), agentBridgePaths(dataDir).inboxDir);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('automation storage is profile-isolated and uninstallers preserve it by default', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-automation-profiles-'));
  try {
    const cnDir = path.join(root, 'WorkDaddy');
    const aiDir = path.join(root, 'WorkDaddy', 'profiles', 'workbuddy-ai');
    writeAutomations(cnDir, [{ id: 'cn-only', name: 'CN', steps: [] }]);
    writeAutomations(aiDir, [{ id: 'ai-only', name: 'AI', steps: [] }]);
    assert.deepEqual(readAutomations(cnDir).map((task) => task.id), ['cn-only']);
    assert.deepEqual(readAutomations(aiDir).map((task) => task.id), ['ai-only']);
    const macUninstall = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'uninstall.sh'), 'utf8');
    const winUninstall = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'uninstall-win.ps1'), 'utf8');
    assert.match(macUninstall, /备份数据保留在/);
    assert.match(winUninstall, /默认保留备份数据/);
    assert.match(winUninstall, /if \(\$RemoveData\)/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('automation examples use the guarded new-agent-task route and refresh imported tasks continuously', () => {
  const inject = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'inject.js'), 'utf8');
  const daemon = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'daemon.js'), 'utf8');
  assert.match(inject, /wbs-auto-examples/);
  assert.match(inject, /\/api\/automations\/agent-generate/);
  assert.match(inject, /automationState\.pollTimer = setInterval\(load, 2500\)/);
  assert.match(daemon, /async function openNewAutomationAgentTask/);
  assert.match(daemon, /conversation-list-tab-button\.active/);
  assert.match(daemon, /workspace-new-task-button/);
  assert.match(daemon, /拒绝发送到当前会话/);
  assert.match(daemon, /data-slate-placeholder/);
  assert.match(daemon, /data-slate-zero-width/);
  assert.match(daemon, /await sendStashToComposer\(\{ content: \{ text, items: \[\] \} \}\)/);
  assert.match(daemon, /window\.__wbsNotifyToast/);
  assert.match(inject, /workdaddy:automation-toast/);
});

test('automation session sends only after entering the WorkBuddy new-task surface', () => {
  const daemon = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'daemon.js'), 'utf8');
  const inject = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'inject.js'), 'utf8');
  assert.match(daemon, /conversation-list-tab-button-box/);
  assert.match(daemon, /async function ensureAutomationNewTask\(options = \{\}\)/);
  assert.match(daemon, /if \(op === 'session.create'\) await withInput\(\(\) => ensureAutomationNewTask\(\{ guard:/);
  assert.match(daemon, /newTaskReady/);
  assert.match(daemon, /if\(!newTaskReady\)\{/);
  assert.match(inject, /data-auto-stop/);
  assert.match(inject, /autoActionPending/);
  assert.match(inject, /\.wbs-auto-icon\.is-running[^}]*opacity:1/);
});

test('automation DOM locators traverse open shadow roots and task rows expose logs', () => {
  const inject = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'inject.js'), 'utf8');
  const daemon = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'daemon.js'), 'utf8');
  assert.match(daemon, /function automationDeepLocatorExpression/);
  assert.match(daemon, /element\.shadowRoot/);
  assert.match(daemon, /element\.contentDocument/);
  assert.match(inject, /data-auto-logs/);
  assert.match(inject, /function showAutomationLogs/);
  assert.match(inject, /wbs-auto-log-modal/);
  assert.match(inject, /api\('\/api\/automations\/logs\/clear'/);
  assert.match(daemon, /p === '\/api\/automations\/logs\/clear'/);
  assert.match(daemon, /async function acSendPhrase\(text, options = \{\}\)/);
});

test('automation send uses a trusted Enter submit path and running rows expose stop actions', () => {
  const inject = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'inject.js'), 'utf8');
  const daemon = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'daemon.js'), 'utf8');
  assert.match(daemon, /async function acSendPhrase\(text, options = \{\}\)[\s\S]*sendStashToComposer/);
  assert.match(daemon, /button\.cr-send-button/);
  assert.match(daemon, /sessionWaitReply = async detail => sessionAction\('session.wait'/);
  assert.match(inject, /AUTO_STOP_SVG/);
  assert.match(inject, /data-auto-stop/);
  assert.match(inject, /\/api\/automations\/stop/);
});

test('automation deep locator expression compiles and finds an element inside an open shadow root', () => {
  const daemon = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'daemon.js'), 'utf8');
  const match = daemon.match(/function automationDeepLocatorExpression\(locator\) \{([\s\S]*?)\n\}\nasync function automationDomAction/);
  assert.ok(match, 'missing automationDeepLocatorExpression');
  const buildExpression = new Function('locator', match[1]);
  const expression = buildExpression({ kind: 'css', value: '#fuel-compact-close' });
  assert.doesNotThrow(() => new vm.Script(expression));

  const target = { id: 'fuel-compact-close' };
  const shadowRoot = { querySelectorAll: () => [], querySelector: (selector) => selector === '#fuel-compact-close' ? target : null };
  const document = { querySelectorAll: () => [{ tagName: 'DIV', shadowRoot }], querySelector: () => null };
  assert.equal(vm.runInNewContext(expression, { document }), target);
});

test('automation task editor is a modal and is not rendered below example prompts', () => {
  const inject = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'inject.js'), 'utf8');
  const paneStart = inject.indexOf('function buildAutomationPane()');
  const paneEnd = inject.indexOf('// ===== 会话 pane', paneStart);
  const pane = inject.slice(paneStart, paneEnd);
  assert.match(pane, /mask\.id = 'wbs-auto-editor-mask'/);
  assert.match(pane, /wbs-modal wbs-auto-editor-modal/);
  const htmlStart = pane.indexOf('automationPane.innerHTML =');
  const htmlEnd = pane.indexOf("automationPane.querySelector('#wbs-auto-new')", htmlStart);
  assert.doesNotMatch(pane.slice(htmlStart, htmlEnd), /wbs-auto-editor/);
});
