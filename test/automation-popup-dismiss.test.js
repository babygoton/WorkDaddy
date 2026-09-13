'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function runPopupTask(appearAt, failedConfirmations = 0) {
  let now = 0;
  const clicks = [];
  const probes = [];
  const notices = [];
  const closed = new Map();
  const popupKey = (selector) => {
    if (/home_growth|wb-slot--home-growth/.test(selector)) return 'growth';
    if (/activity-bubble|claw-welcome-activity|pointer-events: auto/.test(selector)) return 'activity';
    return selector;
  };
  const context = {
    require: require('node:module').createRequire(path.join(__dirname, '../scripts/automation.js')), module: { exports: {} },
    setTimeout: (callback, ms) => { now += ms; callback(); },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../scripts/automation.js'), 'utf8'), context);
  const task = JSON.parse(fs.readFileSync(path.join(__dirname, '../scripts/builtin/automations/close-buddy-popups.json'), 'utf8'));
  const execution = context.module.exports.executeTask(task, {
    domAction: async (op, locator) => {
      const candidates = Array.isArray(locator) ? locator : [locator];
      if (op === 'dom.wait') {
        if (failedConfirmations > 0) { failedConfirmations--; throw new Error('等待页面元素超时'); }
        const key = popupKey(candidates[0].value);
        closed.set(key, (closed.get(key) || 0) + 1);
        return { visible: false };
      }
      assert.equal(op, 'dom.click');
      for (const candidate of candidates) {
        probes.push({ selector: candidate.value, at: now });
        const appearances = appearAt(candidate.value);
        const availableAt = (Array.isArray(appearances) ? appearances : [appearances])[closed.get(popupKey(candidate.value)) || 0];
        if (availableAt == null || now < availableAt) continue;
        clicks.push({ selector: candidate.value, at: now });
        // A click alone is not confirmation; dom.wait must confirm disappearance.
        return { visible: true };
      }
      throw new Error('未找到页面元素');
    },
    notifyToast: (_, message) => notices.push(message),
  });
  return execution.then(() => ({ clicks, probes, notices, elapsed: now }));
}

test('all four popup groups are clicked immediately and only once', async () => {
  const result = await runPopupTask(() => 0);
  assert.equal(result.clicks.length, 4);
  assert.ok(result.clicks.every(click => click.at === 0));
  assert.ok(result.clicks.some(click => click.selector.includes('#fuel-compact-close')));
  assert.ok(result.clicks.some(click => click.selector.includes('wb-related-playbooks__dismiss-today')));
  assert.ok(result.clicks.some(click => click.selector.includes('home_growth_close')));
  assert.ok(result.clicks.some(click => click.selector.includes('activity-bubble__close')));
  assert.equal(result.notices.length, 4);
  assert.equal(result.elapsed, 30000, 'continue observing for re-created popups');
});

test('activity fallbacks do not depend on localized text and broad popup selectors are rejected', () => {
  const task = JSON.parse(fs.readFileSync(path.join(__dirname, '../scripts/builtin/automations/close-buddy-popups.json'), 'utf8'));
  const clicks = task.steps[0].steps.filter(step => step.op === 'logic.catch').map(step => step.steps[0]);
  const values = clicks.flatMap(step => (step.locators || [step.locator]).map(locator => locator.value));
  assert.ok(values.includes('button[data-track-id="home_growth_close"]'));
  assert.ok(values.includes('.wb-slot--home-growth button.wb-slot--closable-close'));
  assert.ok(values.includes('button.claw-welcome-activity-card__close'));
  assert.ok(values.some(value => value.includes('pointer-events: auto') && value.includes('width: 213px')));
  assert.ok(values.every(value => !/关闭活动通知|activity notification/i.test(value)));
  assert.ok(values.every(value => value !== '.wb-slot--closable-close'));
  assert.ok(values.every(value => !value.startsWith('//*[')));
});

