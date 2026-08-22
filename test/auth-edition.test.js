'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(repoRoot, 'scripts', name), 'utf8');
const lib = require(path.join(repoRoot, 'scripts', 'lib.js'));

// detectEdition 纯函数：用内存假 FS 驱动，不触碰真实用户目录
function fakeFs(files) {
  // files: { [absPath]: mtimeMs }
  return {
    exists: (p) => Object.prototype.hasOwnProperty.call(files, p),
    mtimeMs: (p) => files[p],
  };
}

test('detectEdition: 仅存在 AI 登录文件时锁定 ai 版本', () => {
  const { exists, mtimeMs } = fakeFs({ [lib.AUTH_FILES.ai]: 100 });
  assert.equal(lib.detectEdition(exists, mtimeMs), 'ai');
});

test('detectEdition: 仅存在国内版登录文件时锁定 cn 版本', () => {
  const { exists, mtimeMs } = fakeFs({ [lib.AUTH_FILES.cn]: 100 });
  assert.equal(lib.detectEdition(exists, mtimeMs), 'cn');
});

test('detectEdition: 双版本并存时取最近登录（mtime 新）的版本', () => {
  const newerAi = fakeFs({ [lib.AUTH_FILES.cn]: 100, [lib.AUTH_FILES.ai]: 200 });
  assert.equal(lib.detectEdition(newerAi.exists, newerAi.mtimeMs), 'ai');
  const newerCn = fakeFs({ [lib.AUTH_FILES.cn]: 300, [lib.AUTH_FILES.ai]: 200 });
  assert.equal(lib.detectEdition(newerCn.exists, newerCn.mtimeMs), 'cn');
});

test('detectEdition: 无任何登录文件时回退 cn（保持旧行为）', () => {
  const { exists, mtimeMs } = fakeFs({});
  assert.equal(lib.detectEdition(exists, mtimeMs), 'cn');
});

test('authEditionOf: 按登录文件名识别版本', () => {
  assert.equal(lib.authEditionOf(lib.AUTH_FILES.ai), 'ai');
  assert.equal(lib.authEditionOf(lib.AUTH_FILES.cn), 'cn');
  assert.equal(lib.authEditionOf(''), 'cn');
});

test('setEdition/authFileForEdition/resolveAuthFile: 锁定后登录文件跟随版本', () => {
  const prevEnv = process.env.WBSWITCH_AUTH_FILE;
  delete process.env.WBSWITCH_AUTH_FILE;
  try {
    lib.setEdition('ai');
    assert.equal(lib.currentEdition(), 'ai');
    assert.equal(lib.authFileForEdition('ai'), lib.AUTH_FILES.ai);
    assert.equal(lib.resolveAuthFile(), lib.AUTH_FILES.ai);
    lib.setEdition('cn');
    assert.equal(lib.resolveAuthFile(), lib.AUTH_FILES.cn);
    // 显式环境变量优先，行为与旧版一致
    const custom = path.join(os.tmpdir(), 'custom-auth.info');
    process.env.WBSWITCH_AUTH_FILE = custom;
    assert.equal(lib.resolveAuthFile(), custom);
    process.env.WBSWITCH_AUTH_FILE = prevEnv;
  } finally {
    if (prevEnv === undefined) delete process.env.WBSWITCH_AUTH_FILE;
    else process.env.WBSWITCH_AUTH_FILE = prevEnv;
    lib.setEdition('cn'); // 还原模块状态，避免影响同进程后续断言
  }
});

test('daemon: 无感登录端点与签到接口按版本区分 cn/ai 域名', () => {
  const daemon = read('daemon.js');
  assert.match(daemon, /WB_API_ENDPOINTS\s*=\s*\{[\s\S]*?cn:\s*'https:\/\/www\.codebuddy\.cn'[\s\S]*?ai:\s*'https:\/\/www\.workbuddy\.ai'/);
  assert.match(daemon, /CHECKIN_ENDPOINTS_BY_EDITION[\s\S]*?ai:\s*\[\s*'https:\/\/www\.workbuddy\.ai\/billing\/meter\/daily-checkin'/);
  // 不允许残留对已删除单域常量的引用
  assert.doesNotMatch(daemon, /\bWB_API_ENDPOINT\b/);
  assert.ok(!/\bCHECKIN_ENDPOINTS\b(?!_BY_EDITION)/.test(daemon), 'CHECKIN_ENDPOINTS 应已改为按版本路由');
});

test('daemon: 启动时探测环境并全程跟随（登录文件/进程名）', () => {
  const daemon = read('daemon.js');
  assert.match(daemon, /setEdition\(detectStartupEdition\(/);
  assert.match(daemon, /workBuddyImageName[\s\S]*?WorkBuddyAI\.exe/);
});

test('daemon: detectStartupEdition 不得引用在其调用点之后声明的 IS_WIN（TDZ 崩溃防回归）', () => {
  const daemon = read('daemon.js');
  const m = daemon.match(/function detectStartupEdition\(\)[\s\S]*?\n\}/);
  assert.ok(m, '应存在 detectStartupEdition 函数');
  assert.ok(!/\bIS_WIN\b/.test(m[0]), 'detectStartupEdition 内禁止引用 IS_WIN（其 const 声明在 setEdition 调用之后，首次安装时会 TDZ ReferenceError）');
});

test('daemon: 无感登录轮询使用发起时保存的 endpoint，避免跨版本轮询错域名', () => {
  const daemon = read('daemon.js');
  const m = daemon.match(/async function oauthPollOnce\(loginId\)[\s\S]*?\n\}/);
  assert.ok(m, '应存在 oauthPollOnce 函数');
  assert.match(m[0], /info\.endpoint\s*\|\|\s*wbApiEndpoint\(\)/);
  assert.doesNotMatch(m[0], /\$\{wbApiEndpoint\(\)\}/, '轮询 URL 不得直接用 daemon 锁定版本的域名');
});

test('lib: targetAuthFileForAccount 尊重 WBSWITCH_AUTH_FILE 覆盖', () => {
  const prevEnv = process.env.WBSWITCH_AUTH_FILE;
  try {
    const custom = path.join(os.tmpdir(), 'custom-target-auth.info');
    process.env.WBSWITCH_AUTH_FILE = custom;
    assert.equal(lib.targetAuthFileForAccount({ auth: { domain: 'https://www.workbuddy.ai' } }), custom);
    assert.equal(lib.targetAuthFileForAccount({ auth: { domain: 'https://www.codebuddy.cn' } }), custom);
    delete process.env.WBSWITCH_AUTH_FILE;
    // 未覆盖时按备份自身域名判定写入目标
    assert.equal(lib.targetAuthFileForAccount({ auth: { domain: 'https://www.workbuddy.ai' } }), lib.AUTH_FILES.ai);
    assert.equal(lib.targetAuthFileForAccount({ auth: { domain: 'https://www.codebuddy.cn' } }), lib.AUTH_FILES.cn);
  } finally {
    if (prevEnv === undefined) delete process.env.WBSWITCH_AUTH_FILE;
    else process.env.WBSWITCH_AUTH_FILE = prevEnv;
    lib.setEdition('cn');
  }
});

test('win-launcher: 进程探测/退出同时覆盖 WorkBuddy.exe 与 WorkBuddyAI.exe', () => {
  const launcher = read('win-launcher.js');
  assert.match(launcher, /WORKBUDDY_IMAGE_NAMES\s*=\s*\['WorkBuddy\.exe',\s*'WorkBuddyAI\.exe'\]/);
});
