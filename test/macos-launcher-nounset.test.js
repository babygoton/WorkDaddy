'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');

test('macOS launchers never expand an empty native argument array under bash nounset', () => {
  const files = [
    path.join(root, 'scripts', 'relaunch-with-cdp.sh'),
    path.join(root, 'scripts', 'relaunch-with-cdp-linux.sh'),
    path.join(root, 'scripts', 'build-mac-dmg.sh'),
  ];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(
      source,
      /"\$\{NATIVE_ARGS\[@\]\}"/,
      `${path.basename(file)} must not expand an empty array with bash set -u`,
    );
  }
});
