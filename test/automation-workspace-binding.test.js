'use strict';
// 覆盖「新建会话落到指定工作区」：session.create 带 cwd / workspace 时，
// 必须走侧栏工作区自己的「新建任务」入口（hover-only 按钮），并在发送前校验绑定。
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');
const begin = source.indexOf('function normalizeAutomationWorkspaceCwd(');
const end = source.indexOf('let automationAgentCreating =', begin);
assert.ok(begin > 0 && end > begin, '无法定位工作区相关实现片段');
const slice = source.slice(begin, end);

// 「脚本化页面」替身：悬停让 hover-only 按钮显形，点击让新建任务页绑定到该工作区。
function harness({ workspaces = [], boundWorkspace = null, boundWorkspaceFull = null, newTaskReady = false, hasComposer = false, composerText = '', genericButton = null, bindOnClick = true, escapeFromRead = 0, escapeTo = null } = {}) {
  const state = {
    workspaces: workspaces.map((item) => ({ ...item })),
    boundWorkspace, boundWorkspaceFull, newTaskReady, hasComposer, composerText,
    button: genericButton,
  };
  let clock = 0, reads = 0;
  const calls = [];
  const find = (predicate) => state.workspaces.find(predicate);
  const read = () => {
    reads += 1;
    if (escapeFromRead && escapeTo && reads >= escapeFromRead) state.boundWorkspace = state.boundWorkspaceFull = escapeTo;
    return JSON.parse(JSON.stringify(state));
  };
  const ctx = {
    cdp: { connected: true },
    Date: { now: () => clock },
    sleep: async (ms) => { clock += Number(ms) || 0; },
    log: () => {},
    automationAgentSurfaceExpression: () => '({})',
    readAutomationAgentSurface: async () => read(),
    cdpMouseMove: async (source, x, y) => {
      const target = find((item) => item.header && item.header.x === x && item.header.y === y);
      calls.push('hover:' + (target ? target.displayName : `${x},${y}`));
      if (target) target.clickable = true;
    },
    cdpMouseClick: async (source, x, y) => {
      const target = find((item) => item.button && item.button.x === x && item.button.y === y);
      calls.push('click:' + (target ? target.displayName : `generic@${x},${y}`));
      if (target && bindOnClick) {
        state.boundWorkspace = target.displayName;
        state.boundWorkspaceFull = target.displayName;
        state.newTaskReady = true;
        state.hasComposer = true;
        state.composerText = '';
      } else if (!target) {
        // 通用「新建任务」入口同样会把页面带到新建任务态
        state.newTaskReady = true;
        state.hasComposer = true;
        state.composerText = '';
      }
    },
    cdpSend: async () => { calls.push('backup'); return { result: { value: { saved: true } } }; },
  };
  vm.runInNewContext(slice, ctx);
  return { calls, state, time: () => clock, run: (options) => ctx.ensureAutomationNewTask({ guard: () => {}, ...options }) };
}

const ws = (displayName, cwd, x, y) => ({ displayName, cwd, groupKey: 'grouped-sub-workdir:' + cwd, header: { x, y }, button: { x: x + 100, y }, clickable: false });

test('已绑定目标工作区时不再导航，直接复用当前新建任务页', async () => {
  const h = harness({ boundWorkspace: 'project-alpha', boundWorkspaceFull: 'project-alpha', newTaskReady: true, hasComposer: true, workspaces: [ws('project-alpha', '/repo/project-alpha', 1, 1)] });
  const surface = await h.run({ cwd: '/repo/project-alpha' });
  assert.deepEqual(h.calls, ['backup']);
  assert.equal(surface.boundWorkspace, 'project-alpha');
});

test('目标工作区的「新建任务」按钮是 hover-only：必须先悬停再点击', async () => {
  const h = harness({ workspaces: [ws('other', '/repo/other', 5, 5), ws('project-alpha', '/repo/project-alpha', 1, 1)] });
  const surface = await h.run({ cwd: '/repo/project-alpha' });
  assert.deepEqual(h.calls, ['hover:project-alpha', 'click:project-alpha', 'backup']);
  assert.equal(surface.boundWorkspace, 'project-alpha');
});

test('cwd 只差尾部分隔符时仍精确命中同一工作区', async () => {
  const h = harness({ workspaces: [ws('project-alpha', '/repo/project-alpha', 1, 1)] });
  await h.run({ cwd: '/repo/project-alpha/' });
  assert.deepEqual(h.calls, ['hover:project-alpha', 'click:project-alpha', 'backup']);
});

test('只给 workspace 名时按显示名匹配', async () => {
  const h = harness({ workspaces: [ws('project-beta', '/repo/project-beta', 3, 3)] });
  const surface = await h.run({ workspace: 'project-beta' });
  assert.deepEqual(h.calls, ['hover:project-beta', 'click:project-beta', 'backup']);
  assert.equal(surface.boundWorkspace, 'project-beta');
});

test('指定了工作目录时绝不点通用新建任务入口，避免把工作区切走', async () => {
  const h = harness({ workspaces: [ws('project-alpha', '/repo/project-alpha', 1, 1)], genericButton: { x: 77, y: 77 } });
  await h.run({ cwd: '/repo/project-alpha' });
  assert.ok(!h.calls.some((entry) => entry.includes('generic')), '不应点击通用入口，实际: ' + h.calls.join(' | '));
  assert.deepEqual(h.calls, ['hover:project-alpha', 'click:project-alpha', 'backup']);
});

