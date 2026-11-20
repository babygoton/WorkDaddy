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

test('成员目录下的子目录会话也算这个分组', () => {
  const ctx = loadPure();
  const selection = { mode: 'group', members: new Set(['D:/media/a']), union: new Set(['D:/media/a']) };
  assert.equal(ctx.sgRowKeeps('D:/media/a/sub/deep', selection), true);
  // 前缀要按目录边界判断，不能把 D:/media/ab 当成 D:/media/a 的子目录
  assert.equal(ctx.sgRowKeeps('D:/media/ab', selection), false);
  const unassigned = { mode: 'unassigned', members: new Set(), union: new Set(['D:/media/a']) };
  assert.equal(ctx.sgRowKeeps('D:/media/a/sub', unassigned), false);
});

test('会话卡片和所属目录用同一套判据', () => {
  const module = slice('function createSidebarGroups(', 'function createBuildLifecycle(');
  assert.match(module, /var path = cwd \|\| spacePath/);
  assert.match(module, /!!keepPrefix\[prefix\]/);
  assert.match(module, /sgSetHas\(new Set\(\[path\]\), member\)/);
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

test('宿主收起「分组」区时分组条一起收起', () => {
  const module = slice('function createSidebarGroups(', 'function createBuildLifecycle(');
  // :has() 里套 :has() 会让整条规则被解析器丢弃，这里必须是单层
  const rule = module.match(/'\.conversation-section-groups:has\([^']*\) \.wbs-sg-bar\{display:none\}'/);
  assert.ok(rule, 'missing collapse rule');
  assert.equal((rule[0].match(/:has\(/g) || []).length, 1);
  assert.match(rule[0], /conversation-section-chevron:not\(\.conversation-section-chevron-expanded\)/);
});

test('管理弹窗保留上次编辑的分组', () => {
  const module = slice('function createSidebarGroups(', 'function createBuildLifecycle(');
  // 每次打开都跳回第一个分组，改成员很容易改到别的组上
  assert.match(module, /editingId = state\.groups\.some\(function \(group\) \{ return group\.id === editingId; \}\)/);
});

test('整个组名是一个标签，管理操作只出现一次', () => {
  const controls = { innerHTML: '' };
  const ctx = vm.createContext({
    modalEl: { isConnected: true, querySelector: () => controls },
    state: { groups: [{ id: 'g-a', name: '甲' }, { id: 'g-b', name: '乙' }] },
    editingId: 'g-b', groupAction: '',
    t: value => value, esc: value => value, escAttr: value => value,
  });
  vm.runInContext(slice('  function groupIconButton(', '  function renderMembers()'), ctx);
  ctx.renderMembers = () => {};
  ctx.renderModal();
  assert.match(controls.innerHTML, /role="tab"[^>]*aria-selected="false"[^>]*>甲<\/button>/);
  assert.match(controls.innerHTML, /role="tab"[^>]*aria-selected="true"[^>]*>乙<\/button>/);
  assert.equal((controls.innerHTML.match(/data-sg-delete/g) || []).length, 1);
  assert.equal((controls.innerHTML.match(/data-sg-rename/g) || []).length, 1);
  assert.match(controls.innerHTML, /data-sg-rename title="重命名" aria-label="重命名"><svg/);
  assert.match(controls.innerHTML, /data-sg-delete title="删除" aria-label="删除"><svg/);
  assert.doesNotMatch(controls.innerHTML, /<input|编辑成员/);
});

test('新增入口放在弹窗标题栏，名称输入单独弹出', () => {
  const main = slice('  function openModal()', '  function openCreateGroup()');
  assert.match(main, /wbs-sg-title[\s\S]*groupIconButton\('open-create', '新增分组', 'plus', '[^']+', true\)/);
  assert.doesNotMatch(main, /data-sg-new/);
  const popup = slice('  function openCreateGroup()', '  function closeCreateGroup()');
  assert.match(popup, /role="dialog"[\s\S]*data-sg-new/);
  assert.match(popup, /\[data-sg-new\]'\)\.focus\(\)/);
});

test('点击意图在按下时记录，宿主重渲染不会吃掉这次点击', () => {
  const module = slice('function createSidebarGroups(', 'function createBuildLifecycle(');
  assert.match(module, /function onDocPointerDown\(/);
  assert.match(module, /function onDocPointerUp\(/);
  // 松手位置必须仍在分组条范围内，且移动超过 6px 视为拖动
  assert.match(module, /Math\.abs\(event\.clientX - tap\.x\) > 6/);
  assert.match(module, /if \(!bar\) return;/);
  // click 只留键盘路径，避免与指针序列重复执行
  assert.match(module, /event\.detail === 0 \|\| Date\.now\(\) - lastPointerAt > 400/);
});

test('存储损坏时先留档再重置', () => {
  const source = slice('function groupId()', 'function writeStore()');
  const store = {
    __data: { 'wbs.sidebarGroups.v2': '{ broken json' },
    getItem(k) { return Object.prototype.hasOwnProperty.call(this.__data, k) ? this.__data[k] : null; },
    setItem(k, v) { this.__data[k] = String(v); },
  };
  const ctx = vm.createContext({
    window: { localStorage: store },
    state: { groups: [{ id: 'x' }], selected: 'g-x' },
    STORE_KEY: 'wbs.sidebarGroups.v2',
    BACKUP_KEY: 'wbs.sidebarGroups.v2:corrupt',
    ALL: '__all__',
    Set, Object, Array, String, Date, JSON, Math, console,
    normalize: value => String(value || '').replace(/\\/g, '/'),
  });
  vm.runInContext(source, ctx);
  ctx.readStore();
  // 坏数据被忽略，内存状态退回空
  assert.equal(ctx.state.groups.length, 0);
  assert.equal(ctx.state.selected, '__all__');
  // 原始内容留在备份键里，可用于手工恢复
  const backup = JSON.parse(store.__data['wbs.sidebarGroups.v2:corrupt']);
  assert.equal(backup.length, 1);
  assert.equal(backup[0].raw, '{ broken json');
  assert.ok(backup[0].at);
});

test('备份只保留最近 3 份，不会无限增长', () => {
  const source = slice('function groupId()', 'function writeStore()');
  const store = {
    __data: { 'k': 'oops', 'k:corrupt': JSON.stringify([{ at: '1', raw: 'a' }, { at: '2', raw: 'b' }, { at: '3', raw: 'c' }]) },
    getItem(k) { return Object.prototype.hasOwnProperty.call(this.__data, k) ? this.__data[k] : null; },
    setItem(k, v) { this.__data[k] = String(v); },
  };
  const ctx = vm.createContext({
    window: { localStorage: store },
    state: { groups: [], selected: '__all__' },
    STORE_KEY: 'k', BACKUP_KEY: 'k:corrupt', ALL: '__all__',
    Set, Object, Array, String, Date, JSON, Math, console,
    normalize: v => String(v || ''),
  });
  vm.runInContext(source, ctx);
  ctx.readStore();
  const backup = JSON.parse(store.__data['k:corrupt']);
  assert.equal(backup.length, 3);
  assert.deepEqual(backup.map(e => e.raw), ['b', 'c', 'oops']);
});

let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); } catch (_) {}

test('侧边栏目录接口兼容两种数据库结构且只提供当前账号的会话名', { skip: !DatabaseSync }, async (t) => {
  const from = daemon.indexOf("  if (req.method === 'GET' && p === '/api/sidebar-groups/maps')");
  assert.ok(from >= 0);
  const to = daemon.indexOf('  // 会话空间列表', from);
  const route = vm.runInNewContext('(function (sqliteQuery, json, url, currentAccount) {' +
    "const req = { method: 'GET' }, p = '/api/sidebar-groups/maps', res = {}, PROFILE = { kind: 'workbuddy' };" +
    daemon.slice(from, to) + '})');

  for (const [name, schema, spaces] of [
    ['仅有 workspaces', "CREATE TABLE workspaces (path TEXT); INSERT INTO workspaces VALUES ('/empty');", [{ id: '', path: '/empty' }]],
    ['有 spaces', "CREATE TABLE spaces (id TEXT, primary_folder_path TEXT, create_folder_path TEXT, deleted_at INTEGER);" +
      "INSERT INTO spaces VALUES ('space', '', '/empty', -1), ('deleted', '/deleted', '', 1);", [{ id: 'space', path: '/empty' }]],
    ['仅有 sessions', '', []],
  ]) {
    await t.test(name, async () => {
      const db = new DatabaseSync(':memory:');
      try {
        db.exec("CREATE TABLE sessions (id TEXT, cwd TEXT, deleted_at INTEGER, user_id TEXT, title TEXT, custom_title TEXT, is_background_automation INTEGER);" +
          "INSERT INTO sessions VALUES ('session', '/active', NULL, 'current', 'Original', 'Renamed', 0)," +
          "('foreign', '/active', NULL, 'other', 'Private', '', 0)," +
          "('automation', '/active', NULL, 'current', 'Automation', '', 1)," +
          "('deleted', '/deleted', 1, 'current', 'Deleted', '', 0);" + schema);
        const run = (query, account) => route(async (sql, params = []) => db.prepare(sql).all(...params),
          (_, status, body) => [status, body], new URL('http://localhost/' + query), () => account);
        const result = await run('');
        assert.deepEqual(JSON.parse(JSON.stringify(result)), [200, {
          ok: true, sessions: ['session', 'foreign', 'automation'].map(id => ({ id, cwd: '/active' })), spaces,
        }]);
        const [, preview] = await run('?titles=1', { uid: 'current' });
        assert.deepEqual(JSON.parse(JSON.stringify(preview.sessionTitles)), [{ cwd: '/active', title: 'Renamed' }]);
        const [, signedOut] = await run('?titles=1');
        assert.deepEqual(JSON.parse(JSON.stringify(signedOut.sessionTitles)), []);
      } finally {
        db.close();
      }
    });
  }
});

test('成员目录预览包含子目录会话并转义会话标题', () => {
  const ctx = loadPure();
  Object.assign(ctx, {
    state: {
      workspaces: ['/work'],
      sessionTitles: [{ cwd: '/work/sub', title: '<会话>' }, { cwd: '/work-other', title: '不属于该目录' }],
    },
    esc: value => value.replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    escAttr: value => value,
    t: value => value,
  });
  vm.runInContext(slice('  function memberRow(', '  function renderModal('), ctx);
  const html = ctx.memberRow('/work', false);
  assert.match(html, /&lt;会话&gt;/);
  assert.doesNotMatch(html, /不属于该目录/);
});
