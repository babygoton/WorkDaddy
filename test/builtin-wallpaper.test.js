'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const daemon = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'daemon.js'), 'utf8');
const macBuild = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build-mac-dmg.sh'), 'utf8');
const winBuild = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build-win-zip.sh'), 'utf8');
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

test('Windows release inputs include the complete tracked builtin gallery', () => {
  assert.ok(fs.existsSync(path.join(builtinDir, 'nebula', 'theme.json')));
  const wallpapers = fs.readdirSync(path.join(builtinDir, 'wallpapers'))
    .filter((name) => /^wallpaper-\d+\.webp$/i.test(name));
  assert.ok(wallpapers.length >= 12, `expected at least 12 official wallpapers, found ${wallpapers.length}`);
  for (let i = 1; i <= 12; i++) {
    assert.ok(fs.existsSync(path.join(builtinDir, 'wallpapers', `wallpaper-${String(i).padStart(2, '0')}.webp`)));
  }
  assert.match(winBuild, /BUILTIN_SRC="\$DIR\/scripts\/builtin"/);
  assert.match(winBuild, /内置资产没有任何官方壁纸/);
  assert.match(winWorkflow, /::error::缺少内置资产/);
  assert.doesNotMatch(winWorkflow, /警告: 未找到 builtin/);
});
