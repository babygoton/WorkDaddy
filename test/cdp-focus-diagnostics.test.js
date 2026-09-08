const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const daemon = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'daemon.js'), 'utf8');

test('CDP diagnostics capture target, viewport, focus and mouse coordinates before clicks', () => {
  assert.match(daemon, /function cdpFocusDiagnostics\(/);
  assert.match(daemon, /document\.activeElement/);
  assert.match(daemon, /window\.innerWidth/);
  assert.match(daemon, /cdp-focus-diagnostics/);
  assert.match(daemon, /clickByText:before-mouse/);
  assert.match(daemon, /Input\.dispatchMouseEvent/);
  assert.match(daemon, /async function cdpMouseClick\(/);
  assert.match(daemon, /automation:ensureNewTask/);
  assert.match(daemon, /automation:sendPhrase/);
});

test('automation lifecycle diagnostics record panel and task boundaries', () => {
  assert.match(daemon, /automation-focus-diagnostics/);
  assert.match(daemon, /automation:start/);
  assert.match(daemon, /automation:panel-close/);
  assert.match(daemon, /automation:finish/);
});