test('未指定工作目录时行为不变，沿用通用入口', async () => {
  const h = harness({ genericButton: { x: 77, y: 77 }, workspaces: [ws('project-alpha', '/repo/project-alpha', 1, 1)] });
  const surface = await h.run({});
  assert.deepEqual(h.calls, ['click:generic@77,77', 'backup']);
  assert.equal(surface.boundWorkspace, null);
});

test('侧栏没有目标工作区时明确失败，且不触碰输入框、不退回默认目录', async () => {
  const h = harness({ workspaces: [ws('other', '/repo/other', 5, 5)] });
  await assert.rejects(h.run({ cwd: '/repo/missing' }), /未在侧栏找到工作区/);
  assert.ok(!h.calls.includes('backup'), '失败时不应进入草稿暂存');
  assert.ok(!h.calls.some((entry) => entry.startsWith('click:')), '失败时不应点击任何入口');
});

test('悬停后按钮仍不可点击时明确失败', async () => {
  const h = harness({ workspaces: [{ ...ws('project-alpha', '/repo/project-alpha', 1, 1) }] });
  h.state.workspaces[0].header = null;
  await assert.rejects(h.run({ cwd: '/repo/project-alpha' }), /缺少可悬停的标题/);
});

test('点击后绑定校验不通过则报错，不静默落到默认目录', async () => {
  const h = harness({ workspaces: [ws('project-alpha', '/repo/project-alpha', 1, 1)], bindOnClick: false });
  await assert.rejects(h.run({ cwd: '/repo/project-alpha' }), /绑定校验失败/);
  assert.ok(!h.calls.includes('backup'));
});

test('发送前最终校验：新建任务页被切到别的工作区则停止发送', async () => {
  // 导航阶段一切正常，落在最终校验之前把绑定切走
  const h = harness({ workspaces: [ws('project-alpha', '/repo/project-alpha', 1, 1)], escapeFromRead: 6, escapeTo: 'other' });
  await assert.rejects(h.run({ cwd: '/repo/project-alpha' }), /不一致/);
  assert.ok(!h.calls.includes('backup'), '最终校验失败前不应进入草稿暂存');
});

test('工作区显示名被侧栏截断时仍能确认绑定', async () => {
  const h = harness({ boundWorkspace: 'project-alpha-mob…', boundWorkspaceFull: 'project-alpha-mobile', newTaskReady: true, hasComposer: true, workspaces: [ws('project-alpha-mobile', '/repo/project-alpha-mobile', 1, 1)] });
  const surface = await h.run({ cwd: '/repo/project-alpha-mobile' });
  assert.equal(surface.boundWorkspace, 'project-alpha-mob…');
});

test('纯函数：cwd 归一化 / 条目匹配 / 标签匹配', async () => {
  const ctx = vm.createContext({ Date, cdp: {} });
  vm.runInContext(slice, ctx);
  assert.equal(ctx.normalizeAutomationWorkspaceCwd('/repo/project-alpha/'), '/repo/project-alpha');
  assert.equal(ctx.normalizeAutomationWorkspaceCwd('/repo/project-alpha///'), '/repo/project-alpha');
  assert.equal(ctx.normalizeAutomationWorkspaceCwd('  '), '');
  assert.equal(ctx.normalizeAutomationWorkspaceCwd('/'), '/');

  const entry = { cwd: '/repo/project-alpha', displayName: 'project-alpha' };
  assert.equal(ctx.automationWorkspaceEntryMatches(entry, '/repo/project-alpha', ''), true);
  assert.equal(ctx.automationWorkspaceEntryMatches(entry, '/repo/project-alpha/', ''), true);
  assert.equal(ctx.automationWorkspaceEntryMatches(entry, '/repo/other', ''), false);
  assert.equal(ctx.automationWorkspaceEntryMatches(entry, '', 'project-alpha'), true);
  assert.equal(ctx.automationWorkspaceEntryMatches(entry, '', 'other'), false);
  assert.equal(ctx.automationWorkspaceEntryMatches(null, '/repo/project-alpha', ''), false);

  assert.equal(ctx.automationWorkspaceLabelMatches('project-alpha', 'project-alpha'), true);
  assert.equal(ctx.automationWorkspaceLabelMatches('project-alpha-mob…', 'project-alpha-mobile'), true);
  assert.equal(ctx.automationWorkspaceLabelMatches('project-alpha-mob...', 'project-alpha-mobile'), true);
  assert.equal(ctx.automationWorkspaceLabelMatches('project-alpha', 'project-beta'), false);
  // 未截断的标签必须全等：互为前缀的工作区名不能互相顶包
  assert.equal(ctx.automationWorkspaceLabelMatches('project-alpha-mob', 'project-alpha-mobile'), false);
  assert.equal(ctx.automationWorkspaceLabelMatches('', 'project-alpha'), false);

  assert.equal(ctx.automationWorkspaceBoundMatches({ boundWorkspace: 'project-alpha' }, 'project-alpha'), true);
  assert.equal(ctx.automationWorkspaceBoundMatches({ boundWorkspace: 'project-alpha-mob…', boundWorkspaceFull: 'project-alpha-mobile' }, 'project-alpha-mobile'), true);
  assert.equal(ctx.automationWorkspaceBoundMatches({ boundWorkspace: 'other' }, 'project-alpha'), false);
  assert.equal(ctx.automationWorkspaceBoundMatches(null, 'project-alpha'), false);
});
