'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createUsageActivity } = require('../scripts/inject.js');

test('foreground activity is throttled, rolls over at Beijing midnight and cleans up', () => {
  const listeners = new Map();
  const doc = { visibilityState: 'visible', hasFocus: () => true,
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: name => listeners.delete(name) };
  let time = Date.parse('2026-09-10T15:59:00Z'), enabled = true, calls = 0;
  const activity = createUsageActivity({ document: doc, window: doc, now: () => time,
    enabled: () => enabled, send: (...args) => { assert.equal(args.length, 0); calls++; } });
  assert.equal(calls, 1);
  listeners.get('keydown')({ isTrusted: true, key: 'private' });
  assert.equal(calls, 1);
  time += 60000;
  listeners.get('keydown')({ isTrusted: false });
  assert.equal(calls, 1);
  listeners.get('keydown')({ isTrusted: true });
  assert.equal(calls, 2);
  time += 3600000;
  doc.visibilityState = 'hidden'; activity.notify();
  doc.visibilityState = 'visible'; doc.hasFocus = () => false; activity.notify();
  doc.hasFocus = () => true; enabled = false; activity.notify();
  assert.equal(calls, 2);
  enabled = true; activity.notify();
  assert.equal(calls, 3);
  activity.destroy();
  assert.equal(listeners.size, 0);
  time += 3600000; activity.notify();
  assert.equal(calls, 3);
});

test('usage route retains local authorization and About describes anonymous counts', () => {
  const daemon = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');
  const inject = fs.readFileSync(path.join(__dirname, '../scripts/inject.js'), 'utf8');
  const publicPaths = daemon.match(/const PUBLIC_API_PATHS = new Set\(([\s\S]*?)\);/);
  assert.ok(publicPaths);
  assert.doesNotMatch(publicPaths[1], /\/api\/usage/);
  assert.match(inject, /registerDisposer\(function \(\) \{ usageActivity.destroy\(\); \}\)/);
  assert.match(inject, /匿名安装数和日活/);
});
