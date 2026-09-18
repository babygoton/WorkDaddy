'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PROFILES } = require('../scripts/profiles.js');
const { normalizeTargetUrl, classifyTarget, looksLikeWbFamilyTarget, isTargetForProfile } = require('../scripts/cdp-targets.js');

const AI_URL = 'file:///Applications/WorkBuddy%20AI.app/Contents/Resources/app.asar/renderer/index.html';
const CN_URL = 'file:///Applications/WorkBuddy.app/Contents/Resources/app.asar/renderer/index.html';
const CB_CN_URL = 'file:///Applications/CodeBuddy%20CN.app/Contents/Resources/app/renderer/index.html';
const CB_INTL_URL = 'file:///Applications/CodeBuddy.app/Contents/Resources/app/renderer/index.html';
const VSCODE_URL = 'vscode-file://vscode-app/Applications/CodeBuddy.app/Contents/Resources/app/out/vs/code/electron-sandbox/workbench/workbench.html';

test('normalizeTargetUrl 把 %20 还原为空格', () => {
  assert.equal(normalizeTargetUrl(AI_URL), AI_URL.replace(/%20/g, ' '));
  assert.equal(normalizeTargetUrl('WorkBuddy AI.app'), 'WorkBuddy AI.app');
});

test('classifyTarget 依据 app 包路径识别四客户端（含 %20 编码）', () => {
  assert.equal(classifyTarget(AI_URL, 'WorkBuddy AI'), 'workbuddy-ai');
  assert.equal(classifyTarget(CN_URL, 'WorkBuddy'), 'workbuddy-cn');
  assert.equal(classifyTarget(CB_CN_URL, 'CodeBuddy'), 'codebuddy-cn');
  assert.equal(classifyTarget(CB_INTL_URL, 'CodeBuddy'), 'codebuddy-intl');
  // 标题兜底不得覆盖 app 路径强信号：AI 页面标题即使叫 "WorkBuddy"，仍归属 workbuddy-ai
  assert.equal(classifyTarget(AI_URL, 'WorkBuddy'), 'workbuddy-ai');
});

test('classifyTarget 依据登录域名识别国际版/国内版', () => {
  assert.equal(classifyTarget('https://www.workbuddy.ai/profile/plans-usage', ''), 'workbuddy-ai');
  assert.equal(classifyTarget('https://www.workbuddy.cn/profile/plans-usage', ''), 'workbuddy-cn');
  assert.equal(classifyTarget('https://www.codebuddy.cn/v2/plugin/auth/state', ''), 'codebuddy-cn');
  assert.equal(classifyTarget('https://www.codebuddy.ai/v2/plugin/auth/state', ''), 'codebuddy-intl');
  assert.equal(classifyTarget('https://example.com/other', ''), null);
});

test('isTargetForProfile 强信号下拒绝所有异 profile 页面', () => {
  const ai = PROFILES['workbuddy-ai'];
  const cn = PROFILES['workbuddy-cn'];
  // AI daemon 只认 AI 页面
  assert.equal(isTargetForProfile({ type: 'page', url: AI_URL, title: 'WorkBuddy' }, ai), true);
  assert.equal(isTargetForProfile({ type: 'page', url: CN_URL, title: 'WorkBuddy' }, ai), false);
  // CN daemon 只认 CN 页面 —— 不再被 AI 页面标题 "WorkBuddy" 骗走
  assert.equal(isTargetForProfile({ type: 'page', url: CN_URL, title: 'WorkBuddy' }, cn), true);
  assert.equal(isTargetForProfile({ type: 'page', url: AI_URL, title: 'WorkBuddy' }, cn), false);
  // CodeBuddy 页面与 WorkBuddy 页面互不认领
  assert.equal(isTargetForProfile({ type: 'page', url: CB_INTL_URL, title: 'CodeBuddy' }, ai), false);
  assert.equal(isTargetForProfile({ type: 'page', url: AI_URL, title: 'WorkBuddy' }, PROFILES['codebuddy-intl']), false);
});

test('isTargetForProfile CodeBuddy 走宽松分支（vscode-file 目标）', () => {
  const intl = PROFILES['codebuddy-intl'];
  assert.equal(isTargetForProfile({ type: 'page', url: VSCODE_URL, title: 'CodeBuddy' }, intl), true);
  // 明确属于 CodeBuddy CN app 的路径不被国际版认领
  assert.equal(isTargetForProfile({ type: 'page', url: CB_CN_URL, title: 'CodeBuddy CN' }, intl), false);
  // devtools / chrome 内部页不算
  assert.equal(isTargetForProfile({ type: 'page', url: 'devtools://devtools/bundled/inspector.html', title: '' }, intl), false);
});

