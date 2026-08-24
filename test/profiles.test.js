'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { PROFILES, getProfile, profileDataDir } = require('../scripts/profiles.js');

// 跨平台路径后缀匹配：Windows 用 \，POSIX 用 /
function pathEndsWith(p, suffix) {
  const norm = p.split(path.sep).join('/');
  return norm.endsWith(suffix);
}

test('四个客户端 profile 使用独立数据源和能力开关', () => {
  assert.deepEqual(Object.keys(PROFILES).sort(), ['codebuddy-cn', 'codebuddy-intl', 'workbuddy-ai', 'workbuddy-cn']);
  assert.equal(pathEndsWith(getProfile('workbuddy-ai').sessionDb, '.workbuddy-ai/workbuddy.db'), true);
  assert.equal(pathEndsWith(getProfile('codebuddy-cn').sessionDb, 'CodeBuddy CN/codebuddy-sessions.vscdb'), true);
  assert.equal(pathEndsWith(getProfile('codebuddy-intl').sessionDb, 'CodeBuddy/codebuddy-sessions.vscdb'), true);
  assert.equal(getProfile('workbuddy-cn').capabilities.theme, true);
  assert.equal(getProfile('workbuddy-ai').capabilities.theme, true);
  assert.equal(getProfile('codebuddy-cn').capabilities.stashPrompt, false);
});

test('WorkBuddy AI enables the theme capability alongside domestic WorkBuddy', () => {
  assert.equal(PROFILES['workbuddy-cn'].capabilities.theme, true);
  assert.equal(PROFILES['workbuddy-ai'].capabilities.theme, true);
  assert.equal(PROFILES['codebuddy-cn'].capabilities.theme, false);
  assert.equal(PROFILES['codebuddy-intl'].capabilities.theme, false);
});

test('各 profile 的 API host 与 auth.domain 一致（签到/积分/无感登录）', () => {
  assert.equal(getProfile('workbuddy-cn').apiHost, 'https://www.codebuddy.cn');
  assert.equal(getProfile('workbuddy-ai').apiHost, 'https://www.workbuddy.ai');
  assert.equal(getProfile('codebuddy-cn').apiHost, 'https://www.codebuddy.cn');
  assert.equal(getProfile('codebuddy-intl').apiHost, 'https://www.codebuddy.ai');
});

test('默认 WorkBuddy 数据目录保持兼容，其他 profile 隔离到子目录', () => {
  const cn = getProfile('workbuddy-cn');
  const ai = getProfile('workbuddy-ai');
  // Windows: AppData/Roaming/WorkDaddy；macOS: Library/Application Support/WorkDaddy
  assert.equal(pathEndsWith(profileDataDir(cn), 'WorkDaddy'), true);
  assert.equal(pathEndsWith(profileDataDir(ai), 'WorkDaddy/profiles/workbuddy-ai'), true);
});

test('CodeBuddy CN/Intl 启用账户切换并指向 CodeBuddyExtension 共享凭证文件', () => {
  // CodeBuddy CN/Intl 现在共用 CodeBuddyExtension 共享认证目录的凭证文件
  // （Tencent-Cloud.coding-copilot.info，与 CodeBuddy CLI 同文件同格式）
  const cn = getProfile('codebuddy-cn');
  const intl = getProfile('codebuddy-intl');
  assert.ok(cn.authFile, 'codebuddy-cn authFile 不应为空');
  assert.ok(pathEndsWith(cn.authFile, 'CodeBuddyExtension/Data/Public/auth/Tencent-Cloud.coding-copilot.info'));
  assert.ok(intl.authFile, 'codebuddy-intl authFile 不应为空');
  assert.ok(pathEndsWith(intl.authFile, 'CodeBuddyExtension/Data/Public/auth/Tencent-Cloud.coding-copilot.info'));
  assert.equal(cn.capabilities.accounts, true, 'codebuddy-cn 应启用 accounts 能力');
  assert.equal(intl.capabilities.accounts, true, 'codebuddy-intl 应启用 accounts 能力');
  // 国际版与 CN 版凭证文件名相同（扩展 ID 不变），仅 API host 不同
  assert.equal(path.basename(cn.authFile), path.basename(intl.authFile));
});

test('WorkBuddy 桌面端凭证文件与 CodeBuddy 凭证文件位于同一 auth 目录', () => {
  // workbuddy-desktop.info 与 Tencent-Cloud.coding-copilot.info 都在
  // CodeBuddyExtension/Data/Public/auth/ 目录下，由共享组件管理
  const wb = getProfile('workbuddy-cn');
  const cb = getProfile('codebuddy-cn');
  assert.equal(path.dirname(wb.authFile), path.dirname(cb.authFile),
    'WorkBuddy 与 CodeBuddy 凭证文件应在同一目录');
});