test('absent fuel popup does not delay other popups, including one rendered later', async () => {
  const result = await runPopupTask(selector => selector.includes('fuel-compact') ? null : /activity-bubble|claw-welcome-activity|pointer-events: auto/.test(selector) ? 1100 : 0);
  assert.deepEqual(result.clicks.map(click => click.at), [0, 0, 1200]);
  assert.equal(result.notices.length, 3);
  assert.equal(result.elapsed, 30000);
});

test('missing popup buttons finish quietly after the bounded detection window', async () => {
  const result = await runPopupTask(() => null);
  assert.ok(result.probes.length >= 400);
  assert.equal(result.elapsed, 30000);
  assert.equal(result.clicks.length, 0);
  assert.equal(result.notices.length, 0);
});

test('an ineffective click is retried and only confirmed closes are announced', async () => {
  const result = await runPopupTask(() => 0, 1);
  assert.equal(result.clicks.length, 5);
  assert.equal(result.clicks.at(-1).at, 300);
  assert.equal(result.clicks.at(-1).selector, '#fuel-compact-close');
  assert.equal(result.notices.length, 4);
});

test('a popup recreated after a successful close is detected and closed again', async () => {
  const result = await runPopupTask(selector => selector.includes('fuel-compact') ? [0, 900] : 0);
  assert.deepEqual(result.clicks.filter(c => c.selector.includes('fuel-compact')).map(c => c.at), [0, 900]);
});

test('a popup arriving after the old 15-second window is still handled', async () => {
  const result = await runPopupTask(selector => selector.includes('activity-bubble') ? 18000 : null);
  assert.deepEqual(result.clicks.map(c => c.at), [18000]);
});

test('a newer navigation supersedes a running opt-in task instead of dropping its trigger', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');
  const start = source.indexOf('function dispatchAutomationEvent(');
  const end = source.indexOf('\nfunction onCdpEvent(', start);
  const running = { taskId: 'popup', status: 'running', navigationSerial: 1 };
  const context = {
    taskMatchesEvent: require('../scripts/automation').taskMatchesEvent,
    automationEventKeys: new Set(), mainFrameNavigationSerial: 2, cdpPageSessionId: 'renderer-a',
    automationRuns: new Map([['run', running]]), DATA_DIR: '/test',
    readAutomations: () => [{ id: 'popup', enabled: true, trigger: { type: 'pageReady', restartOnNavigation: true } }],
    currentAccount: () => null, log() {},
    startAutomationRun: () => { throw Error('must let the old run settle before starting the next'); },
  };
  vm.runInNewContext(source.slice(start, end), context);
  context.dispatchAutomationEvent('pageReady', { navigationSerial: 2 });
  context.dispatchAutomationEvent('pageReady', { navigationSerial: 3 });
  assert.equal(running.superseded, true);
  assert.equal(running.pendingEvent.navigationSerial, 3, 'retain only the latest navigation');
});

test('pageReady is deduplicated per renderer page rather than per CDP connection', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');
  const start = source.indexOf('function dispatchAutomationEvent(');
  const end = source.indexOf('\nfunction onCdpEvent(', start);
  const launched = [];
  const context = {
    taskMatchesEvent: () => true,
    automationEventKeys: new Set(), mainFrameNavigationSerial: 7, cdpPageSessionId: 'renderer-a',
    automationRuns: new Map(), DATA_DIR: '/test',
    readAutomations: () => [{ id: 'popup', enabled: true, trigger: { type: 'pageReady' } }],
    currentAccount: () => null, log() {}, startAutomationRun: (_, event) => launched.push(event),
  };
  vm.runInNewContext(source.slice(start, end), context);
  context.dispatchAutomationEvent('pageReady', { navigationSerial: 7, source: 'connect' });
  context.dispatchAutomationEvent('pageReady', { navigationSerial: 7, source: 'connect' });
  assert.equal(launched.length, 1, 'a transient reconnect to the same renderer stays deduplicated');
  context.cdpPageSessionId = 'renderer-b';
  context.dispatchAutomationEvent('pageReady', { navigationSerial: 7, source: 'connect' });
  assert.equal(launched.length, 2, 'a restarted renderer gets its own pageReady event');
});

