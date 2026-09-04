const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const daemon = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'daemon.js'), 'utf8');
const inject = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'inject.js'), 'utf8');

test('background blur persists as a normalized setting and is applied to the theme surface', () => {
  assert.match(daemon, /BACKGROUND_BLUR_FILE = path\.join\(DATA_DIR, 'background-blur\.json'\)/);
  assert.match(daemon, /MAX_BACKGROUND_BLUR_PX = 32/);
  assert.match(daemon, /p === '\/api\/blur'/);
  assert.match(daemon, /JSON\.stringify\(\{ blur \}, null, 2\)/);
  assert.match(daemon, /Math\.min\(1, Math\.max\(0, parseFloat\(body && body\.blur\)\)\)/);
  assert.match(daemon, /backdrop-filter:blur\(' \+ blurPx \+ 'px\)/);
  assert.match(daemon, /backdrop-filter:none;-webkit-backdrop-filter:none/);
});

test('theme pane exposes a percentage blur slider and syncs it with the daemon', () => {
  assert.match(inject, /id="wbs-bg-blur-range" min="0" max="100" step="1" value="0"/);
  assert.match(inject, /id="wbs-bg-blur-val">0%/);
  assert.match(inject, /api\('\/api\/blur'\)/);
  assert.match(inject, /JSON\.stringify\(\{ blur: pct \/ 100 \}\)/);
});

test('theme pane keeps avatar controls visible and gates wallpaper controls to WorkDaddy theme', () => {
  assert.doesNotMatch(inject, /背景与头像/);
  assert.match(inject, /wbs-avatar-card/);
  assert.match(inject, /<div class="wbs-pcard wbs-wallpaper-card" id="wbs-wallpaper-card" style="display:none">/);
  assert.match(inject, /function syncWallpaperCardVisibility\(themeId\)/);
  assert.match(inject, /var visible = themeId === 'nebula'/);
  assert.match(inject, /syncWallpaperCardVisibility\(id\)/);
  assert.match(inject, /syncWallpaperCardVisibility\(cur\)/);
});

test('theme pane uses the requested blur labels and nebula tab', () => {
  // 主题第 4 个 tab 文案为「毛玻璃」，且词典含英文 Frosted glass
  assert.match(inject, /data-theme="nebula">毛玻璃<\/button>/);
  assert.match(inject, /'毛玻璃': 'Frosted glass'/);
  assert.doesNotMatch(inject, /背景毛玻璃<span class="wbs-blur-hint">0% 不调节背景图<\/span>/);
  assert.match(inject, /<label class="wbs-blur-label" for="wbs-bg-blur-range">背景毛玻璃<\/label>/);
});
