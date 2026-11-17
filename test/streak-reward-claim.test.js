'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { fetchGrowthStreak, claimGrowthStreakReward } = require('../scripts/growth-active');
const daemon = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');
const ui = fs.readFileSync(path.join(__dirname, '../scripts/inject.js'), 'utf8');

test('streak tiers expose the official per-tier reward so the panel can list it', async () => {
  const r = await fetchGrowthStreak('sample-token', {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        code: 0,
        data: {
          streak: { days: 7, next_tier: '14d', next_tier_remaining: 7 },
          makeup_cards: { balance: 0 },
          redemption_status: {
            remaining_days: 7,
            tier_7d_status: 'available',
            tier_14d_status: 'locked',
            tier_28d_status: 'locked',
            tiers: [
              { tier: '7d', days: 7, credit: 0, energy: 2, cards: 1, chances: 1 },
              { tier: '14d', days: 14, credit: 50, energy: 3, cards: 1, chances: 1 },
              { tier: '28d', days: 28, credit: 150, energy: 5, cards: 1, chances: 1 },
            ],
          },
        },
      }),
    }),
  });
  assert.deepEqual(r.tiers.map((t) => ({ key: t.key, status: t.status, credit: t.credit, energy: t.energy, cards: t.cards, chances: t.chances })), [
    { key: '7d', status: 'available', credit: 0, energy: 2, cards: 1, chances: 1 },
    { key: '14d', status: 'locked', credit: 50, energy: 3, cards: 1, chances: 1 },
    { key: '28d', status: 'locked', credit: 150, energy: 5, cards: 1, chances: 1 },
  ]);
});

test('streak tiers fall back to documented rewards when the response omits them', async () => {
  const r = await fetchGrowthStreak('sample-token', {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: 0, data: { streak: { days: 3 }, redemption_status: { tiers: [{ tier: '7d' }] } } }),
    }),
  });
  assert.equal(r.tiers[0].energy, 2);
  assert.equal(r.tiers[1].credit, 50);
  assert.equal(r.tiers[2].credit, 150);
});

test('claim posts to the official redeem endpoint with the tier and a client token', async () => {
  const calls = [];
  const result = await claimGrowthStreakReward('sample-token', '14d', {
    clientToken: 'redeem-fixture',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 0, data: { credit_granted: 50, energy_granted: 3, cards_granted: 1, cards_overflow: 0, chances_granted: 1 } }),
      };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://www.workbuddy.cn/activity/growth/redeem');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.headers.authorization, 'Bearer sample-token');
  assert.deepEqual(JSON.parse(calls[0].init.body), { tier: '14d', client_token: 'redeem-fixture' });
  assert.deepEqual(result, { tier: '14d', credits: 50, energy: 3, cards: 1, cardsOverflow: 0, chances: 1 });
});

test('claim rejects unknown tiers before reaching the network', async () => {
  let called = false;
  for (const tier of ['', '30d', '7D', '../redeem', null, undefined, 7]) {
    await assert.rejects(claimGrowthStreakReward('sample-token', tier, {
      fetchImpl: async () => { called = true; throw new Error('should not run'); },
    }));
  }
  assert.equal(called, false);
});

test('claim treats any 409 as an already-redeemed tier, whatever the wording', async () => {
  // The live CN endpoint answers 409 with 「该档位本月已兑换」 (no "duplicate"
  // substring), so the status code must decide, not the message text.
  for (const msg of ['duplicate redeem', '该档位本月已兑换']) {
    await assert.rejects(
      claimGrowthStreakReward('sample-token', '7d', {
        fetchImpl: async () => ({ ok: false, status: 409, text: async () => JSON.stringify({ code: 409, msg }) }),
      }),
      (error) => error.status === 409 && error.duplicate === true && error.expired === false && error.message === msg,
    );
  }
});

test('claim marks expired logins on both HTTP and body codes', async () => {
  await assert.rejects(
    claimGrowthStreakReward('sample-token', '7d', {
      fetchImpl: async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ code: 401, msg: 'unauthorized' }) }),
    }),
    (error) => error.status === 401 && error.expired === true && error.duplicate === false,
  );
  await assert.rejects(
    claimGrowthStreakReward('sample-token', '7d', {
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: 403, msg: 'token expired' }) }),
    }),
    (error) => error.status === 200 && error.expired === true,
  );
});

