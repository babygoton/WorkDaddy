'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../scripts/inject.js'), 'utf8');
function harness() {
  const requests = [], nodes = {};
  for (const id of ['title', 'body', 'ok', 'cancel']) nodes['#wbs-sess-modal-' + id] = { textContent: '', focus() {}, disabled: false };
  const ctx = vm.createContext({
    sessionsPane: { querySelector: id => nodes[id] },
    sessionsState: {}, root: {}, toast() {}, loadSessions() {},
    showSessModal(show) { ctx.open = show; if (!show) nodes['#wbs-sess-modal-ok'].onclick = null; },
    api(route, options) { return new Promise((resolve, reject) => requests.push({ route, options, resolve, reject })); },
  });
  const start = source.indexOf('    function openDeleteModal(');
  vm.runInContext(source.slice(start, source.indexOf('    function selectedSessIds()', start)), ctx);
  return { ctx, requests, nodes, ok: nodes['#wbs-sess-modal-ok'] };
}

test('all-account deletion requires two confirmations and freezes the selected IDs', async () => {
  const h = harness(), selected = ['selected-session'];
  h.ctx.openDeleteModal(selected, true);
  selected.push('later-selection');
  assert.equal(h.requests.length, 0);
  h.ok.onclick();
  assert.equal(h.requests.length, 0, 'first confirmation must not delete');
  assert.match(h.nodes['#wbs-sess-modal-title'].textContent, /再次确认/);
  h.ok.onclick(); h.ok.onclick();
  assert.equal(h.requests.length, 1, 'ignore duplicate submission');
  assert.equal(h.requests[0].route, '/api/sessions/delete');
  assert.deepEqual(JSON.parse(h.requests[0].options.body).ids, ['selected-session']);
  h.requests[0].resolve({ deleted: 3, cascaded: 2 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.ctx.open, false);
});

test('cancelling the second confirmation sends no deletion request', () => {
  const h = harness(); h.ctx.openDeleteModal(['selected-session'], true);
  h.ok.onclick(); h.ctx.showSessModal(false);
  assert.equal(h.requests.length, 0);
  assert.equal(h.ok.onclick, null);
});

test('existing deletion retains its single confirmation and errors permit retry', async () => {
  const h = harness(); h.ctx.openDeleteModal(['selected-session']);
  h.ok.onclick(); assert.equal(h.requests.length, 1);
  h.requests[0].reject(Error('locked'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.ok.disabled, false);
  assert.equal(h.ctx.open, true);
  h.ok.onclick(); assert.equal(h.requests.length, 2);
});

test('all-account delete button follows the current session selection', () => {
  const button = { style: { display: '' } };
  const state = { list: [{ id: 'first' }, { id: 'second' }], selected: {} };
  const ctx = vm.createContext({
    sessionsState: state,
    sessionsPane: { querySelector: id => id === '#wbs-sess-delete-all' ? button : null },
    updateSessionSummary() {}, syncCheckAllBtn() {},
  });
  const start = source.indexOf('    function updateSessCount()');
  vm.runInContext(source.slice(start, source.indexOf('    // 全选按钮', start)), ctx);
  ctx.updateSessCount();
  assert.equal(button.style.display, 'none', 'hidden before checking a session');
  state.selected.first = true;
  ctx.updateSessCount();
  assert.equal(button.style.display, '', 'visible after checking a session');
  state.selected = {};
  ctx.updateSessCount();
  assert.equal(button.style.display, 'none', 'hidden after clearing selection');
  state.selected = { stale: true };
  ctx.updateSessCount();
  assert.equal(button.style.display, 'none', 'selection outside the current list does not show deletion');
});
