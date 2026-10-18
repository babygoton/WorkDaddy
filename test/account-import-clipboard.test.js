'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../scripts/inject.js'), 'utf8');
const start = source.indexOf('    function copyPlainText(');
const end = source.indexOf('\n    // 导出账号', start);
assert.ok(start >= 0 && end > start);

function loadClipboard(clipboard, { copied = true, copyThrows = false } = {}) {
  const children = new Set();
  const calls = [];
  const previousFocus = { focus() { calls.push('restore-focus'); document.activeElement = this; } };
  const document = {
    activeElement: previousFocus,
    createElement(tag) {
      assert.equal(tag, 'textarea');
      return {
        style: {},
        setAttribute() {},
        select() { document.activeElement = this; calls.push(['select', this.value]); },
        remove() { children.delete(this); },
      };
    },
    body: {
      appendChild(node) { children.add(node); },
      removeChild(node) { assert.ok(children.delete(node)); },
    },
    execCommand(command) {
      assert.equal(command, 'copy');
      calls.push('copy');
      if (copyThrows) throw new Error('legacy clipboard unavailable');
      return copied;
    },
  };
  const context = { navigator: { clipboard }, document };
  vm.runInNewContext(source.slice(start, end) + '\nthis.copy = copyPlainText;', context);
  return { copy: context.copy, calls, children, document, previousFocus };
}

const prompt = '请整理成 WorkDaddy 可导入的 JSON。\n只输出 JSON。';

test('account import copy uses the native clipboard when writing succeeds', async () => {
  const writes = [];
  const fixture = loadClipboard({ writeText(text) { writes.push(text); return Promise.resolve(); } });
  await fixture.copy(prompt);
  assert.deepEqual(writes, [prompt]);
  assert.deepEqual(fixture.calls, []);
  assert.equal(fixture.children.size, 0);
});

for (const [name, clipboard] of [
  ['clipboard permission denied', { writeText() { return Promise.reject(Object.assign(new Error('Write permission denied'), { name: 'NotAllowedError' })); } }],
  ['clipboard throws synchronously', { writeText() { throw new Error('clipboard unavailable'); } }],
  ['clipboard API absent', undefined],
]) {
  test(`account import copy falls back when ${name} and restores modal focus`, async () => {
    const fixture = loadClipboard(clipboard);
    await fixture.copy(prompt);
    assert.deepEqual(fixture.calls, [['select', prompt], 'copy', 'restore-focus']);
    assert.equal(fixture.children.size, 0);
    assert.equal(fixture.document.activeElement, fixture.previousFocus);
  });
}

for (const copyThrows of [false, true]) {
  test(`account import copy reports failure and cleans up when fallback ${copyThrows ? 'throws' : 'returns false'}`, async () => {
    const fixture = loadClipboard({ writeText() { return Promise.reject(new Error('denied')); } }, { copied: false, copyThrows });
    await assert.rejects(fixture.copy(prompt), /复制失败/);
    assert.deepEqual(fixture.calls, [['select', prompt], 'copy', 'restore-focus']);
    assert.equal(fixture.children.size, 0);
    assert.equal(fixture.document.activeElement, fixture.previousFocus);
  });
}

test('account import copy button uses the tested clipboard helper', () => {
  const start = source.indexOf('    function openAccountImportChoice(');
  const end = source.indexOf('    function formatTokenCount(', start);
  assert.ok(start >= 0 && end > start);
  assert.match(source.slice(start, end), /copyBtn\.addEventListener\('click',[\s\S]*?copyPlainText\(prompt\)\.then\(/);
});