test('queued detection resumes only for the latest page and an enabled task', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');
  const start = source.indexOf('function resumeAutomationAfterNavigation(');
  const end = source.indexOf('\nfunction todayStr(', start);
  const launched = [];
  const task = { id: 'popup', enabled: true, trigger: { restartOnNavigation: true } };
  const context = { mainFrameNavigationSerial: 3, cdpPageSessionId: 'renderer-a', DATA_DIR: '/test', readAutomations: () => [task], startAutomationRun: (...args) => launched.push(args) };
  vm.runInNewContext(source.slice(start, end), context);
  context.resumeAutomationAfterNavigation({ taskId: 'popup', pendingEvent: { navigationSerial: 2, pageSessionId: 'renderer-a' } });
  assert.equal(launched.length, 0);
  const run = { taskId: 'popup', pendingEvent: { navigationSerial: 3, pageSessionId: 'renderer-a' } };
  context.resumeAutomationAfterNavigation(run);
  assert.equal(launched.length, 1);
  assert.equal(run.pendingEvent, null);
  task.enabled = false;
  context.resumeAutomationAfterNavigation({ taskId: 'popup', pendingEvent: { navigationSerial: 3, pageSessionId: 'renderer-a' } });
  assert.equal(launched.length, 1);
});

test('a running cleanup stops before the next navigation begins its own cleanup', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');
  const task = { id: 'popup', enabled: true, trigger: { type: 'pageReady', restartOnNavigation: true } };
  let release;
  const active = new Promise(resolve => { release = resolve; });
  const executions = [], restored = [];
  const noop = () => {};
  const context = {
    taskIsPassiveCleanup: require('../scripts/automation').taskIsPassiveCleanup, taskMatchesEvent: require('../scripts/automation').taskMatchesEvent, taskNeedsPanelClosed: require('../scripts/automation').taskNeedsPanelClosed,
    ...require('../scripts/automation-runtime'),
    acquireAutomationInput: require('../scripts/automation-runtime').createRendererGate(),
    acquireAutomationRenderer: require('../scripts/automation-runtime').createRendererGate(), primaryAccountStore:{get:()=>null},
    crypto: require('node:crypto'), automationRuns: new Map(), automationEventKeys: new Set(),
    mainFrameNavigationSerial: 1, cdpPageSessionId: 'renderer-a', DATA_DIR: '/test', cdp: {}, log: noop,
    readAutomations: () => [task], readAutomationState: () => ({}), writeAutomationState: noop,
    automationPanelIsOpen: async () => false, automationPanelSetOpen: open => restored.push(open),
    listAccounts: () => [], currentAccount: () => null, automationSwitchAccount: noop,
    automationAccountStatus: noop, automationHttpRequest: noop, automationDomAction: noop,
    automationNotifyToast: noop, createAutomationNotifier: require('../scripts/toast-options').createAutomationNotifier,
    executeTask: async (_, deps) => { executions.push(deps); if (executions.length === 1) await active; return {}; },
  };
  const dispatchStart = source.indexOf('function dispatchAutomationEvent(');
  const dispatchEnd = source.indexOf('\nfunction onCdpEvent(', dispatchStart);
  const runStart = source.indexOf('function startAutomationRun(');
  const runEnd = source.indexOf('\nfunction todayStr(', runStart);
  vm.runInNewContext(source.slice(dispatchStart, dispatchEnd) + '\n' + source.slice(runStart, runEnd), context);
  const first = context.startAutomationRun(task, { type: 'pageReady', navigationSerial: 1 });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(executions.length, 1);
  context.mainFrameNavigationSerial = 2;
  context.dispatchAutomationEvent('pageReady', { navigationSerial: 2 });
  assert.equal(executions[0].isCancelled(), true);
  assert.equal(executions.length, 1);
  release();
  await first.completion;
  await Promise.resolve(); await Promise.resolve();
  assert.equal(first.status, 'cancelled');
  assert.equal(executions.length, 2);
  assert.equal(executions[1].event.navigationSerial, 2);
  assert.equal(restored.length, 0, 'old cleanup must not reopen a panel on the new page');
});

