'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const inject = fs.readFileSync(path.join(__dirname, '../scripts/inject.js'), 'utf8');
const daemon = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');

test('account cards render task progress as a cat liquid badge before check-in status', () => {
  assert.match(inject, /wbs-daily-rings/);
  assert.match(inject, /wbs-daily-vessel/);
  assert.match(inject, /wbs-daily-liquid/);
  assert.match(inject, /wbs-daily-cat-mark/);
  assert.match(inject, /--wbs-liquid-level:/);
  assert.match(inject, /WORKBUDDY_CAT_MARK/);
  assert.match(inject, /mask-image:var\(--wbs-workbuddy-cat\)/);
  assert.doesNotMatch(inject, /dailyStatusRing/);
  assert.doesNotMatch(inject, /wbs-daily-ring-track|wbs-daily-ring-progress|wbs-daily-center-dot/);
  assert.match(inject, /tabindex="0"/);
  assert.match(inject, /--wbs-ring-growth/);
  assert.match(inject, /--wbs-ring-cat/);
  assert.match(inject, /prefers-reduced-motion:reduce/);
  assert.match(inject, /html\.cb-dark[\s\S]*--wbs-ring-growth/);
  assert.match(inject, /badge \+ dailyRingsHtml\(a\) \+ checkinBadge/);
  assert.match(inject, /\.wbs-daily-rings\{[^}]*height:22px/);
  assert.match(inject, /\.wbs-daily-rings\{[^}]*border:0/);
  assert.match(inject, /wbs-daily-streak-label/);
  assert.match(inject, /连续登录 /);
  assert.doesNotMatch(inject, />活跃 .* 天</);
  assert.match(inject, /\.wbs-daily-vessel\{[^}]*border-radius:50%/);
  assert.match(inject, /\.wbs-daily-liquid\{[^}]*height:var\(--wbs-liquid-level/);
  assert.match(inject, /\.wbs-daily-cat-mark\{[^}]*transform:rotate\(30deg\)/);
  assert.match(inject, /\.wbs-daily-cat-mark\{[^}]*background:var\(--wbs-liquid-ink\)/);
  const hoverRule = inject.match(/\.wbs-daily-rings:hover[^']+/);
  assert.ok(hoverRule);
  assert.doesNotMatch(hoverRule[0], /border(?:-color)?:/);
});

test('daily activity and credit nodes reuse one theme-aware colored popover', () => {
  assert.match(inject, /wbs-status-popover/);
  assert.match(inject, /showStatusPopover\(segment/);
  assert.match(inject, /showStatusPopover\(ring/);
  assert.doesNotMatch(inject, /className = 'wbs-credit-tooltip'/);
  assert.match(inject, /\.wbs-daily-detail i\.credit\{color:var\(--wbs-tip-credit\)\}/);
  assert.match(inject, /body\[data-vscode-theme-name\*="dark" i\][\s\S]*--wbs-ring-cat/);
  assert.match(inject, /function onTokenStats\(\) \{\s*if \(typeof hideCreditTooltip === 'function'\) hideCreditTooltip\(\);\s*if \(typeof closeDailyProgressPopover === 'function'\) closeDailyProgressPopover\(\);/);
  assert.match(inject, /\} else \{\s*if \(typeof hideCreditTooltip === 'function'\) hideCreditTooltip\(\);\s*if \(typeof closeDailyProgressPopover === 'function'\) closeDailyProgressPopover\(\);\s*state\.accountRefreshId/);
  assert.match(inject, /成长计划/);
  assert.match(inject, /Buddy 旅行/);
  assert.match(inject, /开启盲盒/);
  assert.match(inject, /待抽奖/);
  assert.match(inject, /未派出/);
  assert.match(inject, /解锁 Buddy 后可使用/);
  assert.doesNotMatch(inject, /猫猫日常|猫猫在家|今日达成/);
  assert.doesNotMatch(inject, /<span>积分节点<\/span>/);
  assert.doesNotMatch(inject, /<span>任务奖励<\/span>/);
  assert.doesNotMatch(inject, /每档每月限领一次/);
  assert.doesNotMatch(inject, /仍需手动：/);
});

test('daily progress is fetched in batches and never changes account card layout keys', () => {
  assert.match(inject, /\/api\/growth\/daily-progress/);
  assert.match(inject, /fetchDailyProgressForAccounts/);
  const keyStart = inject.indexOf('function accountCardLayoutKey()');
  const keyEnd = inject.indexOf('function pollAutoCopyJob', keyStart);
  assert.doesNotMatch(inject.slice(keyStart, keyEnd), /dailyProgress/);
});

test('hover refreshes one account in place and exposes loading, timestamp, and reward tiers', () => {
  assert.match(inject, /refreshDailyProgressAccount\(uid\)/);
  assert.match(inject, /body: JSON\.stringify\(\{ uids: \[uid\], force: true \}\)/);
  assert.match(inject, /incoming\.status === 'ready' \|\| !account\.dailyProgress \|\| account\.dailyProgress\.status !== 'ready'/);
  assert.match(inject, /wbs-daily-refresh-spinner/);
  assert.match(inject, /刷新于/);
  assert.match(inject, /入门档/);
  assert.match(inject, /进阶档/);
  assert.match(inject, /巅峰档/);
  assert.match(inject, /还差.*天/);
  assert.doesNotMatch(inject, /请稍后重新打开面板刷新/);
  assert.match(inject, /\.wbs-daily-detail>span\{[^}]*white-space:nowrap/);
  assert.match(inject, /\.wbs-daily-actions\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(inject, /formatDailyTravelCountdown/);
  assert.match(inject, /data-wbs-travel-countdown/);
  assert.match(inject, /setBuildInterval\(updateDailyTravelCountdowns, 1000\)/);
  assert.match(inject, /旅行中，剩余/);
  assert.match(inject, /wbs-growth-task-list/);
  assert.match(inject, /wbs-growth-task-row/);
  assert.match(inject, /成长任务/);
  assert.match(inject, /wbs-growth-task-meta/);
  const popoverSource = inject.slice(inject.indexOf('function dailyProgressPopoverHtml(account)'), inject.indexOf('function showDailyProgressPopover'));
  assert.match(popoverSource, /wbs-growth-task-head.*成长任务/);
  assert.doesNotMatch(popoverSource, /wbs-daily-detail growth-row/);
  assert.match(popoverSource, /wbs-growth-task-guide/);
  assert.match(popoverSource, /task\.guide/);
  assert.match(popoverSource, /<label>进度<\/label>/);
  assert.match(popoverSource, /task\.tag/);
  assert.match(popoverSource, /data-wbs-growth-official>去完成<\/button>/);
  assert.doesNotMatch(popoverSource, /acceptAllButton|hasUnaccepted/);
  assert.match(popoverSource, /展开已领取/);
  assert.match(popoverSource, /收起已领取/);
  assert.match(inject, /state\.dailyClaimedExpanded/);
  assert.match(inject, /data-wbs-claimed-toggle/);
  assert.match(inject, /截止/);
  assert.match(inject, /奖励/);
  assert.match(inject, /补登卡/);
  assert.match(inject, /待领取礼物/);
  assert.match(inject, /\.wbs-status-popover\.is-daily\{width:620px/);
  assert.match(inject, /\.wbs-status-popover\.is-daily\{[^}]*scrollbar-width:none/);
  assert.match(inject, /\.wbs-status-popover\.is-daily::\-webkit-scrollbar,\.wbs-growth-task-list::\-webkit-scrollbar\{display:none\}/);
  assert.match(inject, /\.wbs-growth-task-list\{[^}]*scrollbar-width:none/);
  assert.match(inject, /left = rect\.left - tipRect\.width - gap;[\s\S]*if \(left < 8\) left = rect\.right \+ gap;/);
  assert.match(inject, /var dailyPopoverHovered = false/);
  assert.match(inject, /if \(\(pinned \|\| dailyPopoverHovered\) && !force\) return/);
  assert.match(inject, /listen\(popup, 'mouseenter', function \(\) \{ dailyPopoverHovered = true; clearTimeout\(hideTimer\); \}\)/);
});

test('growth task details sort unfinished deadlines first and render subdued reward tags', () => {
  const source = inject.match(/function sortGrowthTasks\(tasks\) \{[\s\S]*?\n    \}/);
  assert.ok(source, 'growth task sorter should remain extractable');
  const sort = Function(source[0] + '\nreturn sortGrowthTasks;')();
  const result = sort([
    { title: '已完成', state: 'completed', deadline: '2026-09-18T00:00:00+08:00' },
    { title: '无期限', state: 'in_progress', deadline: null },
    { title: '较晚', state: 'not_accepted', deadline: '2026-09-20T00:00:00+08:00' },
    { title: '最近', state: 'in_progress', deadline: '2026-09-19T00:00:00+08:00' },
    { title: '已领取', state: 'claimed', deadline: '2026-09-17T00:00:00+08:00' },
  ]);
  assert.deepEqual(result.map((task) => task.title), ['最近', '较晚', '无期限', '已完成', '已领取']);
  assert.match(inject, /wbs-growth-reward-tags/);
  assert.match(inject, /wbs-growth-reward-tag/);
  assert.match(inject, /growthTaskRewardHtml\(task\)/);
  assert.match(inject, /\.wbs-growth-reward-tag\{[^}]*color:var\(--wb-color-text-secondary/);
  assert.doesNotMatch(inject, /\.wbs-growth-reward-tag\{[^}]*color:var\(--wbs-ring-growth\)/);
});

test('growth primary is green in light and blue-purple in dark, cyber, and glass themes', () => {
  assert.match(inject, /--wbs-primary:#22c55e;--wbs-primary-rgb:34,197,94;--wbs-primary-ink:#22c55e/);
  ['dark', 'cyber-purple', 'nebula'].forEach((themeId) => {
    assert.match(inject, new RegExp('html\\[data-wbs-theme-id="' + themeId + '"\\][\\s\\S]*--wbs-primary:#7f77dd;--wbs-primary-rgb:127,119,221;--wbs-primary-ink:#7f77dd'));
  });
  assert.doesNotMatch(inject, /html\[data-wbs-theme-id="eye-care"\][^']*--wbs-primary:#7f77dd/);
  assert.match(inject, /\.wbs-daily-rings,\.wbs-checkin-tag\.ok\{[^}]*color:var\(--wbs-badge-fg\)/);
  assert.doesNotMatch(inject, /\.wbs-ck\.ok\{color:inherit\}/);
  assert.match(inject, /html\[data-wbs-theme-id="nebula"\][^']*\.wbs-checkin-tag\.ok\{[^}]*backdrop-filter:blur/);
  assert.match(inject, /\.wbs-growth-rewards-head em\{[^}]*color:var\(--wb-icon-tertiary/);
  assert.match(inject, /\.wbs-growth-tier b\{[^}]*color:var\(--wb-color-text-secondary/);
});

test('growth actions open the official center and never write through local growth routes', async () => {
  assert.match(inject, /https:\/\/www\.workbuddy\.cn\/profile\/growth-center/);
  assert.match(inject, /data-wbs-growth-official/);
  assert.match(inject, /api\('\/api\/open-url'/);
  assert.match(inject, /\/api\/growth\/daily-progress/);
  const source = inject.match(/function openOfficialGrowthCenter\(\) \{[\s\S]*?\n    \}/);
  assert.ok(source);
  const calls = [];
  const open = Function('api', 'toast', 'root', source[0] + '\nreturn openOfficialGrowthCenter;')(
    (route, options) => { calls.push({ route, options }); return Promise.resolve(); },
    () => assert.fail('opening the official site should not toast success'),
    {}
  );
  open();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].route, '/api/open-url');
  assert.deepEqual(JSON.parse(calls[0].options.body), { url: 'https://www.workbuddy.cn/profile/growth-center' });
  await Promise.resolve();
  for (const suffix of ['tasks/accept', 'tasks/accept-all', 'buddy/first', 'buddy/travel/claim', 'buddy/select', 'buddy/travel/depart', 'buddy/open', 'lottery/draw']) {
    assert.doesNotMatch(inject, new RegExp('/api/growth/' + suffix));
    assert.doesNotMatch(daemon, new RegExp("p === '/api/growth/" + suffix + "'"));
  }
});

test('growth window buttons use the live current account and leave other accounts untouched', async () => {
  const guardSource = inject.match(/function confirmCurrentGrowthAccount\(uid\) \{[\s\S]*?\n    \}/);
  assert.ok(guardSource);
  const calls = [], toasts = [];
  let current = 'a';
  const guard = Function('api', 'toast', 'root', guardSource[0] + '\nreturn confirmCurrentGrowthAccount;')(
    route => { calls.push(route); return Promise.resolve({current: {uid: current}}); },
    message => toasts.push(message), {}
  );
  assert.equal(await guard('a'), true);
  assert.equal(await guard('b'), false);
  current = null;
  assert.equal(await guard('a'), false);
  assert.deepEqual(calls, ['/api/accounts', '/api/accounts', '/api/accounts']);
  assert.deepEqual(toasts, ['请先切换到该账号再操作', '请先切换到该账号再操作']);
  const handler = inject.slice(inject.indexOf("listen(popup, 'click', function (event) {", inject.indexOf('function setupDailyProgressPopover()')),
    inject.indexOf("listen(window, 'resize'", inject.indexOf('function setupDailyProgressPopover()')));
  assert.match(handler, /confirmCurrentGrowthAccount\(uid\)\.then\(function \(isCurrent\) \{/);
  assert.match(handler, /if \(!isCurrent\) return;/);
  assert.ok(handler.indexOf('if (!isCurrent) return;') < handler.indexOf("button.hasAttribute('data-wbs-claimed-toggle')"));
  assert.ok(handler.indexOf('if (!isCurrent) return;') < handler.indexOf('openOfficialGrowthCenter()'));
  const listeners = {};
  const popup = {contains: () => true, querySelector: () => ({scrollTop: 0}), scrollTop: 0};
  const state = {dailyClaimedExpanded: {b: false}};
  let allowed = false;
  let opened = 0;
  const context = {
    popup, state,
    activeRing: {getAttribute: () => 'b'},
    listen: (_node, type, listener) => { listeners[type] = listener; },
    confirmCurrentGrowthAccount: () => Promise.resolve(allowed),
    openOfficialGrowthCenter: () => { opened++; },
    refreshDailyProgressPopover: () => {},
  };
  const vm = require('node:vm');
  vm.runInNewContext(handler, context);
  const click = attribute => listeners.click({
    target: {closest: () => ({disabled: false, hasAttribute: name => name === attribute})},
    preventDefault() {}, stopPropagation() {},
  });
  click('data-wbs-growth-official');
  click('data-wbs-claimed-toggle');
  await Promise.resolve();
  assert.equal(opened, 0);
  assert.equal(state.dailyClaimedExpanded.b, false);
  allowed = true;
  click('data-wbs-growth-official');
  click('data-wbs-claimed-toggle');
  await Promise.resolve();
  assert.equal(opened, 1);
  assert.equal(state.dailyClaimedExpanded.b, true);
});

test('usage modal renders restrained primary line and top-to-bottom area gradient', () => {
  assert.match(inject, /function renderUsageTrendChart/);
  assert.match(inject, /createLinearGradient\(0, chartTop, 0, chartBottom\)/);
  assert.match(inject, /var\(--wbs-primary-rgb\)/);
  assert.match(inject, /class="wbs-usage-trend-canvas"/);
  assert.doesNotMatch(inject, /wbs-credit-bar-track/);
  assert.match(inject, /\.wbs-token-stats-grid>div\{[^}]*border:1px solid var\(--wb-border-subtle/);
  assert.match(inject, /\.wbs-token-stats-grid strong\{[^}]*color:var\(--wb-color-text-primary/);
  assert.doesNotMatch(inject, /--wbs-usage-green/);
  assert.doesNotMatch(inject, /wbs-usage-accent/);
});

test('growth details link unfinished tasks to the official center and keep claimed rows inside the scroll list', () => {
  assert.match(inject, /task\.state === 'not_accepted' && taskCode/);
  assert.match(inject, /data-wbs-growth-official>去完成<\/button>/);
  assert.match(inject, /visibleTasks\.map\(renderGrowthTask\)\.join\(''\) \+ claimedToggle \+/);
  assert.doesNotMatch(inject, /<\/div>' \+ claimedToggle \+ '<\/div>'/);
  assert.match(inject, /\.wbs-growth-task-action\{[^}]*min-width:/);
  assert.match(inject, /\.wbs-growth-task-action:focus-visible/);
  assert.match(inject, /\.wbs-growth-task-action\[disabled\]/);
});

test('daily labels share a black light treatment and one glass dark treatment', () => {
  assert.match(inject, /\.wbs-daily-rings,\.wbs-checkin-tag\.ok\{--wbs-badge-bg:var\(--wb-color-text-primary/);
  assert.match(inject, /:is\(html\.cb-dark,html\[data-theme="dark"\],html\[data-wbs-theme-id="dark"\],html\[data-wbs-theme-id="cyber-purple"\],html\[data-wbs-theme-id="nebula"\],body\[data-vscode-theme-name\*="dark" i\]\) \.wbs-daily-rings/);
  assert.match(inject, /backdrop-filter:blur\(12px\)/);
});

test('travel selection links to the official center', () => {
  assert.match(inject, /cat\.state === 'needs_selection'/);
  assert.match(inject, /去官网选择 Buddy/);
});

test('arrived Buddy gifts link to the official center', () => {
  assert.match(inject, /去官网领取/);
});

test('idle Buddy travel links to the official center', () => {
  assert.match(inject, /去官网派出/);
});

test('travel countdown formats a live arrival time without dropping hours or zero padding', () => {
  const source = inject.match(/function formatDailyTravelCountdown\(arriveAt, now\) \{[\s\S]*?\n    \}/);
  assert.ok(source, 'countdown formatter should remain extractable');
  const format = Function('var WBS_LANGUAGE = "zh";\n' + source[0] + '\nreturn formatDailyTravelCountdown;')();
  const now = Date.UTC(2026, 8, 17, 4, 0, 0);

  assert.equal(format(now + 3_723_000, now), '1小时 02分 03秒');
  assert.equal(format(now + 65_000, now), '01分 05秒');
  assert.equal(format(now, now), '');
});
