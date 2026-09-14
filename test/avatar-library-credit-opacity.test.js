'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../scripts/inject.js'), 'utf8');
function load() {
  const ctx = {};
  vm.runInNewContext(source.slice(source.indexOf('  function creditOpacity('), source.indexOf('  function checkinHtml(')), ctx);
  return ctx;
}
function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: k => values.get(k) || null, setItem: (k,v) => values.set(k,v), removeItem: k => values.delete(k) };
}
const png = 'data:image/png;base64,YQ==', webp = 'data:image/webp;base64,Yg==';
test('credit opacity clamps at one and thirty days and interpolates continuously', () => {
  const { creditOpacity } = load();
  for (const days of [-10,0,0.5,1]) assert.equal(creditOpacity(days),0.05);
  for (const days of [30,31,1000]) assert.equal(creditOpacity(days),1);
  assert.equal(creditOpacity(15.5),0.525);
  assert.ok(Math.abs(creditOpacity(2)- (0.05+0.95/29)) < 1e-12);
  assert.equal(creditOpacity(null),1);
});
test('legacy upload survives selecting either preset and adding multiple avatars', () => {
  const { createAvatarLibrary } = load(), cache = storage({wbsAvatar:png});
  const lib = createAvatarLibrary(cache);
  assert.equal(lib.snapshot().items[0].src,png);
  lib.select('workbuddy'); lib.select('workdaddy');
  const added = lib.add(webp);
  assert.equal(lib.snapshot().items.length,2);
  assert.equal(lib.snapshot().selected,added);
  const restored = createAvatarLibrary(cache);
  assert.equal(restored.snapshot().selected,added);
  assert.equal(restored.snapshot().items[0].src,png);
  restored.select('workbuddy');
  restored.remove(added);
  assert.equal(restored.snapshot().selected,'workdaddy');
  assert.equal(restored.snapshot().items.length,1);
  restored.remove(restored.snapshot().items[0].id);
  assert.equal(createAvatarLibrary(cache).snapshot().items.length,0);
});
test('failed avatar persistence preserves all existing images and selection', () => {
  const { createAvatarLibrary } = load(), cache = storage({wbsAvatar:png});
  const lib = createAvatarLibrary(cache);lib.select('workbuddy');
  const before = JSON.stringify(lib.snapshot());
  cache.setItem = () => { throw Error('quota'); };
  assert.throws(()=>lib.add(webp));
  assert.equal(JSON.stringify(lib.snapshot()),before);
  assert.throws(()=>lib.select('workdaddy'));
  assert.equal(JSON.stringify(lib.snapshot()),before);
});
test('usage background does not follow robot appearance and pointer focus has no robot outline', () => {
  const start=source.indexOf('    function onTokenStats()');
  const stats=source.slice(start,source.indexOf('    // ===== Tab',start));
  assert.doesNotMatch(stats,/glassFab|wbs-token-stats-glass|data-wbs-robot-style/);
  assert.doesNotMatch(source,/\.wbs-robot-option:focus-within/);
  assert.match(source,/\.wbs-robot-option:has\(input:focus-visible\)/);
});
