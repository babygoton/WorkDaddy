'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'daemon.js'), 'utf8');
const start = source.indexOf('async function sendStashToComposer(record) {');
const end = source.indexOf('\n/**', start);
assert.ok(start >= 0 && end > start);

function harness(hasContent, failSelect = false) {
  const calls = [];
  let evaluations = 0;
  const context = {
    cdp: { connected: true },
    log() {},
    waitAiIdle: async () => true,
    setTimeout: (callback) => callback(),
    cdpSend: async (method, params) => {
      calls.push({ method, params });
      if (method === 'Runtime.evaluate') {
        evaluations++;
        const value = evaluations === 1 ? { ok: true }
          : evaluations === 2 ? { ok: true, hasContent }
          : { ok: true, x: 100, y: 100 };
        return { result: { value } };
      }
      if (failSelect && params.commands?.includes('selectAll')) throw new Error('selection failed');
      return {};
    },
    cdpMouseClick: async () => calls.push({ method: 'submit' }),
  };
  vm.runInNewContext(source.slice(start, end), context);
  return { calls, send: (text) => context.sendStashToComposer({ content: { text, items: [] } }) };
}

test('quick phrase replaces a draft using a renderer edit command without macOS menu shortcuts', async () => {
  const { calls, send } = harness(true);
  assert.equal((await send('replacement')).sent, true);
  const inputs = calls.filter(({ method }) => method.startsWith('Input.') || method === 'submit');
  assert.deepEqual(Array.from(inputs[0].params.commands || []), ['selectAll']);
  assert.equal(inputs[0].params.type, 'rawKeyDown');
  assert.equal(inputs[0].params.modifiers || 0, 0, 'must not invoke Cmd+A through native menus');
  assert.equal(inputs[0].params.nativeVirtualKeyCode, undefined);
  const deletion = inputs.findIndex(({ params }) => params?.key === 'Backspace' && params.type === 'keyDown');
  const insertion = inputs.findIndex(({ method }) => method === 'Input.insertText');
  assert.ok(deletion > 0 && insertion > deletion, 'select, delete, then insert');
  for (const { params } of inputs.filter(({ params }) => params?.key === 'Backspace')) {
    assert.notEqual(params.nativeVirtualKeyCode, 8, 'Windows Backspace is macOS C, not Delete');
  }
  assert.equal(inputs[insertion].params.text, 'replacement');
  assert.equal(inputs.at(-1).method, 'submit');
});

test('empty composer skips clearing and multiline phrases retain Shift+Enter', async () => {
  const { calls, send } = harness(false);
  await send('first\nsecond');
  assert.equal(calls.some(({ params }) => params?.commands || params?.key === 'Backspace'), false);
  assert.deepEqual(calls.filter(({ method }) => method === 'Input.insertText').map(({ params }) => params.text), ['first', 'second']);
  const enter = calls.filter(({ params }) => params?.key === 'Enter');
  assert.deepEqual(enter.map(({ params }) => [params.type, params.modifiers]), [['keyDown', 8], ['keyUp', 8]]);
});

test('failed selection aborts before deleting, inserting or submitting', async () => {
  const { calls, send } = harness(true, true);
  await assert.rejects(send('replacement'), /selection failed/);
  assert.equal(calls.some(({ method, params }) => method === 'submit' || method === 'Input.insertText' || params?.key === 'Backspace'), false);
});

function guardedComposerHarness({ draft = '', attachment = false } = {}) {
  const calls = [];
  const editor = {
    innerText: 'Ask WorkBuddy anything\u200b' + draft,
    focus() {}, scrollIntoView() {},
    getBoundingClientRect: () => ({ width: 400, height: 80, bottom: 400 }),
    querySelector: () => attachment ? {} : null,
    cloneNode() {
      const clone = { textContent: this.innerText };
      clone.querySelectorAll = () => [{ remove: () => { clone.textContent = draft; } }];
      return clone;
    },
  };
  const dom = { document: { querySelector: () => null, querySelectorAll: () => [editor] }, window: { getSelection: () => null } };
  const context = { cdp: { connected: true }, log() {}, waitAiIdle: async () => true, setTimeout: fn => fn(),
    cdpSend: async (method, params) => {
      calls.push(method);
      if (method !== 'Runtime.evaluate') return {};
      // Execute both real composer expressions; only the final send-button lookup is stubbed.
      const value = params.expression.includes('official-send-button') ? { ok: true, x: 1, y: 1 }
        : vm.runInNewContext(params.expression, dom);
      return { result: { value } };
    }, cdpMouseClick: async () => calls.push('submit'),
  };
  vm.runInNewContext(source.slice(start, end), context);
  return { calls, send: () => context.sendStashToComposer({ requireEmpty: true, content: { text: '1+1=', items: [] } }) };
}