test('popup selectors prefer a visible replacement over an old hidden node', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');
  const start = source.indexOf('function automationDeepLocatorExpression(');
  const end = source.indexOf('\nasync function automationDomAction(', start);
  const builder = {};
  vm.runInNewContext(source.slice(start, end), builder);
  const hidden = { getBoundingClientRect: () => ({ width: 0, height: 0 }) };
  const visible = { getBoundingClientRect: () => ({ width: 24, height: 24 }) };
  const document = { querySelectorAll: () => [hidden, visible], querySelector: () => hidden };
  const result = vm.runInNewContext(builder.automationDeepLocatorExpression({ kind: 'css', value: '.close', visible: true }), { document, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) });
  assert.equal(result, visible);
});

test('automation DOM click dispatches the located button without undefined request state', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');
  const start = source.indexOf('async function automationDomAction(');
  const end = source.indexOf('\nasync function automationHttpRequest(', start);
  const clicks = [];
  const found = { x: 10, y: 20, w: 20, h: 30, visible: true };
  const context = {
    cdp: { connected: true },
    automationDeepLocatorExpression: () => 'null',
    cdpSend: async () => ({ result: { value: found } }),
    cdpMouseClick: async (...args) => clicks.push(args),
  };
  vm.runInNewContext(source.slice(start, end), context);
  await context.automationDomAction('dom.click', { kind: 'css', value: 'button.activity-bubble__close', visible: true }, {});
  assert.equal(clicks.length, 1);
  assert.deepEqual(clicks[0].slice(0, 3), ['dom.click:button.activity-bubble__close', 20, 35]);
  assert.equal(clicks[0][4].skipMove, true);
  await context.automationDomAction('dom.click', [{ kind: 'css', value: '.old-close', visible: true }, { kind: 'css', value: '.new-close', visible: true }], {});
  assert.equal(clicks[1][4].skipMove, true, 'candidate popup locators keep the no-hover click path');
  found.blocked = true;
  await assert.rejects(context.automationDomAction('dom.click', { kind: 'css', value: '.close', visible: true }, {}), /遮挡/);
  assert.equal(clicks.length, 2, 'do not click whatever is covering the close button');
  await assert.rejects(context.automationDomAction('dom.click', { kind: 'css', value: '.close' }, { isCancelled: () => true }), /已停止/);
  assert.equal(clicks.length, 2);
});

test('popup clicks bypass mouse-move acknowledgement while normal clicks retain hover', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');
  const start = source.indexOf('async function cdpMouseClick(');
  const end = source.indexOf('\nfunction cdpSend(', start);
  const events = [];
  const context = {
    cdp: {}, log() {}, cdpFocusDiagnostics: async () => {},
    cdpSend: async (_, params) => events.push(params.type),
  };
  vm.runInNewContext(source.slice(start, end), context);
  await context.cdpMouseClick('popup', 20, 30, {}, { skipMove: true });
  assert.deepEqual(events, ['mousePressed', 'mouseReleased']);
  events.length = 0;
  await context.cdpMouseClick('normal', 20, 30);
  assert.deepEqual(events, ['mouseMoved', 'mousePressed', 'mouseReleased']);
});

test('waiting for a dismissed button succeeds immediately when its DOM node was removed', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');
  const start = source.indexOf('async function automationDomAction(');
  const end = source.indexOf('\nasync function automationHttpRequest(', start);
  const context = {
    cdp: { connected: true },
    automationDeepLocatorExpression: () => 'null',
    cdpSend: async () => ({ result: { value: null } }),
    setTimeout: () => { throw new Error('removed node must not wait'); },
  };
  vm.runInNewContext(source.slice(start, end), context);
  const result = await context.automationDomAction('dom.wait', { kind: 'css', value: '#fuel-compact-close' }, { until: { state: 'hidden' }, timeoutMs: 750 });
  assert.equal(result.visible, false);
});
