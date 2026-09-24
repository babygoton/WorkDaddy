'use strict';

// WorkDaddy Linux 移植的回归测试。
// 运行时路径断言只在 Linux 上执行（macOS/Windows 路径语义不同，保持上游行为不变）；
// 其余为静态源码断言，任何平台都会跑，用于防止移植代码被后续改动悄悄移除。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const SCRIPTS = path.join(__dirname, '..', 'scripts');
const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(SCRIPTS, file), 'utf8');

const LINUX_ONLY = process.platform === 'linux';
const linuxSkip = LINUX_ONLY ? false : '仅在 Linux 上校验 XDG 路径';

test('Linux: 数据目录与 auth 文件走 XDG 规范', { skip: linuxSkip }, () => {
  const { getProfile, sharedDataDir } = require(path.join(SCRIPTS, 'profiles.js'));
  const lib = require(path.join(SCRIPTS, 'lib.js'));
  const home = os.homedir();
  const dataHome = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');

  assert.equal(sharedDataDir(), path.join(dataHome, 'WorkDaddy'));
  assert.equal(lib.AUTH_FILE, path.join(dataHome, 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'));

  const profile = getProfile();
  assert.equal(profile.appPath, '/opt/WorkBuddy/workbuddy');
  assert.equal(profile.sessionDb, path.join(home, '.workbuddy', 'workbuddy.db'));
});

test('Linux: 休眠控制使用 systemd-inhibit / systemctl suspend', () => {
  const daemon = read('daemon.js');
  assert.match(daemon, /spawn\('systemd-inhibit'/);
  assert.match(daemon, /spawn\('systemctl', \['suspend'\]/);
  // Linux 不能再退化到 macOS 的 caffeinate 分支
  assert.match(daemon, /IS_LINUX \? sleepInhibit/);
});

test('Linux: 打开目录/外链使用 xdg-open 而不是 macOS 的 open', () => {
  const daemon = read('daemon.js');
  assert.match(daemon, /function openPath\(target\)/);
  assert.match(daemon, /IS_LINUX \? 'xdg-open' : 'open'/);
  assert.doesNotMatch(daemon, /execFile\('\/usr\/bin\/open'/);
});

test('Linux: 更新包识别 tar.gz，且不做 hdiutil 预检', () => {
  const daemon = read('daemon.js');
  assert.match(daemon, /IS_LINUX \? '\.tar\.gz' : '\.dmg'/);
  assert.match(daemon, /-linux-\(\?:x64\|amd64\)\\\.tar\\\.gz/);
  assert.match(daemon, /apply-update-linux\.sh/);
});

test('Linux: 四个 Linux 专属脚本存在', () => {
  for (const file of ['install-linux.sh', 'uninstall-linux.sh', 'relaunch-with-cdp-linux.sh', 'apply-update-linux.sh']) {
    assert.ok(fs.existsSync(path.join(SCRIPTS, file)), `缺少 ${file}`);
  }
});

test('Linux: 构建脚本 stage 了 daemon 的全部顶层依赖', () => {
  const build = fs.readFileSync(path.join(SCRIPTS, 'build-linux-tar.sh'), 'utf8');
  const daemon = read('daemon.js');
  // 清单跨多行书写（带续行符），用非贪婪跨行匹配
  const rawList = build.match(/for f in ([\s\S]*?); do/)[1].split(/[\s\\]+/).filter(Boolean);
  const list = rawList.filter((n) => n.endsWith('.js'));
  let checked = 0;
  for (const match of daemon.matchAll(/^.*require\(['"]\.\/([^'"]+\.js)['"]\).*$/gm)) {
    if (/^\s/.test(match[0])) continue; // 平台条件分支内的按需加载
    const module = match[1];
    if (!fs.existsSync(path.join(SCRIPTS, module))) continue; // 仓库中不存在的（macOS 构建期产物）
    assert.ok(list.includes(module), `Linux 打包清单缺少 ${module}`);
    checked += 1;
  }
  assert.ok(checked > 20, `校验的依赖数量异常: ${checked}`);
  // Linux 专属脚本必须进包，否则装完无法安装/重启/更新
  for (const file of ['install-linux.sh', 'uninstall-linux.sh', 'relaunch-with-cdp-linux.sh', 'apply-update-linux.sh']) {
    assert.ok(rawList.includes(file), `打包清单缺少 ${file}`);
  }
});

test('Linux: 构建脚本产出 tar.gz 与 deb 两种产物', () => {
  const build = fs.readFileSync(path.join(SCRIPTS, 'build-linux-tar.sh'), 'utf8');
  assert.match(build, /WorkDaddy-\$\{VERSION\}-linux-x64\.tar\.gz/);
  assert.match(build, /workdaddy_\$\{VERSION\}_amd64\.deb/);
  assert.match(build, /dpkg-deb --build/);
  assert.match(build, /version\.txt/); // inspectPackagedApp 在 Linux 上依赖它读应用版本
});

test('Linux: 安装脚本必须携带 builtin 内置任务资源', () => {
  const install = read('install-linux.sh');
  // daemon 启动时从 scripts/builtin/automations 安装关弹窗/账号保活/自动签到三个内置任务，
  // 只铺 *.js/*.sh 会把整个 builtin 目录漏掉，导致这些功能静默失效。
  assert.match(install, /scripts\/builtin/, 'install-linux.sh 未复制 scripts/builtin');
  assert.match(install, /AUTOMATION_COUNT/, 'install-linux.sh 缺少内置任务安装自检');
});

test('Linux: daemon 运行必需的内置任务在发布包内', { skip: !LINUX_ONLY ? '仅 Linux' : !fs.existsSync(path.join(ROOT, 'release', 'linux')) ? '尚未构建' : false }, () => {
  const releaseDir = path.join(ROOT, 'release', 'linux');
  const tarballs = fs.readdirSync(releaseDir).filter((n) => /^WorkDaddy-.*-linux-x64\.tar\.gz$/.test(n));
  assert.ok(tarballs.length > 0, '没有找到 Linux 发布包');
  const list = require('node:child_process').execFileSync('tar', ['-tzf', path.join(releaseDir, tarballs[0])], { encoding: 'utf8' });
  for (const preset of ['close-buddy-popups.json', 'keep-accounts-active.json', 'daily-account-checkin.json']) {
    assert.match(list, new RegExp('scripts/builtin/automations/' + preset.replace('.', '\\.')), `发布包缺少内置任务 ${preset}`);
  }
});

test('Linux: 客户端目标解析接受 linux 平台', () => {
  const source = read('workbuddy-target.js');
  assert.match(source, /platform !== 'win32' && platform !== 'darwin' && platform !== 'linux'/);
  assert.match(source, /XDG_DATA_HOME/);
});

test('Linux: 发布产物存在时可被解包并启动 daemon', { skip: !LINUX_ONLY ? '仅 Linux' : !fs.existsSync(path.join(ROOT, 'release', 'linux')) ? '尚未构建' : false }, () => {
  const releaseDir = path.join(ROOT, 'release', 'linux');
  const tarballs = fs.readdirSync(releaseDir).filter((n) => /^WorkDaddy-.*-linux-x64\.tar\.gz$/.test(n));
  assert.ok(tarballs.length > 0, '没有找到 Linux 发布包');
  const list = require('node:child_process').execFileSync('tar', ['-tzf', path.join(releaseDir, tarballs[0])], { encoding: 'utf8' });
  assert.match(list, /WorkDaddy-linux\/scripts\/daemon\.js/);
  assert.match(list, /WorkDaddy-linux\/scripts\/relaunch-with-cdp-linux\.sh/);
  assert.match(list, /WorkDaddy-linux\/version\.txt/);
});
