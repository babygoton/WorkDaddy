'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createThemeTextShadow } = require('../scripts/theme-text-shadow.js');

test('message shadow defaults on, persists off and only affects frosted message documents', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbs-shadow-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'shadow.json');
  const store = createThemeTextShadow(file);
  assert.equal(store.read(), true);
  const daemon = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');
  const context = { loadThemePatches: () => require('../scripts/theme-patches.js'), themeTextShadow: store };
  const start = daemon.indexOf('function themeExtrasCss(id)');
  vm.runInNewContext(daemon.slice(start, daemon.indexOf('\n/**', start)), context);
  const shadow = 'text-shadow:0 1px 2px';
  assert.ok(context.themeExtrasCss('nebula').includes(shadow));
  for (const id of ['default', 'eye-care', 'cyber-purple']) assert.ok(!context.themeExtrasCss(id).includes(shadow));
  store.save({ enabled: false });
  assert.equal(createThemeTextShadow(file).read(), false);
  assert.ok(!context.themeExtrasCss('nebula').includes(shadow));
  assert.ok(context.themeExtrasCss('nebula').includes(':is(.workbuddy-topbar--mac,.conversation-shell,.conversation-sidebar)'), 'disabling shadow preserves transparent backgrounds');
  for (const input of [null, {}, { enabled: 'false' }]) assert.throws(() => store.save(input));
  assert.equal(store.read(), false);
  store.save({ enabled: true });
  assert.ok(context.themeExtrasCss('nebula').includes(shadow));
  const patch = require('../scripts/theme-patches.js').find(p => p.id === 'patch-101');
  assert.ok(patch.css.includes('.conversation-timeline .cr-document *'));
  assert.ok(!patch.css.includes('.cr-input'));
});

test('text color controls and their backend overrides have been removed', () => {
  const inject = fs.readFileSync(path.join(__dirname, '../scripts/inject.js'), 'utf8');
  const daemon = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');
  assert.doesNotMatch(inject + daemon, /wbs-text-colors|themeTextColors|api\/theme-text-colors/);
  assert.match(inject, /id="wbs-text-shadow" checked disabled/);
});
