'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../scripts/inject.js'), 'utf8');

function harness(conflicts = true) {
  const nodes = {};
  function node() { return { classList: { add() {} }, style: {}, textContent: '', innerHTML: '', disabled: false, checked: false, focus() {}, addEventListener() {}, remove() {}, querySelector: key => nodes[key], querySelectorAll: () => [] }; }
  for (const key of ['.wbs-modal', '.wbs-modal-body', '.wbs-modal-title', '[data-third-ok]', '[data-third-cancel]', '[data-third-all]', '[data-third-count]', '[data-third-app]', '[data-third-list]']) nodes[key] = node();
  const calls = [];
  const ctx = vm.createContext({ document: { createElement: node }, modelsPane: { querySelector() { return null; }, appendChild() {} }, esc: String, escAttr: String, root: {}, toast() {}, loadModels() {}, api(route, options) { calls.push({ route, body: JSON.parse(options.body) }); return Promise.resolve(conflicts && !JSON.parse(options.body).confirmed ? { confirmationRequired: true, replaced: 1, duplicateIds: 0 } : { imported: 1 }); } });
  const start = source.indexOf('    function openThirdPartyModels(');
  vm.runInContext(source.slice(start, source.indexOf('    function wireModelsPane()', start)), ctx);
  return { ctx, nodes, calls };
}

const rows = [
  { key: 'a', providerKey: 'provider-a', provider: 'A', appType: 'claude', id: 'a', apiKey: 'fixture-key' },
  { key: 'b', providerKey: 'provider-b', provider: 'B', appType: 'claude', id: 'b', apiKey: 'fixture-key' },
  { key: 'c1', providerKey: 'provider-c', provider: 'C', appType: 'opencode', id: 'c1', apiKey: 'fixture-key' },
  { key: 'c2', providerKey: 'provider-c', provider: 'C', appType: 'opencode', id: 'c2', apiKey: 'fixture-key' },
];
function change(h, attr, value, checked) {
  h.nodes['.wbs-modal-body'].onchange({ target: { value, checked, disabled: false, hasAttribute: name => name === attr, getAttribute: () => value } });
}

test('filtered backend rows without available flags drive selection, counts and both confirmation steps', async () => {
  const h = harness(); h.ctx.openThirdPartyModels({ snapshot: 'fixture', models: rows });
  assert.equal(h.nodes['[data-third-count]'].textContent, '已选 2 / 2');
  assert.equal(h.nodes['[data-third-ok]'].disabled, false);
  change(h, 'data-third-all', '', false);
  assert.equal(h.nodes['[data-third-count]'].textContent, '已选 0 / 2');
  assert.equal(h.nodes['[data-third-ok]'].disabled, true);
  change(h, 'data-third-key', 'provider-b', true);
  assert.equal(h.nodes['[data-third-count]'].textContent, '已选 1 / 2');
  h.nodes['[data-third-ok]'].onclick();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].body.confirmed, false);
  await new Promise(resolve => setImmediate(resolve));
  h.nodes['[data-third-ok]'].onclick(); h.nodes['[data-third-ok]'].onclick();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].body.confirmed, true);
  assert.deepEqual(h.calls[1].body.ids, ['b']);
  await new Promise(resolve => setImmediate(resolve));
});

test('client filter imports only that client immediately when there are no conflicts', async () => {
  const h = harness(false); h.ctx.openThirdPartyModels({ snapshot: 'fixture', models: rows });
  change(h, 'data-third-app', 'opencode');
  assert.equal(h.nodes['[data-third-count]'].textContent, '已选 1 / 1');
  h.nodes['[data-third-ok]'].onclick();h.nodes['[data-third-ok]'].onclick();
  assert.deepEqual(h.calls[0].body.ids, ['c1', 'c2']);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].body.confirmed, false);
  await new Promise(resolve => setImmediate(resolve));
  assert.notEqual(h.nodes['.wbs-modal-title'].textContent, '确认覆盖同名模型？');
});

test('cancel after detected conflicts and empty lists never confirm a write', async () => {
  const h = harness(); h.ctx.openThirdPartyModels({ snapshot: 'fixture', models: rows });
  h.nodes['[data-third-ok]'].onclick();
  await new Promise(resolve => setImmediate(resolve));
  h.nodes['[data-third-cancel]'].onclick();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].body.confirmed, false);
  h.ctx.openThirdPartyModels({ snapshot: 'empty', models: [] });
  assert.equal(h.nodes['[data-third-count]'].textContent, '已选 0 / 0');
  assert.equal(h.nodes['[data-third-ok]'].disabled, true);
});
