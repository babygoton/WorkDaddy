const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const generator = fs.readFileSync(path.join(repoRoot, 'scripts', 'make-icon.py'), 'utf8');
const foreground = path.join(repoRoot, 'scripts', 'assets', 'workdaddy-icon-foreground.png');

test('application icon generator shares the requested background across platforms', () => {
  assert.equal(fs.existsSync(foreground), true, 'missing tracked icon foreground');
  assert.match(generator, /BACKGROUND = '#e1e1e1'/);
  assert.match(generator, /MAC_OUT = .*WorkDaddy\.icns/);
  assert.match(generator, /WIN_OUT = .*WorkDaddy\.ico/);
});

test('macOS packaging synchronizes the tracked application icon', () => {
  const buildSource = fs.readFileSync(path.join(repoRoot, 'scripts', 'build-mac-dmg.sh'), 'utf8');
  assert.match(buildSource, /APP_ICON="\$DIR\/scripts\/assets\/WorkDaddy\.icns"/);
  assert.match(buildSource, /cp "\$APP_ICON" "\$APP\/Contents\/Resources\/AppIcon\.icns"/);
  assert.match(buildSource, /CFBundleIconName/);
});

test('Windows application icon applies a rounded alpha mask', () => {
  assert.match(generator, /WINDOWS_CORNER_RADIUS_RATIO = 0\.20/);
  assert.match(generator, /roundrectangle 0,0 1023,1023/);
  assert.match(generator, /'CopyOpacity'/);
  assert.match(generator, /render_base\(magick, base, rounded=True\)/);
});

test('macOS application icon leaves the background to the system mask', () => {
  const macBuilder = generator.slice(
    generator.indexOf('def build_mac_icon'),
    generator.indexOf('def build_windows_icon'),
  );
  assert.match(macBuilder, /render_base\(magick, base, rounded=False, with_background=False\)/);
});

test('iconutil inputs use full RGBA PNGs so macOS keeps every icon size', () => {
  assert.match(generator, /-type', 'TrueColorAlpha'/);
  assert.match(generator, /-colorspace', 'sRGB'/);
});
