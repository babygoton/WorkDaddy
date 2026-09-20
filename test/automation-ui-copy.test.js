'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../scripts/inject.js'), 'utf8');

test('automation toolbar has one V3 protocol command and keeps creation and batch actions at the right', () => {
  const start = source.indexOf('automationPane.innerHTML =');
  const end = source.indexOf('automationPane.querySelector', start);
  const toolbar = source.slice(start, end);
  assert.match(toolbar, /id="wbs-auto-cap">自动化接口协议 V3<\/button>/);
  assert.doesNotMatch(toolbar, /wbs-auto-api-version|查看接口说明/);
  assert.match(toolbar, /id="wbs-auto-pick"[\s\S]*class="wbs-auto-right-actions"[\s\S]*id="wbs-auto-create"[\s\S]*id="wbs-auto-batch"/);
  assert.match(source, /\.wbs-auto-right-actions\{[^}]*margin-left:auto/);
  assert.doesNotMatch(source, /'API V' \+ result\.schemaVersion/);
});

test('six session feature descriptions omit terminal Chinese periods', () => {
  const hints = [
    '检测到会话异常中断，自动让它继续',
    '暂存想法择机发送，发送后自动删除',
    '悬停预览，点击或拖动快速定位消息',
    '复制到这条回复为止的聊天内容，在当前工作区继续聊；原会话不变',
    '选中会话消息文字后，一键插入输入框',
    '发送后不会自动删除',
  ];
  for (const hint of hints) assert.ok(source.includes('<span class="wbs-nd-hint">' + hint + '</span>'), hint);
});
