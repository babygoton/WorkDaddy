'use strict';
// 覆盖「侧栏工作区分组的 cwd 位置变更」：新版 WorkBuddy 把 cwd 从平铺的 props.cwd
// 挪进了 props.row.subfolder.spaceMeta.primaryFolderPath。旧探针只认 props.cwd，
// 于是所有分组都被判成「没有 cwd」→ workspaces 为空 → 报「未在侧栏找到工作区」。
// 这里用脚本化 DOM 直接跑 automationAgentSurfaceExpression 的输出，验证四级兜底。
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');
const begin = source.indexOf('function automationAgentSurfaceExpression(');
const end = source.indexOf('async function readAutomationAgentSurface(', begin);
assert.ok(begin > 0 && end > begin, '无法定位 automationAgentSurfaceExpression');
const slice = source.slice(begin, end);
const ctx0 = { Math, Object, Array, String, JSON };
vm.runInNewContext(slice, ctx0);
const expressionOf = ctx0.automationAgentSurfaceExpression;

const FIBER_KEY = '__reactFiber$test';

function el(extra) {
  return Object.assign({
    tagName: 'DIV',
    className: '',
    innerText: '',
    textContent: '',
    closest: () => null,
    getAttribute: () => '',
    querySelector: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 24 }),
    contains: () => false,
  }, extra);
}

// 把 props 挂成一条 React fiber 链：元素 → fiber(memoizedProps) → 可选祖先
function withFiber(node, props, ancestors) {
  const chain = [{ memoizedProps: props }];
  for (const p of ancestors || []) chain.push({ memoizedProps: p });
  for (let i = 0; i < chain.length; i += 1) chain[i].return = chain[i + 1] || null;
  node[FIBER_KEY] = chain[0];
  return node;
}

function sectionFor(props, ancestors) {
  const btn = el({ className: 'workspace-new-task-button', getAttribute: () => '新建任务' });
  const header = el({ className: 'collapsible-section-header' });
  const section = el({
    className: 'collapsible-section',
    querySelector: (sel) => {
      if (sel === 'button.workspace-new-task-button') return btn;
      if (sel === '.collapsible-section-header') return header;
      return null;
    },
  });
  return withFiber(section, props, ancestors);
}

function runSurface(sections, picker) {
  const document = {
    querySelectorAll: (sel) => {
      if (sel === '.collapsible-section') return sections;
      return [];
    },
    querySelector: (sel) => (sel === '.cr-workspace-picker' ? picker || null : null),
    elementFromPoint: () => null,
  };
  const ctx = {
    document,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    window: { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) },
    Math, Object, Array, String, JSON,
  };
  return vm.runInNewContext(expressionOf(false), ctx);
}

test('cwd 挪到 row.subfolder.spaceMeta.primaryFolderPath 后仍能解析出工作区', () => {
  const props = { row: { subfolder: { spaceMeta: { primaryFolderPath: '/repo/project-alpha', name: 'project-alpha', spaceId: 'sp-1' } } } };
  const surface = runSurface([sectionFor(props)]);
  assert.equal(surface.workspaces.length, 1, '新版结构必须被识别，否则会退化成「侧栏未暴露工作区分组」');
  assert.equal(surface.workspaces[0].cwd, '/repo/project-alpha');
  assert.equal(surface.workspaces[0].displayName, 'project-alpha');
  assert.equal(surface.workspaces[0].groupKey, 'sp-1');
});

test('primaryFolderPath 缺失时回落到 createFolderPath', () => {
  const props = { row: { subfolder: { spaceMeta: { createFolderPath: '/repo/created' } } } };
  const surface = runSurface([sectionFor(props)]);
  assert.equal(surface.workspaces.length, 1);
  assert.equal(surface.workspaces[0].cwd, '/repo/created');
});

test('老版本平铺 props.cwd 行为不变', () => {
  const props = { cwd: '/repo/legacy', displayName: 'legacy', groupKey: 'grouped-sub-workdir:/repo/legacy' };
  const surface = runSurface([sectionFor(props)]);
  assert.equal(surface.workspaces.length, 1);
  assert.equal(surface.workspaces[0].cwd, '/repo/legacy');
  assert.equal(surface.workspaces[0].displayName, 'legacy');
});

test('props.spaceMeta 与 workspace.* 别名同样可用', () => {
  const surface = runSurface([
    sectionFor({ spaceMeta: { primaryFolderPath: '/repo/by-meta' } }),
    sectionFor({ workspace: { path: '/repo/by-workspace' } }),
  ]);
  // 跨 vm realm 的数组原型不同，deepStrictEqual 会误判，直接比内容
  assert.equal(Array.from(surface.workspaces).map((w) => w.cwd).join('|'), '/repo/by-meta|/repo/by-workspace');
});

test('纤层加深到 40 后，cwd 挂在更远祖先上也能读到', () => {
  const far = [];
  for (let i = 0; i < 20; i += 1) far.push({ unrelated: i });
  const props = { cwd: '/repo/deep', displayName: 'deep' };
  const surface = runSurface([sectionFor(props, far)]);
  assert.equal(surface.workspaces.length, 1);
  assert.equal(surface.workspaces[0].cwd, '/repo/deep');
});

test('整组都没有 cwd 时该组被跳过，不产生假工作区', () => {
  const surface = runSurface([sectionFor({ label: 'no-cwd-here' })]);
  assert.equal(surface.workspaces.length, 0);
});

test('工作区选择器的绑定 cwd 也认新结构', () => {
  const picker = withFiber(el({ className: 'cr-workspace-picker' }), { row: { subfolder: { spaceMeta: { primaryFolderPath: '/repo/bound' } } } });
  const surface = runSurface([], picker);
  assert.equal(surface.boundWorkspaceCwd, '/repo/bound');
});
