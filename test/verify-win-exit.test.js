'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const repoRoot = path.join(__dirname, '..');
const verifyScript = path.join(repoRoot, 'scripts', 'verify-win.cmd');
const source = fs.readFileSync(verifyScript, 'utf8');

function isolatedEnv(dir) {
  const profile = path.join(dir, 'profile');
  const localAppData = path.join(profile, 'AppData', 'Local');
  const appData = path.join(profile, 'AppData', 'Roaming');
  fs.mkdirSync(localAppData, { recursive: true });
  fs.mkdirSync(appData, { recursive: true });
  return {
    ...process.env,
    CI: '1',
    USERPROFILE: profile,
    LOCALAPPDATA: localAppData,
    APPDATA: appData,
  };
}

test('Windows verifier returns a stable success or failure exit code', () => {
  assert.match(source, /set "VERIFY_EXIT=0"/);
  assert.match(source, /set "VERIFY_EXIT=1"/);
  assert.match(source, /if not defined CI pause/i);
  assert.match(source, /set "ORIGINAL_CODE_PAGE=/);
  assert.match(source, /chcp %ORIGINAL_CODE_PAGE%/i);
  assert.match(source, /exit \/b %VERIFY_EXIT%/i);
});

test('Windows verifier reports missing package files as a failing process', { skip: process.platform !== 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-verify-win-'));
  const isolatedScript = path.join(dir, 'verify-win.cmd');
  try {
    fs.copyFileSync(verifyScript, isolatedScript);
    const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'call', isolatedScript], {
      encoding: 'utf8',
      env: isolatedEnv(dir),
      timeout: 10000,
      windowsHide: true,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stdout + result.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

test('Windows verifier returns success for a complete source package', { skip: process.platform !== 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-verify-win-complete-'));
  const scriptsDir = path.join(dir, 'scripts');
  const required = [
    'daemon.js', 'session-db.js', 'secure-transfer.js', 'lib.js', 'watchdog.js', 'win-launcher.js',
    'windows-process-boundary.js', 'windows-process-boundary.ps1', 'windows-relaunch-standard.ps1',
    'workbuddy-compat.js', 'inject.js',
    'theme-patches.js', 'launcher.cmd', 'launcher-hidden.vbs', 'install-win.cmd',
    'install-win.ps1', 'prepare-win-install.ps1', 'uninstall-win.cmd', 'uninstall-win.ps1', 'apply-update.ps1',
    path.join('win', 'setup.sed'), 'verify-win.cmd',
  ];
  try {
    fs.copyFileSync(path.join(repoRoot, '安装失败自主解决提示词.txt'), path.join(dir, '安装失败自主解决提示词.txt'));
    for (const relative of required) {
      const target = path.join(scriptsDir, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(repoRoot, 'scripts', relative), target);
    }
    const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'call', path.join(scriptsDir, 'verify-win.cmd')], {
      encoding: 'utf8',
      env: isolatedEnv(dir),
      timeout: 10000,
      windowsHide: true,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

test('Windows verifier restores the caller code page', { skip: process.platform !== 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-verify-win-codepage-'));
  const isolatedScript = path.join(dir, 'verify-win.cmd');
  const wrapper = path.join(dir, 'verify-wrapper.cmd');
  try {
    fs.copyFileSync(verifyScript, isolatedScript);
    fs.writeFileSync(wrapper, [
      '@echo off',
      'chcp 437 >nul',
      'call verify-win.cmd',
      'set "VERIFY_STATUS=%ERRORLEVEL%"',
      'for /f "tokens=2 delims=:" %%C in (\'chcp\') do set "AFTER_CP=%%C"',
      'echo VERIFY_STATUS=%VERIFY_STATUS%',
      'echo AFTER_CP=%AFTER_CP%',
      'exit /b 0',
      '',
    ].join('\r\n'), 'ascii');
    const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'call', wrapper], {
      encoding: 'utf8',
      env: isolatedEnv(dir),
      timeout: 10000,
      windowsHide: true,
      cwd: dir,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /VERIFY_STATUS=1/);
    assert.match(result.stdout, /AFTER_CP=\s*437/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});
