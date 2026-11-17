'use strict';
// 侧边栏索引分组：纯逻辑（行归属、可见性判定）与接线契约
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const inject = fs.readFileSync(path.join(root, 'scripts', 'inject.js'), 'utf8');
const daemon = fs.readFileSync(path.join(root, 'scripts', 'daemon.js'), 'utf8');

function slice(start, end) {
  const from = inject.indexOf(start);
  assert.ok(from >= 0, 'missing ' + start);
  const to = inject.indexOf(end, from);
  assert.ok(to > from, 'missing ' + end);
  return inject.slice(from, to);
}

function loadPure() {
  const source = slice('function sgRowGroupPrefix(', 'function createSidebarGroups(');
  const ctx = { Set };
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  return ctx;
}

test('行 id 里的空间前缀能被正确切出来', () => {
  const ctx = loadPure();
  assert.equal(ctx.sgRowGroupPrefix('grouped-sub-space:abc::card::x'), 'grouped-sub-space:abc::');
  assert.equal(ctx.sgRowGroupPrefix('grouped-sub-space:abc::header'), 'grouped-sub-space:abc::');
  assert.equal(ctx.sgRowGroupPrefix('grouped-local::card::x'), 'grouped-local::');
  assert.equal(ctx.sgRowGroupPrefix(''), '');
  assert.equal(ctx.sgSpaceIdOfPrefix('grouped-sub-space:abc::'), 'abc');
  assert.equal(ctx.sgSpaceIdOfPrefix('grouped-local::'), '');
  assert.equal(ctx.sgSpaceIdOfPrefix(''), '');
});

test('选中分组时只有成员目录的行留下', () => {
  const ctx = loadPure();
  const selection = { mode: 'group', members: new Set(['D:/media/a']), union: new Set(['D:/media/a']) };
  assert.equal(ctx.sgRowKeeps('D:/media/a', selection), true);
  assert.equal(ctx.sgRowKeeps('D:/media/b', selection), false);
});

test('未分组视图收的正好是所有分组之外的目录', () => {
  const ctx = loadPure();
  const selection = { mode: 'unassigned', members: new Set(), union: new Set(['D:/media/a']) };
  assert.equal(ctx.sgRowKeeps('D:/media/b', selection), true);
  assert.equal(ctx.sgRowKeeps('D:/media/a', selection), false);
  // 认不出目录的行算未分组，不能被误判成成员
  assert.equal(ctx.sgRowKeeps('', selection), true);
});

test('全部视图不隐藏任何行', () => {
  const ctx = loadPure();
  const all = { mode: 'all', members: new Set(['D:/x']), union: new Set(['D:/x']) };
  assert.equal(ctx.sgRowKeeps('D:/y', all), true);
  assert.equal(ctx.sgRowKeeps('', all), true);
});

test('分组条挂在宿主的「分组」标题之后，不去改标题行本身', () => {
  assert.match(inject, /label\.insertAdjacentElement\('afterend', barEl\)/);
  assert.match(inject, /data-sg-select/);
  assert.match(inject, /data-sg-manage/);
  const module = slice('function createSidebarGroups(', 'function createBuildLifecycle(');
  // 只改行内联 display，不搬动宿主的会话节点
  assert.match(module, /el\.style\.display = 'none'/);
  assert.doesNotMatch(module, /\.appendChild\((card|header|row)\)/);
});

test('分组条不会自激重建（否则点不中按钮）', () => {
  const module = slice('function createSidebarGroups(', 'function createBuildLifecycle(');
  // 每次重写 innerHTML 都会把按下中的按钮换掉，click 就发不出来
  assert.match(module, /if \(barEl\.innerHTML !== html\) barEl\.innerHTML = html/);
  // 自己的 chip 变化不能再触发观察者，否则「重写 -> 通知 -> 重写」
  assert.match(module, /closest\('\.wbs-sg-bar'\)\) continue/);
});

test('只看「分组」区，「最近」不受影响', () => {
  const module = slice('function createSidebarGroups(', 'function createBuildLifecycle(');
  // 「最近」是跨目录的时间列表，跟着分组一起清空会让人找不到刚做的任务
  assert.match(module, /content\.querySelector\('\.conversation-section-groups'\) \|\| content/);
  assert.match(module, /scope\.querySelectorAll\('\.conversation-item/);
  assert.match(module, /if \(!scope\.contains\(el\)\)/);
});

test('空间 id 与目录的映射由 daemon 只读提供', () => {
  assert.match(daemon, /p === '\/api\/spaces'/);
  assert.match(daemon, /FROM spaces/);
  // 该表的 deleted_at 用负数表示未删除，只写 IS NULL 会一条都取不到
  assert.match(daemon, /deleted_at IS NULL OR deleted_at < 0/);
});
