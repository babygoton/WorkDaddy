'use strict';

/**
 * Linux 路径与多实例归属的单测。
 *
 * 这里锁定的都是「真实踩过」的回归点：
 *   1. 隔离 HOME（海外版）下用启动器反推真实家目录 —— 推错会把 mimeapps.list
 *      覆盖成自指死链，xdg-open 转而打开 ChatGPT。
 *   2. 数据根探测不能串到兄弟端（环境里残留另一端的 *_CONFIG_DIR）。
 *   3. 登录凭据按 profile 选名，缺本端文件时降级到通用名。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const plat = require('../scripts/platform.js');

/** 造一个临时「家目录」骨架 */
function tempHome(files = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-linux-'));
  for (const rel of files) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '{}');
  }
  return root;
}

test('launcherHomeFor 从 <真实HOME>/.local/bin/<name> 上溯三级', () => {
  assert.equal(plat.launcherHomeFor('/home/u/.local/bin/workbuddy-ai'), '/home/u');
  assert.equal(plat.launcherHomeFor('/home/u/.local/bin/workbuddy-noproxy'), '/home/u');
});

test('launcherHomeFor 显式值优先，非法路径返回空串（不猜）', () => {
  assert.equal(plat.launcherHomeFor('/home/u/.local/bin/workbuddy-ai', '/custom/home'), '/custom/home');
  assert.equal(plat.launcherHomeFor('', ''), '');
  // 不是 .local/bin 形态的一律拒绝，避免推出一个不可信的家目录
  assert.equal(plat.launcherHomeFor('/opt/WorkBuddy/workbuddy'), '');
  assert.equal(plat.launcherHomeFor('/usr/bin/workbuddy'), '');
  assert.equal(plat.launcherHomeFor('/home/u/bin/workbuddy'), '');
});

test('隔离 HOME 场景：launcherHomeFor 推出的家目录不能等于隔离 HOME 本身', () => {
  // 真实事故：调用方带着 HOME=$ISOHOME 去跑启动器，启动器把 ISOHOME 当真实家目录，
  // 于是 ln -sfn $ISOHOME/... $ISOHOME/... 产生自指死链。
  // 只要显式传入真实 HOME，就不会发生。
  const isohome = '/home/u/.workbuddy-ai-home';
  assert.equal(plat.launcherHomeFor('/home/u/.local/bin/workbuddy-ai', '/home/u'), '/home/u');
  assert.notEqual(plat.launcherHomeFor('/home/u/.local/bin/workbuddy-ai', '/home/u'), isohome);
});

