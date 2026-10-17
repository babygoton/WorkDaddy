'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../scripts/inject.js'), 'utf8');

function harness(nodes) {
  const document = {
    querySelectorAll(selector) {
      assert.equal(selector, 'aside.conversation-history-navigation');
      return nodes;
    },
  };
  const start = source.indexOf('function removeOfficialConversationHistoryNavigation(');
  const end = source.indexOf('\n    // 会话消息导航：', start);
  assert.ok(start >= 0 && end > start, 'official navigation cleanup helper missing');
  const context = { document };
  vm.runInNewContext(source.slice(start, end), context);
  return context.removeOfficialConversationHistoryNavigation;
}

test('message index cleanup removes every official history navigation regardless of parent path', () => {
  const removed = [];
  const nodes = [{ remove: () => removed.push(1) }, { remove: () => removed.push(1) }];
  const clean = harness(nodes);
  assert.equal(clean(false), 0);
  assert.equal(removed.length, 0);
  assert.equal(clean(true), 2);
  assert.equal(removed.length, 2);
});

test('message index cleanup is wired to enable and DOM rescan paths', () => {
  assert.match(source, /function setEnabled\(enabled\)[\s\S]*?removeOfficialConversationHistoryNavigation\(true\)/);
  assert.match(source, /function onDomChange\(\)[\s\S]*?removeOfficialConversationHistoryNavigation\(sessState\.messageNav\)/);
});
