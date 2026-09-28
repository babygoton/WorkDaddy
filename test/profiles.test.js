'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { PROFILES, getProfile, profileDataDir, listInstalledModelSources } = require('../scripts/profiles.js');

test('模型导入始终列出其他三个客户端，未安装的来源保留为不可用选项', (t) => {
  t.mock.method(require('node:fs'), 'existsSync', () => false);
  for (const id of Object.keys(PROFILES)) {
    const sources = listInstalledModelSources(id);
    assert.deepEqual(sources.map(source => source.profileId).sort(), Object.keys(PROFILES).filter(other => other !== id).sort());
    assert.ok(sources.every(source => !source.available && !source.installed));
  }
});

test('四个客户端 profile 使用独立数据源和能力开关', () => {
  assert.deepEqual(Object.keys(PROFILES).sort(), ['codebuddy-cn', 'codebuddy-intl', 'workbuddy-ai', 'workbuddy-cn']);
  assert.equal(getProfile('workbuddy-ai').sessionDb.endsWith(path.join('.workbuddy-ai', 'workbuddy.db')), true);
  assert.equal(getProfile('codebuddy-cn').sessionDb.endsWith(path.join('CodeBuddy CN', 'codebuddy-sessions.vscdb')), true);
  assert.equal(getProfile('codebuddy-intl').sessionDb.endsWith(path.join('CodeBuddy', 'codebuddy-sessions.vscdb')), true);
  assert.equal(getProfile('codebuddy-cn').modelsFile.endsWith(path.join('.codebuddy', 'models.json')), true);
  assert.equal(getProfile('codebuddy-intl').modelsFile.endsWith(path.join('.codebuddy', 'models.json')), true);
  assert.equal(getProfile('workbuddy-cn').capabilities.theme, true);
  assert.equal(getProfile('workbuddy-ai').capabilities.theme, true);
  assert.equal(getProfile('codebuddy-cn').capabilities.stashPrompt, false);
  assert.match(getProfile('codebuddy-cn').authFile, /native-current\.info$/);
  assert.equal(getProfile('codebuddy-cn').capabilities.accounts, true);
  assert.equal(getProfile('codebuddy-cn').capabilities.models, true);
  assert.equal(getProfile('codebuddy-cn').capabilities.enhance, false);
});

test('WorkBuddy AI enables the theme capability alongside domestic WorkBuddy', () => {
  assert.equal(PROFILES['workbuddy-cn'].capabilities.theme, true);
  assert.equal(PROFILES['workbuddy-ai'].capabilities.theme, true);
  assert.equal(PROFILES['codebuddy-cn'].capabilities.theme, true);
  assert.equal(PROFILES['codebuddy-intl'].capabilities.theme, true);
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
  const cnDataDir = profileDataDir(cn);
  const aiDataDir = profileDataDir(ai);
  assert.equal(path.basename(cnDataDir), 'WorkDaddy');
  assert.equal(path.relative(cnDataDir, aiDataDir), path.join('profiles', 'workbuddy-ai'));
});
