'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const daemon = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'daemon.js'), 'utf8');
const macBuild = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build-mac-dmg.sh'), 'utf8');
const winBuild = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build-win-zip.sh'), 'utf8');
const winInstaller = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build-win-installer.ps1'), 'utf8');
const winWorkflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'build-win.yml'), 'utf8');
const wallpaperOverride = path.join(__dirname, '..', 'scripts', 'builtin-overrides', 'wallpaper-06.webp');
const builtinDir = path.join(__dirname, '..', 'scripts', 'builtin');

test('built-in official wallpapers refresh stale managed copies', () => {
  const start = daemon.indexOf('function initBuiltinAssets()');
  const end = daemon.indexOf('\n/** 内置主题', start);
  const source = daemon.slice(start, end);

  assert.match(source, /Buffer\.compare\(/);
  assert.match(source, /fs\.copyFileSync\(source, dest\)/);
  assert.match(daemon, /function builtinWallpaperSource\(/);
  assert.ok(fs.existsSync(wallpaperOverride));
  assert.equal(fs.readFileSync(wallpaperOverride, null).subarray(0, 4).toString('ascii'), 'RIFF');
});

test('a fresh profile starts with the WorkDaddy wallpaper theme', () => {
  const start = daemon.indexOf('function initBuiltinAssets()');
  const end = daemon.indexOf('\n/** 内置主题', start);
  const source = daemon.slice(start, end);

  assert.match(source, /JSON\.stringify\(\{ id: 'nebula'/);
  assert.doesNotMatch(source, /JSON\.stringify\(\{ id: 'default'/);
});

test('release builders stage the tracked wallpaper override as wallpaper 6 and the default background', () => {
  for (const source of [macBuild, winBuild]) {
    assert.match(source, /builtin-overrides\/wallpaper-06\.webp/);
    assert.match(source, /builtin\/wallpapers\/wallpaper-06\.webp/);
    assert.match(source, /builtin\/nebula\/background\.webp/);
  }
});

test('Windows builds have a tracked full built-in gallery independent of the macOS app shell', () => {
  const wallpapers = fs.readdirSync(path.join(builtinDir, 'wallpapers')).filter((name) => /\.webp$/i.test(name));
  assert.ok(wallpapers.length > 1, 'tracked builtin gallery must contain more than the single override');
  assert.ok(fs.existsSync(path.join(builtinDir, 'nebula', 'theme.json')));
  assert.match(winBuild, /BUILTIN_SRC=\"\$DIR\/scripts\/builtin\"/);
});

test('Windows packaging fails closed when the official wallpaper gallery is unavailable', () => {
  assert.match(winBuild, /BUILTIN_SRC=.*WorkDaddy\.app[\\/]Contents[\\/]Resources[\\/]scripts[\\/]builtin/);
  assert.match(winBuild, /WALLPAPER_COUNT=.*find[\s\S]*builtin\/wallpapers/);
  assert.match(winBuild, /WALLPAPER_COUNT.*-le 0[\s\S]*exit 2/);
  assert.match(winBuild, /nebula[\\/]theme\.json/);
  assert.match(winBuild, /STAGE\/scripts\/builtin\/wallpapers/);
  assert.match(winBuild, /STAGE\/scripts\/builtin\/nebula\/theme\.json/);
  assert.match(winInstaller, /runtime\\node\\node\.exe/);
  assert.match(winInstaller, /\$wallpaperPayload\s*=\s*Join-Path\s+\$builtinPayload\s+'wallpapers'/);
  assert.match(winInstaller, /\$themePayload\s*=\s*Join-Path\s+\$builtinPayload\s+'nebula\\theme\.json'/);
  assert.match(winInstaller, /内置官方壁纸/);
  assert.match(winWorkflow, /::error::缺少内置资产/);
  assert.doesNotMatch(winWorkflow, /警告: 未找到 builtin/);
});

test('Windows asset status expands the source path under Bash nounset', () => {
  const statusLine = winBuild.split('\n').find((line) => line.includes('内置资产来源:'));
  assert.ok(statusLine);
  const result = spawnSync('bash', ['-u', '-c', `BUILTIN_SRC=/tmp/builtin; WALLPAPER_COUNT=12; ${statusLine}`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\/tmp\/builtin（12 张壁纸/);
});
