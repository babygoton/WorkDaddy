'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('batch mode keeps the header visible and disables controls until cancelled', () => {
  const inject = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'inject.js'), 'utf8');
  const controls = Array.from({ length: 7 }, () => ({ disabled: false, style: { display: '' }, classList: { toggle() {} } }));
  const auto = { disabled: false, style: { display: '' }, classList: { toggle() {} }, setAttribute() {} };
  const count = { style: { display: '' } };
  const bar = { style: { display: 'none' } };
  const nodes = { '#wbs-sess-batchbar': bar, '#wbs-sess-batch': controls[0], '#wbs-sess-import': controls[1], '#wbs-sess-auto-all': auto, '#wbs-sess-count': count };
  const state = { batchMode: true, autoCopyAll: true };
  const context = vm.createContext({ sessionsState: state, sessionsPane: {
    querySelector: selector => nodes[selector],
    querySelectorAll: selector => {
      assert.match(selector, /wbs-sess-filters/);
      assert.match(selector, /select/);
      return [...controls, auto];
    },
  } });
  const extract = (start, end) => inject.slice(inject.indexOf(start), inject.indexOf(end, inject.indexOf(start)));
  vm.runInContext(extract('function updateAutoCopyAllButton()', 'function toggleAutoCopyAll(') + extract('function setSessBatchBar(on)', 'function wireSessionsPane()'), context);
  context.setSessBatchBar(true);
  for (const control of [...controls, auto]) {
    assert.equal(control.disabled, true);
    assert.equal(control.style.display, '');
  }
  assert.equal(count.style.display, '');
  assert.equal(bar.style.display, 'flex');
  state.batchMode = false;
  state.autoCopyAllBusy = true;
  context.setSessBatchBar(false);
  assert.ok(controls.every(control => !control.disabled));
  assert.equal(auto.disabled, true, 'an in-flight sync setting must remain disabled');
  assert.equal(bar.style.display, 'none');
  state.autoCopyAllBusy = false;
  context.updateAutoCopyAllButton();
  assert.equal(auto.disabled, false);
  state.batchMode = true;
  context.updateAutoCopyAllButton();
  assert.equal(auto.disabled, true, 'async completion must not unlock the batch header');
});

test('session panel defaults its time filter to all sessions', () => {
  const inject = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'inject.js'), 'utf8');
  const paneStart = inject.indexOf('var sessionsState =');
  const paneEnd = inject.indexOf('function isTaskSessionRecordUI', paneStart);
  const state = inject.slice(paneStart, paneEnd);
  assert.match(state, /range:\s*'all'/);

  const rangeStart = inject.indexOf("id=\"wbs-sess-range-seg\"");
  const rangeEnd = inject.indexOf("'</div></div>'", rangeStart);
  const range = inject.slice(rangeStart, rangeEnd);
  assert.match(range, /data-range=\"all\">全部/);
  assert.match(range, /class=\"wbs-sess-seg-btn active\"[^>]*data-range=\"all\">全部<\/button>/);
  assert.doesNotMatch(range, /active[^>]*data-range=\"7d\"/);
});