test('isTargetForProfile 未绑定 workbuddy daemon 禁止裸标题匹配（防误连 AI）', () => {
  const prev = process.env.WBSWITCH_PROFILE;
  delete process.env.WBSWITCH_PROFILE;
  try {
    const cn = PROFILES['workbuddy-cn'];
    // 无 URL 强信号（如远程 OAuth 页）+ 标题 "WorkBuddy"：未绑定时必须拒绝，避免错杀/误连
    assert.equal(isTargetForProfile({ type: 'page', url: 'https://account.example.com/login', title: 'WorkBuddy' }, cn), false);
    // 有 URL 强信号时不受影响
    assert.equal(isTargetForProfile({ type: 'page', url: CN_URL, title: 'WorkBuddy' }, cn), true);
  } finally {
    if (prev) process.env.WBSWITCH_PROFILE = prev;
  }
});

test('isTargetForProfile 已绑定 profile 时允许标题兜底', () => {
  const prev = process.env.WBSWITCH_PROFILE;
  process.env.WBSWITCH_PROFILE = 'workbuddy-ai';
  try {
    const ai = PROFILES['workbuddy-ai'];
    assert.equal(isTargetForProfile({ type: 'page', url: 'file:///some/unknown/root.html', title: 'WorkBuddy AI' }, ai), true);
  } finally {
    if (prev) process.env.WBSWITCH_PROFILE = prev;
  }
});

test('isTargetForProfile 企业配置只接受自身域名或路径提示', () => {
  const enterprise = {
    ...PROFILES['workbuddy-cn'],
    customTarget: true,
    apiHost: 'https://api.ent.example.com',
    targetHints: ['workbuddy-ent'],
  };
  assert.equal(isTargetForProfile({
    type: 'page', url: 'https://api.ent.example.com/app', title: '企业 WorkBuddy',
  }, enterprise), true);
  assert.equal(isTargetForProfile({
    type: 'page', url: 'file:///C:/Company/workbuddy-ent/resources/index.html', title: 'WorkBuddy',
  }, enterprise), true);
  assert.equal(isTargetForProfile({
    type: 'page', url: 'https://www.workbuddy.cn/app', title: 'WorkBuddy',
  }, enterprise), false);
  assert.equal(isTargetForProfile({
    type: 'page', url: 'file:///unknown/index.html', title: 'WorkBuddy',
  }, enterprise), false);
});

test('isTargetForProfile Linux 双实例：CN 与 AI 互不认领（两端可执行文件同名 workbuddy）', () => {
  // 真实事故：CN 与海外版是同一构建的两个副本，可执行文件都叫 workbuddy。
  // 企业/自定义目标的 targetHints 里若写裸应用名 'workbuddy'，海外版会把国内版的
  // 页面认成自己的注入目标 → 跨实例注入（守护进程挂到了另一个客户端上）。
  // 修复：targetHints 改用「安装目录 + 端专属标记」，两者在页面 URL 之间互不包含。
  const linuxCnUrl = 'file:///opt/WorkBuddy/resources/app.asar/renderer/index.html';
  const linuxAiUrl = 'file:///home/u/.local/share/workbuddy-ai/app/workbuddy/resources/app.asar/renderer/index.html';

  const cnProfile = { ...PROFILES['workbuddy-cn'] };
  const aiProfile = {
    ...PROFILES['workbuddy-ai'],
    customTarget: true,
    apiHost: 'https://www.workbuddy.ai',
    targetHints: ['/home/u/.local/share/workbuddy-ai/app', 'workbuddy-ai'],
  };

  assert.equal(isTargetForProfile({ type: 'page', url: linuxCnUrl, title: 'WorkBuddy' }, cnProfile), true);
  assert.equal(isTargetForProfile({ type: 'page', url: linuxAiUrl, title: 'WorkBuddy' }, cnProfile), false);
  assert.equal(isTargetForProfile({ type: 'page', url: linuxAiUrl, title: 'WorkBuddy' }, aiProfile), true);
  assert.equal(isTargetForProfile({ type: 'page', url: linuxCnUrl, title: 'WorkBuddy' }, aiProfile), false);

  // 反面样本：裸应用名会同时命中两端，因此不能作为自定义目标的提示
  const looseProfile = { ...aiProfile, targetHints: ['workbuddy'] };
  assert.equal(isTargetForProfile({ type: 'page', url: linuxCnUrl, title: 'WorkBuddy' }, looseProfile), true,
    '裸应用名会误认兄弟端——这正是本用例要防住的写法');
});

test('looksLikeWbFamilyTarget 把四客户端页面都视为同族（不清理）', () => {
  assert.equal(looksLikeWbFamilyTarget({ type: 'page', url: AI_URL, title: 'WorkBuddy' }), true);
  assert.equal(looksLikeWbFamilyTarget({ type: 'page', url: CN_URL, title: 'WorkBuddy' }), true);
  assert.equal(looksLikeWbFamilyTarget({ type: 'page', url: CB_CN_URL, title: '' }), true);
  assert.equal(looksLikeWbFamilyTarget({ type: 'page', url: VSCODE_URL, title: 'CodeBuddy' }), true);
  // 任意其他 Chromium 应用不算同族（允许清理历史误注入）
  assert.equal(looksLikeWbFamilyTarget({ type: 'page', url: 'file:///Applications/Antigravity.app/Contents/index.html', title: 'Antigravity' }), false);
});
