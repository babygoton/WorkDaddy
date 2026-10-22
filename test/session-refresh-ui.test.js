'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../scripts/inject.js'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness() {
  const requests = [], masks = [];
  const list = { innerHTML: 'existing rows', scrollTop: 12 };
  let active = true, renders = 0, counts = 0;
  const ctx = vm.createContext({
    alive: true, state: { open: true }, document: { hidden: false },
    body: { scrollTop: 30 },
    root: { querySelectorAll: () => masks },
    sessionsPane: { classList: { contains: () => active }, querySelector: () => list },
    sessionsState: { range: 'all', list: [{ id: 'old' }], selected: {}, wsExpanded: { workspace: 8 }, batchMode: false },
    api(url) { return new Promise((resolve, reject) => requests.push({ url, resolve, reject })); },
    renderSessions() { renders++; list.innerHTML = 'rendered'; list.scrollTop = 0; ctx.body.scrollTop = 0; },
    updateSessCount() { counts++; }, setSessBatchBar() {}, esc: text => text,
  });
  const start = source.indexOf('    function canRefreshSessions(');
  const end = source.indexOf('    function loadAutomationSyncSetting()', start);
  assert.ok(start > 0 && end > start, 'refresh guards and loader must be available');
  vm.runInContext(source.slice(start, end), ctx);
  return { ctx, requests, list, masks, setActive(value) { active = value; }, renders: () => renders, counts: () => counts };
}

test('returning to a built session tab requests a silent refresh and the poll uses disposed build timers', () => {
  const h = harness();
  const start = source.indexOf('    function switchTab(name)');
  Object.assign(h.ctx, {
    root: { querySelectorAll: () => [] }, sessionsPane: { dataset: { built: '1' } },
    themePane: null, modelsPane: null, enhancePane: null, automationPane: null, pcPane: null, aboutPane: null, settingsPane: null,
    refreshSessionsSilently() { h.ctx.refreshed = true; },
  });
  vm.runInContext(source.slice(start, source.indexOf('    var tabBtns =', start)), h.ctx);
  h.ctx.switchTab('sessions');
  assert.equal(h.ctx.refreshed, true);
  assert.match(source, /setBuildInterval\(refreshSessionsSilently, 5000\)/);
  assert.match(source, /if \(newlyOpened\) refreshSessionsSilently\(\)/);
});

test('silent reconciliation preserves expanded groups and the scroll position at response time without a loading flash', async () => {
  const h = harness(), expanded = h.ctx.sessionsState.wsExpanded;
  const run = h.ctx.refreshSessionsSilently();
  h.ctx.refreshSessionsSilently();
  assert.equal(h.requests.length, 1, 'coalesce concurrent background reads');
  assert.equal(h.list.innerHTML, 'existing rows');
  h.list.scrollTop = 47; h.ctx.body.scrollTop = 81;
  h.requests[0].resolve({ sessions: [{ id: 'remaining' }], totalBytes: 3 });
  await run;
  assert.equal(h.ctx.sessionsState.list[0].id, 'remaining');
  assert.equal(h.ctx.sessionsState.wsExpanded, expanded);
  assert.equal(h.list.scrollTop, 47);
  assert.equal(h.ctx.body.scrollTop, 81);
  assert.equal(h.renders(), 1);
});

test('hidden panels, inactive tabs, selections, batch operations and visible dialogs suspend silent refresh', () => {
  for (const mutate of [
    h => { h.ctx.state.open = false; }, h => { h.ctx.document.hidden = true; },
    h => h.setActive(false), h => { h.ctx.sessionsState.batchMode = true; },
    h => { h.ctx.sessionsState.selected = { old: true }; },
    h => h.masks.push({ hidden: false, getClientRects: () => [1] }),
    h => { h.ctx.sessionsState.exportJob = { running: true }; },
    h => { h.ctx.sessionsState.autoCopyJob = { status: 'running' }; },
    h => { h.ctx.sessionsState.autoCopyAllBusy = true; },
    h => { h.ctx.sessionsState.autoSyncAutomationsBusy = true; },
  ]) {
    const h = harness(); mutate(h); h.ctx.refreshSessionsSilently();
    assert.equal(h.requests.length, 0);
  }
});

test('a dialog or selection opened during a background request prevents replacement', async () => {
  for (const mutate of [
    h => { h.ctx.sessionsState.selected = { old: true }; },
    h => h.masks.push({ hidden: false, getClientRects: () => [1] }),
    h => { h.ctx.alive = false; },
    h => { h.ctx.sessionsState.list[0].autoCopySession = true; },
    h => { h.ctx.sessionsState.autoCopyAll = true; },
  ]) {
    const h = harness(); const run = h.ctx.refreshSessionsSilently(); mutate(h);
    h.requests[0].resolve({ sessions: [] }); await run;
    assert.equal(h.ctx.sessionsState.list[0].id, 'old');
    assert.equal(h.renders(), 0);
  }
});

test('stale background results cannot replace a newer filter response', async () => {
  const h = harness(); const old = h.ctx.refreshSessionsSilently();
  h.ctx.sessionsState.range = '7d';
  const current = h.ctx.loadSessions();
  assert.match(h.requests[1].url, /range=7d/);
  h.requests[1].resolve({ sessions: [{ id: 'new-filter' }] }); await current;
  h.requests[0].resolve({ sessions: [{ id: 'stale-filter' }] }); await old;
  assert.equal(h.ctx.sessionsState.list[0].id, 'new-filter');
  assert.equal(h.renders(), 1);
});

test('background errors leave existing rows intact and allow a later retry', async () => {
  const h = harness(); const run = h.ctx.refreshSessionsSilently();
  h.requests[0].reject(Error('offline')); await run;
  assert.equal(h.list.innerHTML, 'existing rows');
  h.ctx.refreshSessionsSilently();
  assert.equal(h.requests.length, 2);
  h.requests[1].resolve({ sessions: [] }); await flush();
  assert.equal(h.ctx.sessionsState.list.length, 0);
});

test('unchanged background snapshots do not replace the session DOM', async () => {
  const h = harness();
  const data = { sessions: [{ id: 'old' }], totalBytes: 3, autoCopy: null, autoCopyAll: false };
  h.ctx.sessionsState.totalBytes = 3;
  h.ctx.sessionsState.autoCopy = null;
  h.ctx.sessionsState.autoCopyAll = false;
  const run = h.ctx.refreshSessionsSilently();
  h.requests[0].resolve(data); await run;
  assert.equal(h.renders(), 0);
  assert.equal(h.list.innerHTML, 'existing rows');
});
