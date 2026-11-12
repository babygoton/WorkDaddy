'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'daemon.js'), 'utf8');
const start = source.indexOf('function reorderQuickPhrases(ids) {');
const end = source.indexOf('\nfunction normalizeQuickPhraseIds', start);
assert.ok(start >= 0 && end > start);

function createHarness() {
  let state = {
    stashEnabled: true,
    phraseEnabled: true,
    themeTakeoverEnabled: true,
    phrases: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }, { id: 'c', text: 'C' }],
  };
  const context = {
    readSessionState: () => structuredClone(state),
    writeSessionState(next) { state = structuredClone(next); },
  };
  vm.runInNewContext(source.slice(start, end), context);
  return { context, getState: () => state };
}

test('quick phrase reorder persists an exact permutation and keeps phrase records intact', () => {
  const h = createHarness();
  const result = h.context.reorderQuickPhrases(['c', 'a', 'b']);
  assert.deepEqual(Array.from(result.phrases, item => [item.id, item.text]), [['c', 'C'], ['a', 'A'], ['b', 'B']]);
  assert.deepEqual(Array.from(h.getState().phrases, item => item.id), ['c', 'a', 'b']);
});

test('quick phrase reorder rejects duplicates, missing IDs, and stale lists without writing', () => {
  for (const ids of [['a', 'a', 'c'], ['a', 'b'], ['a', 'b', 'other']]) {
    const h = createHarness();
    assert.throws(() => h.context.reorderQuickPhrases(ids), /无效|已变化/);
    assert.deepEqual(Array.from(h.getState().phrases, item => item.id), ['a', 'b', 'c']);
  }
});

test('quick phrase insert uses CDP text input and never invokes send', async () => {
  const start = source.indexOf('async function insertQuickPhraseIntoComposer(text) {');
  const end = source.indexOf('\nfunction normalizeQuickPhraseIds', start);
  const calls = [];
  const context = { cdp: { connected: true }, cdpSend: async (...args) => calls.push(args) };
  vm.runInNewContext(source.slice(start, end), context);
  assert.equal((await context.insertQuickPhraseIntoComposer('first\nsecond')).inserted, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'Input.insertText');
  assert.equal(calls[0][1].text, 'first\nsecond');
  context.cdp.connected = false;
  await assert.rejects(context.insertQuickPhraseIntoComposer('not inserted'), /CDP 未连接/);
  await assert.rejects(context.insertQuickPhraseIntoComposer('   '), /短语不能为空/);
  assert.equal(calls.length, 1);
});