test('daemon exposes a claim route that uses the account backup token', () => {
  const start = daemon.indexOf("  if (req.method === 'POST' && p === '/api/growth/streak/claim')");
  assert.ok(start > 0);
  const end = daemon.indexOf("  // 查询指定账号今日是否活跃", start);
  assert.ok(end > start);
  const route = daemon.slice(start, end);
  assert.match(route, /claimGrowthStreakReward\(token, tier/);
  assert.match(route, /\^\(7d\|14d\|28d\)\$/);
  assert.match(route, /growthStreakCache\.get\(uid, \{ force: true \}\)/);
  assert.match(route, /error && error\.duplicate/);
  assert.match(daemon, /claimGrowthStreakReward, createGrowthStreakCache \} = require\('\.\/growth-active\.js'\)/);
});

test('panel renders a direct claim button only for claimable tiers', () => {
  const start = ui.indexOf('    var GROWTH_TIER_NAMES = {');
  const end = ui.indexOf('    function dailyProgressPopoverHtml(', start);
  assert.ok(start > 0 && end > start);
  const ctx = {
    esc: (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    escAttr: (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
  };
  vm.createContext(ctx);
  vm.runInContext(ui.slice(start, end), ctx);

  const locked = ctx.growthStreakTierHtml({ key: '14d', days: 14, status: 'locked' }, 1, { uid: 'u1', progressDays: 5, claiming: {} });
  assert.doesNotMatch(locked, /data-wbs-streak-claim/);
  assert.match(locked, /还差 9 天/);

  const claimed = ctx.growthStreakTierHtml({ key: '7d', days: 7, status: 'claimed' }, 0, { uid: 'u1', progressDays: 7, claiming: {} });
  assert.doesNotMatch(claimed, /data-wbs-streak-claim/);
  assert.match(claimed, /已领取/);

  const claimable = ctx.growthStreakTierHtml({ key: '7d', days: 7, status: 'available', credit: 50, energy: 3, cards: 1, chances: 1 }, 0, { uid: 'u1', progressDays: 7, claiming: {} });
  assert.match(claimable, /data-wbs-streak-claim="7d"/);
  assert.match(claimable, />领取</);
  assert.match(claimable, /50 Credits · 3 能量 · 1 补登卡 · 1 抽奖/);

  const claiming = ctx.growthStreakTierHtml({ key: '7d', days: 7, status: 'available' }, 0, { uid: 'u1', progressDays: 7, claiming: { 'u1:7d': true } });
  assert.match(claiming, /disabled aria-disabled="true"/);
  assert.match(claiming, />领取中</);
});

test('panel escapes tier text and wires the claim click without switching accounts', () => {
  assert.match(ui, /data-wbs-streak-claim="' \+ escAttr\(key\) \+ '"/);
  assert.match(ui, /button\.hasAttribute\('data-wbs-streak-claim'\)/);
  assert.match(ui, /api\('\/api\/growth\/streak\/claim'/);
  assert.match(ui, /state\.streakClaiming\[key\] = true/);
  // Claiming must not require the account to be the current login.
  const clickStart = ui.indexOf("        if (button.hasAttribute('data-wbs-streak-claim')) {");
  const confirmAt = ui.indexOf('confirmCurrentGrowthAccount(uid).then(', ui.indexOf('function setupDailyProgressPopover'));
  assert.ok(clickStart > 0 && confirmAt > clickStart);
  const claimBranch = ui.slice(clickStart, confirmAt);
  assert.match(claimBranch, /claimStreakTierReward\(uid, button\.getAttribute\('data-wbs-streak-claim'\)\)/);
  assert.doesNotMatch(claimBranch, /confirmCurrentGrowthAccount/);
});

test('claim styles keep both themes and the compact tier layout', () => {
  assert.match(ui, /\.wbs-growth-tier\{grid-template-columns:52px 38px minmax\(0,1fr\) auto/);
  assert.match(ui, /\.wbs-growth-tier-claim\{[^}]*var\(--wb-button-primary-bg/);
  assert.match(ui, /\.wbs-growth-tier-claim\{[^}]*var\(--wb-button-primary-fg/);
  assert.match(ui, /\.wbs-growth-tier-claim\[disabled\]\{opacity:\.72/);
});
