const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const generator = fs.readFileSync(path.join(repoRoot, 'scripts', 'make-icon.py'), 'utf8');
const foreground = path.join(repoRoot, 'scripts', 'assets', 'workdaddy-icon-foreground.png');

test('application icon generator shares the website SVG across platforms', () => {
  assert.equal(fs.existsSync(foreground), true, 'missing tracked icon foreground');
  assert.match(generator, /SOURCE = .*workdaddy-logo\.svg/);
  assert.match(generator, /rsvg-convert/);
  assert.match(generator, /MAC_OUT = .*WorkDaddy\.icns/);
  assert.match(generator, /WIN_OUT = .*WorkDaddy\.ico/);
});

test('macOS packaging synchronizes the tracked application icon', () => {
  const buildSource = fs.readFileSync(path.join(repoRoot, 'scripts', 'build-mac-dmg.sh'), 'utf8');
  assert.match(buildSource, /APP_ICON="\$DIR\/scripts\/assets\/WorkDaddy\.icns"/);
  assert.match(buildSource, /cp "\$APP_ICON" "\$APP\/Contents\/Resources\/AppIcon\.icns"/);
  assert.match(buildSource, /CFBundleIconName/);
});

test('application icons preserve the website rounded alpha mask without an extra background', () => {
  const svg = fs.readFileSync(path.join(repoRoot, 'scripts/assets/workdaddy-logo.svg'), 'utf8');
  assert.match(svg, /clip-path="url\(#app-mask\)"/);
  assert.match(svg, /#34363d/);
  assert.doesNotMatch(generator, /xc:|CopyOpacity/);
  assert.match(generator, /build_windows_icon\(magick, temp_dir, base\)/);
});

test('macOS application icon uses the same rendered logo as Windows', () => {
  const macBuilder = generator.slice(
    generator.indexOf('def build_mac_icon'),
    generator.indexOf('def build_windows_icon'),
  );
  assert.match(macBuilder, /render_size\(magick, base, size/);
  assert.match(generator, /build_mac_icon\(magick, iconutil, temp_dir, base\)/);
});

test('iconutil inputs use full RGBA PNGs so macOS keeps every icon size', () => {
  assert.match(generator, /-type', 'TrueColorAlpha'/);
  assert.match(generator, /-colorspace', 'sRGB'/);
});

// Inspect the shipped raster, including its actual artwork rather than just canvas size.
function readRgbaPng(file) {
  const zlib = require('node:zlib');
  const png = fs.readFileSync(file);
  assert.equal(png.readUInt8(24), 8, 'icon must use 8-bit channels');
  assert.equal(png.readUInt8(25), 6, 'icon must use RGBA');
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20), chunks = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const raw = zlib.inflateSync(Buffer.concat(chunks)), stride = width * 4;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1), filter = raw[row];
    assert.ok(filter <= 4, 'unsupported PNG filter');
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x;
      const a = x >= 4 ? pixels[i - 4] : 0, b = y ? pixels[i - stride] : 0;
      const c = y && x >= 4 ? pixels[i - stride - 4] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const predictor = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      pixels[i] = (raw[row + 1 + x] + predictor) & 255;
    }
  }
  return { width, height, pixels };
}

test('application artwork fills the tile without clipping the robot or antenna', () => {
  const { width, height, pixels } = readRgbaPng(foreground);
  let left = width, right = 0, top = height, bottom = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    // The cream robot is distinct from its dark tile and green eyes/shadow.
    if (pixels[i + 3] > 240 && Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) > 135) {
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
  }
  assert.ok((right - left + 1) / width >= .85, 'robot has excessive horizontal padding');
  assert.ok((bottom - top + 1) / height >= .85, 'robot has excessive vertical padding');
  assert.ok(left / width >= .025 && (width - 1 - right) / width >= .025, 'robot sides must stay inside the tile');
  assert.ok(top / height >= .025 && (height - 1 - bottom) / height >= .025, 'antenna and robot base must not be clipped');
});
