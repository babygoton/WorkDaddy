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
  assert.match(buildSource, /set background picture of viewOptions to file "\.background:background\.tiff"/);
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
  assert.match(buildSource, /BACKGROUND_1X="\$STAGE\/\.background\/background-1x\.png"/);
  assert.match(buildSource, /BACKGROUND_2X="\$STAGE\/\.background\/background-2x\.png"/);
  assert.match(buildSource, /sips -s format png "\$DMG_BACKGROUND_SVG" --out "\$BACKGROUND_1X"/);
  assert.match(buildSource, /sips -s format png -z 800 1240 "\$DMG_BACKGROUND_SVG" --out "\$BACKGROUND_2X"/);
  assert.match(buildSource, /tiffutil -cathidpicheck[\s\S]*background\.tiff/);
  assert.match(buildSource, /BACKGROUND_1X_WIDTH[\s\S]*pixelWidth/);
  assert.match(buildSource, /BACKGROUND_2X_WIDTH[\s\S]*pixelWidth/);
  assert.match(svg, /<svg[^>]+viewBox="0 0 620 400"/);
  assert.match(svg, /<path\b[^>]+id="install-arrow"/);
  assert.match(svg, /fill="#697386"/);
  assert.match(svg, /transform="translate\(296\.5 172\.5\) scale\(0\.35\)"/);
  assert.match(svg, /d="m50\.868 78\.016l36\.418-26\.055/);
  assert.doesNotMatch(svg, /<(?:line|polyline)\b/);
  assert.doesNotMatch(svg, /<text\b/);
});
