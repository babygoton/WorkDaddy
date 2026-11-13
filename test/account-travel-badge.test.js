'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const uiPath = path.join(__dirname, '../scripts/inject.js');
const ui = fs.readFileSync(uiPath, 'utf8');
const HELPERS_START = ui.indexOf('    function isTodayBeijing');
const HELPERS_END = ui.indexOf('    function modelLimitKind', HELPERS_START);

function badgeContext(overrides = {}) {
  assert.ok(HELPERS_START > 0 && HELPERS_END > HELPERS_START, 'travel badge helpers must stay extractable');
  const ctx = Object.assign({
    WBS_PROFILE_IS_AI: false,
    CAPS: { growthDaily: true },
    WBS_LANGUAGE: 'zh',
    wbsTranslateString: (value) => value,
    esc: (value) => String(value),
    escAttr: (value) => String(value),
  }, overrides);
  vm.createContext(ctx);
  vm.runInContext(ui.slice(HELPERS_START, HELPERS_END), ctx);
  return ctx;
}

function account(cat, progressOverrides = {}) {
  return {
    dailyProgress: Object.assign({
      status: 'ready',
      fetchedAt: Date.now(),
      cat,
    }, progressOverrides),
  };
}

test('official travel status decides "sent today" without inferring claim dates', () => {
  const ctx = badgeContext();
  const cases = [
    [{ state: 'idle', dailyLimitReached: false, available: true }, 'pending', '今日未派猫'],
    [{ state: 'needs_selection', dailyLimitReached: false, available: true }, 'pending', '今日未派猫'],
    [{ state: 'traveling', dailyLimitReached: false, available: true }, 'ok', '今日已派猫'],
    [{ state: 'arrived', dailyLimitReached: false, available: true }, 'ok', '今日已派猫'],
    [{ state: 'idle', dailyLimitReached: true, available: true }, 'ok', '今日已派猫'],
  ];
  for (const [cat, cls, label] of cases) {
    const html = ctx.travelBadgeHtml(account(cat));
    assert.match(html, /wbs-travel-slot/);
    assert.match(html, new RegExp('wbs-checkin-tag ' + cls));
    assert.match(html, new RegExp(label));
    assert.doesNotMatch(html, /领取|领过奖/, 'the badge must not claim anything about reward claiming');
  }
});

test('missing, non-ready and yesterday snapshots never claim a result for today', () => {
  const ctx = badgeContext();
  const idle = { state: 'idle', dailyLimitReached: false, available: true };
  assert.equal(ctx.travelBadgeHtml({}), '');
  assert.equal(ctx.travelBadgeHtml(account(idle, { status: 'unavailable' })), '');
  assert.equal(ctx.travelBadgeHtml({ dailyProgress: { status: 'ready', cat: idle } }), '');
  assert.equal(ctx.travelBadgeHtml(account(idle, { fetchedAt: Date.now() - 2 * 86400000 })), '');
  assert.equal(ctx.travelBadgeHtml(account(idle, { fetchedAt: 0 })), '');
  assert.equal(ctx.isTodayBeijing(Date.now()), true);
  assert.equal(ctx.isTodayBeijing(Date.now() - 2 * 86400000), false);
});

test('accounts without an unlocked Buddy show no travel badge instead of a misleading pending state', () => {
  const ctx = badgeContext();
  for (const cat of [
    { state: 'locked', available: false },
    { state: 'idle', available: false },
    { state: 'unknown', available: true },
  ]) {
    assert.equal(ctx.travelBadgeHtml(account(cat)), '');
  }
});

test('AI profiles and clients without growthDaily stay untouched', () => {
  assert.equal(badgeContext({ WBS_PROFILE_IS_AI: true })
    .travelBadgeHtml(account({ state: 'traveling', available: true })), '');
  assert.equal(badgeContext({ CAPS: { growthDaily: false } })
    .travelBadgeHtml(account({ state: 'traveling', available: true })), '');
});

test('English UI uses the shared dictionary entries', () => {
  const dictionary = {
    '今日已派猫': 'Buddy sent today',
    '今日未派猫': 'Buddy not sent today',
  };
  const ctx = badgeContext({
    WBS_LANGUAGE: 'en',
    wbsTranslateString: (value) => dictionary[value] || value,
  });
  assert.match(ctx.travelBadgeHtml(account({ state: 'traveling', available: true })), /Buddy sent today/);
  assert.match(ctx.travelBadgeHtml(account({ state: 'idle', available: true })), /Buddy not sent today/);
  assert.match(ui, /'今日已派猫': 'Buddy sent today', '今日未派猫': 'Buddy not sent today'/);
});

test('the badge is a pure renderer: no new API calls or endpoints', () => {
  const helpers = ui.slice(HELPERS_START, HELPERS_END);
  assert.doesNotMatch(helpers, /\bapi\(|fetch\(|XMLHttpRequest/);
  // The existing single-account refresh and the existing batch refresh remain the only callers.
  assert.equal((ui.match(/api\('\/api\/growth\/daily-progress'/g) || []).length, 2);
  assert.match(helpers, /dailyProgress/, 'the badge must consume the existing batch snapshot');
});

test('badge is wired into card rendering, incremental refresh and shared slot CSS', () => {
  assert.match(ui, /\+ checkinBadge \+ travelBadge \+ modelRateLimitBadge/);
  const updater = ui.slice(
    ui.indexOf('    function updateDailyProgressCells()'),
    ui.indexOf('    function accountCardLayoutKey()'),
  );
  assert.ok(updater.length > 0);
  assert.match(updater, /wbs-travel-slot/);
  assert.match(updater, /travelBadgeHtml\(account\)/);
  assert.match(ui, /\.wbs-checkin-slot,\.wbs-travel-slot\{/);
  assert.doesNotMatch(ui, /DAEMON_BUILD_ID/, 'inject.js is re-read on every injection; daemon.js needs no version bump');
});
