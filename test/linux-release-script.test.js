'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.join(__dirname, '..');
const script = path.join(root, 'scripts', 'build-linux-deb.sh');

test('cross-packager writes tar headers supported by older dpkg with fractional file timestamps', (t) => {
  const python = (process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'])
    .find(command => spawnSync(command, ['-c', 'import sys, tarfile, lzma; assert sys.version_info >= (3, 8)']).status === 0);
  if (!python) {
    t.skip('Requires Python 3.8+ with lzma for the cross-packager');
    return;
  }
  const source = fs.readFileSync(script, 'utf8');
  const packager = source.match(/<<'PY'\n([\s\S]*?)\nPY/)[1];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-deb-compat-'));
  try {
    const stage = path.join(temp, 'stage');
    const scripts = path.join(stage, 'opt/workdaddy/scripts');
    fs.mkdirSync(path.join(stage, 'DEBIAN'), { recursive: true });
    fs.mkdirSync(path.join(stage, 'usr/share/applications'), { recursive: true });
    fs.mkdirSync(path.join(scripts, 'runtime/node'), { recursive: true });
    fs.writeFileSync(path.join(stage, 'DEBIAN/control'), 'Package: workdaddy\nVersion: 1.2.14\nArchitecture: amd64\n');
    const daemon = path.join(scripts, 'daemon.js');
    fs.writeFileSync(daemon, "const DAEMON_VERSION = '1.2.14';\n");
    fs.utimesSync(daemon, 1700000000.125, 1700000000.125);
    const elf = Buffer.alloc(20);
    elf.set([0x7f, 0x45, 0x4c, 0x46, 0x02]);
    elf.writeUInt16LE(62, 18);
    fs.writeFileSync(path.join(scripts, 'runtime/node/node'), elf, { mode: 0o755 });
    const longPath = path.join(scripts, 'builtin', 'a'.repeat(70), 'theme.json');
    fs.mkdirSync(path.dirname(longPath), { recursive: true });
    fs.writeFileSync(longPath, '{}');
    const checkHeaders = `
import io
import lzma
with output.open('rb') as deb:
    deb.seek(8)
    for expected in ('debian-binary', 'control.tar.xz', 'data.tar.xz'):
        header = deb.read(60)
        size = int(header[48:58])
        contents = deb.read(size)
        deb.read(size % 2)
        if not expected.endswith('.tar.xz'):
            continue
        raw = lzma.decompress(contents)
        offset = 0
        while any(raw[offset:offset + 512]):
            block = raw[offset:offset + 512]
            assert block[156:157] in (b'0', b'5'), (expected, block[156:157], 'unsupported tar header')
            size = int(block[124:136].strip(b'\\x00 ') or b'0', 8)
            offset += 512 + ((size + 511) // 512) * 512
with tarfile.open(fileobj=io.BytesIO(contents), mode='r:xz') as archive:
    assert archive.extractfile('./opt/workdaddy/scripts/daemon.js').read() == b"const DAEMON_VERSION = '1.2.14';\\n"
    assert any(len(member.name) > 100 for member in archive.getmembers())
    assert archive.getmember('./opt/workdaddy/scripts/runtime/node/node').mode == 0o755
`;
    const result = spawnSync(python, ['-', stage, path.join(temp, 'fixture.deb'), '1.2.14', '/opt/workdaddy', 'workdaddy', 'amd64'], {
      input: packager + '\n' + checkHeaders, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('Linux release builds a versioned, self-contained Debian package without root install hooks', () => {
  const source = fs.readFileSync(script, 'utf8');
  assert.match(source, /dpkg-deb --build --root-owner-group/);
  assert.match(source, /CROSS_PACKAGE=1/);
  assert.match(source, /tarfile\.open\(control, 'w:xz', format=tarfile\.USTAR_FORMAT\)/);
  assert.match(source, /tarfile\.open\(data, 'w:xz', format=tarfile\.USTAR_FORMAT\)/);
  assert.match(source, /expected_machine = \{'amd64': 62, 'arm64': 183\}/);
  assert.match(source, /actual_machine = int\.from_bytes\(node\[18:20\], 'little'\)/);
  assert.match(source, /WORKDADDY_BUILD_ARCH/);
  assert.match(source, /node-v22\.23\.1-linux-\$NODE_ARCH\.tar\.xz/);
  assert.match(source, /amd64[\s\S]*x64[\s\S]*9749e988f437343b7fa832c69ded82a312e41a03116d766797ac14f6f9eee578/);
  assert.match(source, /arm64[\s\S]*arm64[\s\S]*NODE_SHA256/);
  assert.match(source, /ws-8\.18\.3\.tgz/);
  assert.match(source, /424be604c8e7926fc29a1f067bf2dac256af3bcea62fe30395018bbaf8a9be2a/);
  assert.match(source, /scripts\/runtime\/node\/node/);
  assert.match(source, /node_modules\/ws/);
  assert.match(source, /scripts\/builtin/);
  assert.match(source, /scripts\/assets\/workdaddy-logo\.svg/);
  assert.match(source, /build_package cn workdaddy \/opt\/workdaddy/);
  assert.match(source, /build_package ai workdaddy-ai \/opt\/workdaddy-ai/);
  assert.match(source, /WorkDaddy_\$\{VERSION\}_\$\{DEB_ARCH\}\.deb/);
  assert.match(source, /WorkDaddy-AI_\$\{VERSION\}_\$\{DEB_ARCH\}\.deb/);
  assert.match(source, /Architecture: \$DEB_ARCH/);
  assert.match(source, /Exec=\$install_root\/scripts\/launch-gui-linux\.sh \$profile/);
  assert.match(source, /\$package_name\.png/);
  assert.match(source, /Icon=\$package_name/);
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

test('built Linux packages have matching metadata and isolated payloads', { skip: process.platform !== 'linux' || !process.env.WORKDADDY_LINUX_DEBS }, () => {
  const debs = process.env.WORKDADDY_LINUX_DEBS.split(path.delimiter).filter(Boolean);
  assert.ok(debs.length > 0);
  const expected = new Map([
    ['WorkDaddy_', { packageName: 'workdaddy', root: 'opt/workdaddy', desktop: 'workdaddy.desktop', filePattern: /^WorkDaddy_\d+\.\d+\.\d+_(?:amd64|arm64)\.deb$/ }],
    ['WorkDaddy-AI_', { packageName: 'workdaddy-ai', root: 'opt/workdaddy-ai', desktop: 'workdaddy-ai.desktop', filePattern: /^WorkDaddy-AI_\d+\.\d+\.\d+_(?:amd64|arm64)\.deb$/ }],
    ['CodeDaddy-CN_', { packageName: 'codedaddy-cn', root: 'opt/codedaddy-cn', desktop: 'codedaddy-cn.desktop', filePattern: /^CodeDaddy-CN_\d+\.\d+\.\d+_(?:amd64|arm64)\.deb$/ }],
    ['CodeDaddy_', { packageName: 'codedaddy', root: 'opt/codedaddy', desktop: 'codedaddy.desktop', filePattern: /^CodeDaddy_\d+\.\d+\.\d+_(?:amd64|arm64)\.deb$/ }],
  ]);
  for (const deb of debs) {
    const fileName = path.basename(deb);
    const entry = [...expected.entries()].find(([prefix]) => fileName.startsWith(prefix))?.[1];
    assert.ok(entry, `unexpected Linux package: ${fileName}`);
    assert.match(fileName, entry.filePattern);
  const version = spawnSync('dpkg-deb', ['-f', deb, 'Version'], { encoding: 'utf8' });
  assert.equal(version.status, 0);
  const packageName = spawnSync('dpkg-deb', ['-f', deb, 'Package'], { encoding: 'utf8' });
  assert.equal(packageName.stdout.trim(), entry.packageName);
  const entries = spawnSync('dpkg-deb', ['--contents', deb], { encoding: 'utf8' });
  assert.equal(entries.status, 0);
  for (const name of ['scripts/daemon.js', 'scripts/runtime/node/node', 'scripts/node_modules/ws/package.json',
    'scripts/builtin/nebula/theme.json', 'scripts/assets/workdaddy-logo.svg']) {
    assert.ok(entries.stdout.includes(`${entry.root}/${name}`), `missing ${entry.root}/${name}`);
  }
  assert.ok(entries.stdout.includes(entry.desktop));
  assert.equal(entries.stdout.includes(entry.root === 'opt/workdaddy' ? 'opt/workdaddy-ai/' : 'opt/workdaddy/'), false);
  assert.ok(!entries.stdout.includes('安装失败自主解决提示词.txt'));
  const extracted = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'workdaddy-linux-deb-test-'));
  try {
    assert.equal(spawnSync('dpkg-deb', ['--extract', deb, extracted]).status, 0);
    const daemon = fs.readFileSync(path.join(extracted, entry.root, 'scripts/daemon.js'), 'utf8');
    assert.match(daemon, new RegExp(`const DAEMON_VERSION = '${version.stdout.trim().replace(/\./g, '\\.')}';`));
    assert.match(daemon, /const DAEMON_BUILD_ID = 'release-[^']+-linux-deb';/);
  } finally {
    fs.rmSync(extracted, { recursive: true, force: true });
  }
  const architecture = spawnSync('dpkg-deb', ['-f', deb, 'Architecture'], { encoding: 'utf8' }).stdout.trim();
  assert.ok(['amd64', 'arm64'].includes(architecture));
  assert.match(path.basename(deb), new RegExp(version.stdout.trim().replace(/\./g, '\\.') + '_' + architecture + '\\.deb$'));
  }
});

test('cross-built Debian archives expose standard member names and control metadata', { skip: !process.env.WORKDADDY_LINUX_DEBS }, () => {
  const debs = process.env.WORKDADDY_LINUX_DEBS.split(path.delimiter).filter(Boolean);
  for (const deb of debs) {
  const members = spawnSync('ar', ['-t', deb], { encoding: 'utf8' });
  assert.equal(members.status, 0, members.stderr);
  assert.deepEqual(members.stdout.trim().split('\n'), ['debian-binary', 'control.tar.xz', 'data.tar.xz']);
  const control = spawnSync('ar', ['-p', deb, 'control.tar.xz']);
  assert.equal(control.status, 0, String(control.stderr));
  const metadata = spawnSync('tar', ['-xOJf', '-', './control'], { input: control.stdout, encoding: 'utf8' });
  assert.equal(metadata.status, 0, metadata.stderr);
  const match = path.basename(deb).match(/^(?:WorkDaddy|WorkDaddy-AI|CodeDaddy-CN|CodeDaddy)_(\d+\.\d+\.\d+)_(amd64|arm64)\.deb$/);
  assert.ok(match);
  const [, version, architecture] = match;
  assert.ok(metadata.stdout.split('\n').includes(`Version: ${version}`));
  assert.match(metadata.stdout, new RegExp('^Architecture: ' + architecture + '$', 'm'));
  }
});
