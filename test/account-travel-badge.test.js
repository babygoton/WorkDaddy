'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ui = fs.readFileSync(path.join(__dirname, '../scripts/inject.js'), 'utf8');

test('account cards no longer render the separate daily travel label', () => {
  assert.doesNotMatch(ui, /今日已派猫|今日未派猫|travelBadgeHtml|wbs-travel-slot/);
  assert.match(ui, /dailyRingsHtml\(a\) \+ checkinBadge \+ modelRateLimitBadge/);
});

test('the daily popup marks travel status with a dim or highlighted cat icon', () => {
  const start = ui.indexOf('    function dailyCatTravelIcon(cat)');
  const end = ui.indexOf('    function formatGrowthTaskDeadline', start);
  assert.ok(start >= 0 && end > start, 'daily travel icon helper must stay extractable');
  const ctx = { WORKBUDDY_CAT_MARK: '__CAT_MARK__' };
  vm.createContext(ctx);
  const vesselStart = ui.indexOf('    function dailyRingsSvg(');
  const vesselEnd = ui.indexOf('    function dailyRingsHtml(', vesselStart);
  vm.runInContext(ui.slice(vesselStart, vesselEnd) + ui.slice(start, end), ctx);

  assert.match(ctx.dailyCatTravelIcon({ state: 'idle' }), /wbs-daily-vessel wbs-daily-cat-status-icon is-empty/);
  for (const cat of [
    { state: 'traveling' },
    { state: 'arrived' },
    { state: 'idle', dailyLimitReached: true },
  ]) {
    assert.match(ctx.dailyCatTravelIcon(cat), /wbs-daily-vessel wbs-daily-cat-status-icon is-checked-in/);
  }
  assert.match(ui, /dailyCatTravelIcon\(cat\).*dailyCatDetail\(cat\)/);
  assert.match(ctx.dailyCatTravelIcon({ state: 'idle' }), /wbs-daily-liquid.*wbs-daily-cat-mark/);
  assert.match(ui, /return dailyCatVessel\(isDailyCatSent\(cat\)/);
  assert.match(ui, /\.wbs-daily-cat-status-icon\{width:16px;height:16px;flex:0 0 16px/);
});