test('automation sends from an empty Slate editor containing a visible placeholder', async () => {
  const h = guardedComposerHarness();
  assert.equal((await h.send()).sent, true);
  assert.ok(h.calls.includes('Input.insertText'));
  assert.equal(h.calls.at(-1), 'submit');
  assert.ok(!h.calls.includes('Input.dispatchKeyEvent'), 'placeholder must not trigger draft deletion');
});

test('automation still rejects real drafts and attachment-only editors before input', async () => {
  for (const options of [{ draft: 'my unsent draft' }, { attachment: true }]) {
    const h = guardedComposerHarness(options);
    await assert.rejects(h.send(), /会话输入框非空/);
    assert.ok(!h.calls.some(method => method.startsWith('Input.') || method === 'submit'));
  }
});

function delayedButtonHarness({ enableAfter = 3, cancelAfter = Infinity } = {}) {
  const calls = [];
  let probes = 0, evaluations = 0, guardChecks = 0;
  const button = {
    tagName: 'BUTTON',
    get disabled() { return probes < enableAfter; },
    hasAttribute: () => button.disabled,
    getAttribute: () => button.disabled ? 'true' : null,
    getBoundingClientRect: () => ({ x: 10, y: 10, width: 32, height: 32, bottom: 42 }),
    scrollIntoView() {},
  };
  button.parentElement = { children: [button] };
  const context = { cdp: { connected: true }, log() {}, waitAiIdle: async () => true, setTimeout: fn => fn(),
    cdpSend: async (method, params) => {
      calls.push(method);
      if (method !== 'Runtime.evaluate') return {};
      evaluations++;
      if (evaluations <= 2) return { result: { value: { ok: true, hasContent: false } } };
      probes++;
      const dom = {
        document: { querySelector: () => button, querySelectorAll: () => [] },
        getComputedStyle: () => ({ display: 'block', visibility: 'visible', borderRadius: '50%' }),
      };
      return { result: { value: vm.runInNewContext(params.expression, dom) } };
    }, cdpMouseClick: async () => calls.push('submit'),
  };
  vm.runInNewContext(source.slice(start, end), context);
  return { calls, probes: () => probes, send: () => context.sendStashToComposer({ requireEmpty: true, content: { text: '1+1=', items: [] }, guard: async () => { if (++guardChecks >= cancelAfter) throw Error('account changed'); } }) };
}

test('after an account switch, delayed official send readiness is awaited without retyping', async () => {
  // The first account is already ready; the next account needs several UI updates.
  for (const enableAfter of [1, 4]) {
    const h = delayedButtonHarness({ enableAfter });
    assert.equal((await h.send()).sent, true);
    assert.equal(h.probes(), enableAfter);
    assert.equal(h.calls.filter(m => m === 'Input.insertText').length, 1);
    assert.equal(h.calls.filter(m => m === 'submit').length, 1);
  }
});

test('a disabled official send button never falls through to an unrelated toolbar control', async () => {
  const h = delayedButtonHarness({ enableAfter: Infinity });
  await assert.rejects(h.send(), /发送按钮禁用/);
  assert.ok(h.probes() > 1 && h.probes() <= 51);
  assert.equal(h.calls.filter(m => m === 'Input.insertText').length, 1);
  assert.ok(!h.calls.includes('submit'));
});

test('changing account during readiness polling aborts without submitting or retyping', async () => {
  const h = delayedButtonHarness({ enableAfter: Infinity, cancelAfter: 7 });
  await assert.rejects(h.send(), /account changed/);
  assert.equal(h.calls.filter(m => m === 'Input.insertText').length, 1);
  assert.ok(!h.calls.includes('submit'));
});
