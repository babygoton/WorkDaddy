'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.join(__dirname, '..');
const script = path.join(root, 'scripts', 'build-linux-deb.sh');

test('Linux release builds a versioned, self-contained Debian package without root install hooks', () => {
  const source = fs.readFileSync(script, 'utf8');
  assert.match(source, /dpkg-deb --build --root-owner-group/);
  assert.match(source, /CROSS_PACKAGE=1/);
  assert.match(source, /tarfile\.open\(control, 'w:xz'\)/);
  assert.match(source, /tarfile\.open\(data, 'w:xz'\)/);
  assert.match(source, /node != b'\\x7fELF\\x02'/);
  assert.match(source, /node-v22\.23\.1-linux-x64\.tar\.xz/);
  assert.match(source, /9749e988f437343b7fa832c69ded82a312e41a03116d766797ac14f6f9eee578/);
  assert.match(source, /ws-8\.18\.3\.tgz/);
  assert.match(source, /424be604c8e7926fc29a1f067bf2dac256af3bcea62fe30395018bbaf8a9be2a/);
  assert.match(source, /scripts\/runtime\/node\/node/);
  assert.match(source, /node_modules\/ws/);
  assert.match(source, /scripts\/builtin/);
  assert.match(source, /scripts\/assets\/workdaddy-logo\.svg/);
  assert.match(source, /for profile in cn ai/);
  assert.match(source, /workdaddy-\$profile\.desktop/);
  assert.match(source, /const DAEMON_VERSION =/);
  assert.match(source, /\['DAEMON_BUILD_ID', `release-\$\{version\}-linux-deb`\]/);
  assert.doesNotMatch(source, /DEBIAN\/(?:preinst|postinst|prerm|postrm)/);
  assert.doesNotMatch(source, /cp [^\n]*安装失败自主解决提示词/);
  assert.match(source, /grep -q '安装失败自主解决提示词/);
  assert.equal(spawnSync('bash', ['-n', script]).status, 0);
});

test('Linux launch paths prefer bundled Node over app-managed and system runtimes', () => {
  for (const name of ['install-linux.sh', 'relaunch-with-cdp-linux.sh', 'systemd-install-linux.sh']) {
    const source = fs.readFileSync(path.join(root, 'scripts', name), 'utf8');
    const bundled = source.indexOf('"$DIR/scripts/runtime/node/node"');
    const managed = source.indexOf('"$HOME/.workbuddy/binaries/node/versions/22.22.2/bin/node"');
    assert.ok(bundled !== -1 && managed !== -1 && bundled < managed, `${name} must prefer bundled Node`);
    assert.equal(spawnSync('bash', ['-n', path.join(root, 'scripts', name)]).status, 0);
  }
});

test('Linux file-manager action does not invoke the macOS open command', () => {
  const daemon = fs.readFileSync(path.join(root, 'scripts/daemon.js'), 'utf8');
  assert.match(daemon, /if \(IS_LINUX\) \{\s*require\('child_process'\)\.execFile\('xdg-open', \[DATA_DIR\]\)/);
});

test('built Linux package has matching metadata and payload', { skip: process.platform !== 'linux' || !process.env.WORKDADDY_LINUX_DEB }, () => {
  const deb = process.env.WORKDADDY_LINUX_DEB;
  const version = spawnSync('dpkg-deb', ['-f', deb, 'Version'], { encoding: 'utf8' });
  assert.equal(version.status, 0);
  const entries = spawnSync('dpkg-deb', ['--contents', deb], { encoding: 'utf8' });
  assert.equal(entries.status, 0);
  for (const name of ['scripts/daemon.js', 'scripts/runtime/node/node', 'scripts/node_modules/ws/package.json',
    'scripts/builtin/nebula/theme.json', 'scripts/assets/workdaddy-logo.svg',
    'workdaddy-cn.desktop', 'workdaddy-ai.desktop']) {
    assert.ok(entries.stdout.includes(name), `missing ${name}`);
  }
  assert.ok(!entries.stdout.includes('安装失败自主解决提示词.txt'));
  const extracted = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'workdaddy-linux-deb-test-'));
  try {
    assert.equal(spawnSync('dpkg-deb', ['--extract', deb, extracted]).status, 0);
    const daemon = fs.readFileSync(path.join(extracted, 'opt/workdaddy/scripts/daemon.js'), 'utf8');
    assert.match(daemon, new RegExp(`const DAEMON_VERSION = '${version.stdout.trim().replace(/\./g, '\\.')}';`));
    assert.match(daemon, /const DAEMON_BUILD_ID = 'release-[^']+-linux-deb';/);
  } finally {
    fs.rmSync(extracted, { recursive: true, force: true });
  }
  assert.match(path.basename(deb), new RegExp(version.stdout.trim().replace(/\./g, '\\.') + '_amd64\\.deb$'));
});

test('cross-built Debian archive exposes standard member names and control metadata', { skip: !process.env.WORKDADDY_LINUX_DEB }, () => {
  const deb = process.env.WORKDADDY_LINUX_DEB;
  const members = spawnSync('ar', ['-t', deb], { encoding: 'utf8' });
  assert.equal(members.status, 0, members.stderr);
  assert.deepEqual(members.stdout.trim().split('\n'), ['debian-binary', 'control.tar.xz', 'data.tar.xz']);
  const control = spawnSync('ar', ['-p', deb, 'control.tar.xz']);
  assert.equal(control.status, 0, String(control.stderr));
  const metadata = spawnSync('tar', ['-xOJf', '-', './control'], { input: control.stdout, encoding: 'utf8' });
  assert.equal(metadata.status, 0, metadata.stderr);
  const version = path.basename(deb).match(/^WorkDaddy_(\d+\.\d+\.\d+)_amd64\.deb$/)?.[1];
  assert.ok(version);
  assert.ok(metadata.stdout.split('\n').includes(`Version: ${version}`));
  assert.match(metadata.stdout, /^Architecture: amd64$/m);
});
