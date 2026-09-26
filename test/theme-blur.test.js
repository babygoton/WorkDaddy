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

test('theme pane keeps avatar controls visible and gates wallpaper controls to frosted takeover', () => {
  assert.doesNotMatch(inject, /背景与头像/);
  assert.match(inject, /wbs-avatar-card/);
  assert.match(inject, /<div class="wbs-pcard wbs-wallpaper-card wbs-theme-managed" id="wbs-wallpaper-card" style="display:none">/);
  assert.match(inject, /function syncWallpaperCardVisibility\(themeId\)/);
  assert.match(inject, /var visible = sessState\.themeTakeover/);
  assert.match(inject, /syncWallpaperCardVisibility\('nebula'\)/);
});

test('wallpaper loading leaves the loading state on daemon timeout and can retry', () => {
  const load = inject.slice(inject.indexOf('function loadWallpapers(force)'), inject.indexOf('\n    function setOpen(', inject.indexOf('function loadWallpapers(force)')));
  assert.match(load, /wallpaperTimeout/);
  assert.match(load, /Promise\.race\(\[wallpaperRequest, wallpaperTimeout\]\)/);
  assert.match(load, /grid\.dataset\.loaded = ''/);
  assert.match(load, /壁纸加载失败（daemon 不可达）/);
});

test('theme pane uses the requested blur labels and frosted glass switch', () => {
  assert.match(inject, /<div class="wbs-pcard-title">毛玻璃主题<\/div>/);
  assert.doesNotMatch(inject, /data-wbs-theme-option=/);
  assert.match(inject, /'毛玻璃': 'Frosted glass'/);
  assert.doesNotMatch(inject, /背景毛玻璃<span class="wbs-blur-hint">0% 不调节背景图<\/span>/);
  assert.match(inject, /<label class="wbs-blur-label" for="wbs-bg-blur-range">背景毛玻璃<\/label>/);
});
