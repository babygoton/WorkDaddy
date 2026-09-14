'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../scripts/inject.js'), 'utf8');
const block = source.slice(source.indexOf('    var checkinRiskLoading ='), source.indexOf('    function setOpen(open, options)'));
const flush = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  const documentListeners = new Map(), disposers = [], calls = [];
  let children = [], pending = true, fail = false;
  const events = [];
  function element() {
    return { listeners: {}, disabled: false, hidden: true, isConnected: true,
      addEventListener(type, fn) { this.listeners[type] = fn; },
      focus() { document.activeElement = this; },
      contains(target) { return target === this || Object.values(this.nodes || {}).includes(target); },
      querySelector(selector) { return this.nodes[selector]; },
      remove() { children = children.filter(child => child !== this); this.isConnected = false; },
    };
  }
  const document = {
    activeElement: element(),
    createElement() {
      const mask = element();
      mask.nodes = Object.fromEntries(['[data-checkin-choice="cancel"]', '[data-checkin-choice="enable"]', '[role="alert"]', '[role="dialog"]'].map(s => [s, element()]));
      return mask;
    },
    addEventListener(type, fn) { documentListeners.set(type, fn); },
    removeEventListener(type) { documentListeners.delete(type); },
  };
  const context = { window: { dispatchEvent: e => events.push(e.type) }, CustomEvent: function (type) { this.type = type; }, document, alive: true, CAPS: { accounts: true, checkin: true }, state: { open: true },
    panel: { appendChild(mask) { children.push(mask); } }, registerDisposer: fn => disposers.push(fn),
    api: async (route, options) => {
      calls.push({ route, options });
      if (fail) throw new Error('offline');
      if (options) pending = false;
      return { shouldPrompt: pending, enabled: options ? JSON.parse(options.body).enabled : false };
    },
  };
  vm.createContext(context); vm.runInContext(block, context);
  return { context, calls, events, documentListeners, disposers, masks: () => children, fail: value => { fail = value; } };
}
for (const choice of ['cancel', 'enable']) test(`${choice} saves once; reopening and double clicks do not repeat`, async () => {
  const h = harness();
  h.context.showCheckinRiskOnOpen(); h.context.showCheckinRiskOnOpen(); await flush();
  assert.equal(h.masks().length, 1); assert.equal(h.calls.length, 1);
  const button = h.masks()[0].querySelector(`[data-checkin-choice="${choice}"]`);
  button.listeners.click(); button.listeners.click(); await flush();
  assert.equal(JSON.parse(h.calls[1].options.body).enabled, choice === 'enable');
  assert.deepEqual(h.events, choice === 'enable' ? ['workdaddy:accounts-updated'] : []);
  assert.equal(h.calls.length, 2); assert.equal(h.masks().length, 0); assert.equal(h.documentListeners.size, 0);
  h.context.showCheckinRiskOnOpen(); await flush(); assert.equal(h.calls.length, 2);
});
test('failed save stays retryable, Escape cancels, and reinjection removes listeners', async () => {
  const h = harness(); h.context.showCheckinRiskOnOpen(); await flush(); h.fail(true);
  h.masks()[0].querySelector('[data-checkin-choice="enable"]').listeners.click(); await flush();
  assert.equal(h.masks().length, 1); assert.equal(h.masks()[0].querySelector('[role="alert"]').hidden, false);
  h.fail(false); h.documentListeners.get('keydown')({ key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} }); await flush();
  assert.equal(JSON.parse(h.calls.at(-1).options.body).enabled, false); assert.equal(h.masks().length, 0);
  const second = harness(); second.context.showCheckinRiskOnOpen(); await flush();
  second.disposers.forEach(fn => fn()); assert.equal(second.masks().length, 0); assert.equal(second.documentListeners.size, 0);
});
test('late reads cannot show on closed panels, and unsupported clients skip the request', async () => {
  const h = harness(); h.context.showCheckinRiskOnOpen(); h.context.state.open = false; await flush(); assert.equal(h.masks().length, 0);
  h.context.state.open = true; h.context.showCheckinRiskOnOpen(); await flush(); assert.equal(h.masks().length, 1);
  const unsupported = harness(); unsupported.context.CAPS.checkin = false;
  unsupported.context.showCheckinRiskOnOpen(); await flush(); assert.equal(unsupported.calls.length, 0);
});
