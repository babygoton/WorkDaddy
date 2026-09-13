'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
test('macOS staging copies every top-level daemon module dependency', () => {
  const root = path.join(__dirname, '..', 'scripts');
  const daemon = fs.readFileSync(path.join(root, 'daemon.js'), 'utf8');
  const build = fs.readFileSync(path.join(root, 'build-mac-dmg.sh'), 'utf8');
  const list = build.match(/for f in ([^\n]+); do/)[1].split(/\s+/);
  for (const match of daemon.matchAll(/^.*require\(['"]\.\/([^'"]+\.js)['"]\).*$/gm)) {
    if (/^\s/.test(match[0])) continue; // Nested optional/platform-specific imports.
    assert.ok(list.includes(match[1]), `macOS staging missing ${match[1]}`);
  }
});