test('linuxDataRootCandidates 排除兄弟端路径，且 XDG 默认优先于环境残留', () => {
  const home = tempHome(['.workbuddy/workbuddy.db']);
  const isohome = tempHome(['.config/workbuddy-ai/workbuddy.db']);
  try {
    // 环境里残留着「另一端」的 config 目录（从 A 应用内置终端启动时很常见）
    const env = {
      WORKBUDDY_CONFIG_DIR: path.join(home, '.workbuddy'),
      XDG_CONFIG_HOME: path.join(isohome, '.config'),
    };
    const aiRoots = plat.linuxDataRootCandidates('workbuddy-ai', { home: isohome, env });
    const picked = plat.pickLinuxDataRoot(aiRoots);
    assert.equal(picked, path.join(isohome, '.config', 'workbuddy-ai'));
    assert.notEqual(picked, path.join(home, '.workbuddy'));

    const cnRoots = plat.linuxDataRootCandidates('workbuddy-cn', { home, env });
    assert.equal(plat.pickLinuxDataRoot(cnRoots), path.join(home, '.workbuddy'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(isohome, { recursive: true, force: true });
  }
});

test('looksLikeSiblingRoot 按 profile 名互斥', () => {
  assert.equal(plat.looksLikeSiblingRoot('/home/u/.workbuddy', true), true);   // AI 不接受 CN 的根
  assert.equal(plat.looksLikeSiblingRoot('/home/u/.config/workbuddy-ai', true), false);
  assert.equal(plat.looksLikeSiblingRoot('/home/u/.config/workbuddy-ai', false), true); // CN 不接受 AI 的根
  assert.equal(plat.looksLikeSiblingRoot('/home/u/.workbuddy', false), false);
  assert.equal(plat.looksLikeSiblingRoot('', false), true);                    // 空值不可用
});

test('pickLinuxDataRoot 优先选含 workbuddy.db 的候选，而不是第一个存在的目录', () => {
  const home = tempHome(['.config/workbuddy-ai/app/x.json', '.workbuddy-ai/workbuddy.db']);
  try {
    const roots = [path.join(home, '.config', 'workbuddy-ai'), path.join(home, '.workbuddy-ai')];
    assert.equal(plat.pickLinuxDataRoot(roots), path.join(home, '.workbuddy-ai'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('linuxAuthFileFor 按 profile 选名，缺本端文件时降级到通用名', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-auth-'));
  try {
    // 只有通用名：AI 端应降级使用它，而不是返回一个不存在的路径
    fs.writeFileSync(path.join(dir, 'workbuddy-desktop.info'), '{}');
    assert.equal(plat.linuxAuthFileFor(dir, 'workbuddy-ai'), path.join(dir, 'workbuddy-desktop.info'));

    // 本端专属名存在时优先
    fs.writeFileSync(path.join(dir, 'workbuddy-desktop-ai.info'), '{}');
    assert.equal(plat.linuxAuthFileFor(dir, 'workbuddy-ai'), path.join(dir, 'workbuddy-desktop-ai.info'));
    assert.equal(plat.linuxAuthFileFor(dir, 'workbuddy-cn'), path.join(dir, 'workbuddy-desktop.info'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('linuxAppBinary 同时接受 kind 与 profile id（混用会静默取不到候选）', () => {
  // 曾经的问题：按 kind 索引候选表，但调用方常手边只有 profile id（workbuddy-cn），
  // 混用会静默返回空串 —— 应用找不到、错误信息还很难懂。
  assert.equal(plat.normalizeAppKind('workbuddy-cn'), 'workbuddy');
  assert.equal(plat.normalizeAppKind('workbuddy'), 'workbuddy');
  assert.equal(plat.normalizeAppKind('workbuddy-ai'), 'workbuddy-ai');
  assert.equal(plat.normalizeAppKind('codebuddy-intl'), 'codebuddy');
  assert.equal(plat.normalizeAppKind('codebuddy-cn'), 'codebuddy-cn');
  assert.equal(plat.normalizeAppKind('nonexistent-kind'), '');
  assert.equal(plat.isAiKind('workbuddy-ai'), true);
  assert.equal(plat.isAiKind('workbuddy-cn'), false);

  // 两种写法必须得到同一结果
  for (const key of ['workbuddy', 'workbuddy-cn']) {
    const bin = plat.linuxAppBinary(key);
    assert.equal(typeof bin, 'string');
    assert.ok(bin.length > 0, `${key} 应当解析出候选路径而不是空串`);
  }
  assert.equal(plat.linuxAppBinary('workbuddy'), plat.linuxAppBinary('workbuddy-cn'));
  // 未知 kind 仍返回空串而不是抛错
  assert.equal(plat.linuxAppBinary('nonexistent-kind'), '');
});

/**
 * 回归：sentry-report.js 曾把「非 Windows」一律当 macOS，在 Linux 家目录下凭空创建
 * ~/Library/Application Support/WorkDaddy（真机实测到过，两端都有）。
 * 这里用临时 HOME 起一个子进程，直接看它到底往哪写 —— 比断言某个常量更接近真实行为。
 */
test('sentry-report 在 Linux 上写入 $XDG_CONFIG_HOME，不创建 macOS 风格的 ~/Library', { skip: os.platform() !== 'linux' }, () => {
  const reporter = path.join(__dirname, '..', 'scripts', 'sentry-report.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-sentry-'));
  try {
    const r = spawnSync(
      process.execPath,
      ['-e', `require(${JSON.stringify(reporter)}).persistentInstallationId()`],
      { env: { ...process.env, HOME: root, WBSWITCH_PROFILE: 'workbuddy-cn' }, encoding: 'utf8' },
    );
    assert.equal(r.status, 0, r.stderr || String(r.error));
    assert.ok(
      fs.existsSync(path.join(root, '.config', 'WorkDaddy', 'installation-id')),
      'installation-id 应落在 $XDG_CONFIG_HOME/WorkDaddy',
    );
    assert.ok(!fs.existsSync(path.join(root, 'Library')), '不应创建 macOS 风格的 ~/Library');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
