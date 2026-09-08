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
