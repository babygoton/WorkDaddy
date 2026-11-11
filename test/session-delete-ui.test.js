'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../scripts/inject.js'), 'utf8');
function harness() {
  const requests = [], nodes = {};
  for (const id of ['title', 'body', 'ok', 'cancel']) {
    const classes = new Set(), attrs = {};
    nodes['#wbs-sess-modal-' + id] = {
      textContent: '', focus() {}, disabled: false,
      classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
      setAttribute: (name, value) => { attrs[name] = String(value); },
      getAttribute: name => attrs[name] || null,
      removeAttribute: name => { delete attrs[name]; },
    };
  }
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

const flush = () => new Promise(resolve => setImmediate(resolve));
async function preview(h, index = 0, total = 3) {
  h.requests[index].resolve({ previewToken: 'range-token', total, accounts: 2 });
  await flush();
}

test('all-account deletion previews the range, requires two confirmations and freezes IDs', async () => {
  const h = harness(), selected = ['selected-session'];
  h.ctx.openDeleteModal(selected, true);
  selected.push('later-selection');
  assert.deepEqual(JSON.parse(h.requests[0].options.body), { ids: ['selected-session'], scope: 'lineage', preview: true });
  assert.equal(h.ok.disabled, true);
  h.ok.onclick(); assert.equal(h.requests.length, 1);
  await preview(h);
  assert.match(h.nodes['#wbs-sess-modal-body'].textContent, /3 个会话.*2 个账号/);
  h.ok.onclick();
  assert.equal(h.requests.length, 1, 'first confirmation must not delete');
  assert.match(h.nodes['#wbs-sess-modal-title'].textContent, /再次确认/);
  h.ok.onclick(); h.ok.onclick();
  assert.equal(h.requests.length, 2, 'ignore duplicate submission');
  assert.equal(h.ok.disabled, true);
  assert.equal(h.ok.classList.contains('is-loading'), true);
  assert.equal(h.ok.getAttribute('aria-busy'), 'true');
  assert.equal(h.ok.textContent, '删除中…');
  assert.deepEqual(JSON.parse(h.requests[1].options.body), { ids: ['selected-session'], scope: 'lineage', previewToken: 'range-token' });
  h.requests[1].resolve({ deleted: 3, cascaded: 2 });
  await flush();
  assert.equal(h.ctx.open, false);
});

test('cancelling either preview or second confirmation sends no deletion', async () => {
  for (const stage of ['preview', 'confirmation']) {
    const h = harness(); h.ctx.openDeleteModal(['selected-session'], true);
    if (stage === 'confirmation') { await preview(h); h.ok.onclick(); }
    h.ctx.showSessModal(false);
    if (stage === 'preview') await preview(h);
    assert.equal(h.requests.length, 1);
    assert.equal(h.ok.onclick, null);
  }
});

test('ordinary deletion sends selected scope and requires a fresh preview after failure', async () => {
  const h = harness(); h.ctx.openDeleteModal(['selected-session']);
  await preview(h, 0, 1);
  assert.match(h.nodes['#wbs-sess-modal-body'].textContent, /保留其他副本/);
  h.ok.onclick();
  assert.equal(JSON.parse(h.requests[1].options.body).scope, 'selected');
  h.requests[1].reject(Error('locked')); await flush();
  assert.equal(h.requests.length, 3);
  assert.equal(JSON.parse(h.requests[2].options.body).preview, true);
  assert.equal(h.ok.disabled, true);
  assert.equal(h.ok.classList.contains('is-loading'), false);
  assert.equal(h.ok.getAttribute('aria-busy'), null);
  h.ok.onclick(); assert.equal(h.requests.length, 3);
  await preview(h, 2, 1);
  h.ok.onclick(); assert.equal(h.requests.length, 4);
});

test('failed or stale previews cannot enable deletion in another dialog', async () => {
  const h = harness(); h.ctx.openDeleteModal(['old']);
  h.ctx.showSessModal(false); h.ctx.openDeleteModal(['new']);
  await preview(h);
  assert.equal(h.ok.disabled, true);
  h.requests[1].reject(Error('offline')); await flush();
  assert.equal(h.ok.disabled, true);
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
  const filterStart = source.indexOf('    function filteredSessions()');
  vm.runInContext(source.slice(filterStart, source.indexOf('    // 按空间分组渲染', filterStart)), ctx);
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
