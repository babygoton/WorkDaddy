const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const buildSource = fs.readFileSync(path.join(repoRoot, 'scripts', 'build-mac-dmg.sh'), 'utf8');
const backgroundPath = path.join(repoRoot, 'scripts', 'assets', 'macos-dmg-background.svg');

test('macOS DMG build stores a fixed commercial Finder layout', () => {
  assert.match(buildSource, /DMG_WINDOW_WIDTH=620/);
  assert.match(buildSource, /DMG_WINDOW_HEIGHT=400/);
  assert.match(buildSource, /DMG_ICON_SIZE=112/);
  assert.match(buildSource, /set bounds to \{windowLeft, windowTop, windowRight, windowBottom\}/);
  assert.match(buildSource, /set position of item appName to \{150, 190\}/);
  assert.match(buildSource, /set position of item "Applications" to \{470, 190\}/);
  assert.match(buildSource, /set background picture of viewOptions to file "\.background:background\.png"/);
  assert.match(buildSource, /set arrangement of viewOptions to not arranged/);
  assert.match(buildSource, /set icon size of viewOptions to dmgIconSize/);
  assert.match(buildSource, /set position of every item to \{windowRight \+ 100, 100\}/);
  assert.match(buildSource, /set bounds to \{windowLeft, windowTop, windowRight - 10, windowBottom - 10\}/);
});

test('macOS DMG layout is written to a writable image before final compression', () => {
  assert.match(buildSource, /hdiutil create[\s\S]*-format UDRW/);
  assert.match(buildSource, /hdiutil attach[\s\S]*-readwrite[\s\S]*-plist/);
  assert.match(buildSource, /plistlib\.load/);
  assert.match(buildSource, /entity\.get\('mount-point'\)/);
  assert.match(buildSource, /osascript[\s\S]*tell application "Finder"/);
  assert.match(buildSource, /test -f "\$MOUNT_DIR\/\.DS_Store"/);
  assert.match(buildSource, /rm -rf -- "\$MOUNT_DIR\/\.fseventsd"/);
  assert.match(buildSource, /hdiutil convert[\s\S]*-format UDZO/);
});

test('macOS DMG uses a fixed-size SVG master for its arrow artwork', () => {
  assert.equal(fs.existsSync(backgroundPath), true, 'missing DMG SVG background');
  const svg = fs.readFileSync(backgroundPath, 'utf8');
  assert.match(buildSource, /sips -s format png "\$DMG_BACKGROUND_SVG"/);
  assert.match(buildSource, /BACKGROUND_WIDTH[\s\S]*pixelWidth/);
  assert.match(buildSource, /BACKGROUND_HEIGHT[\s\S]*pixelHeight/);
  assert.match(svg, /<svg[^>]+viewBox="0 0 620 400"/);
  assert.match(svg, /<line\b[^>]+x1="246"[^>]+x2="382"/);
  assert.match(svg, /id="arrowhead"/);
  assert.match(svg, /<polyline\b[^>]+points="362,170 382,190 362,210"/);
  assert.doesNotMatch(svg, /<text\b/);
});
