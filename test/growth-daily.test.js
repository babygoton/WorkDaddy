'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  acceptGrowthTasks,
  claimBuddyTravelReward,
  claimFirstBuddy,
  createDailyProgressCache,
  departBuddyTravel,
  drawGrowthLottery,
  fetchDailyProgress,
  normalizeDailyProgress,
  openBuddyBlindBox,
  selectCurrentBuddy,
  summarizeGrowthActionReward,
} = require('../scripts/growth-daily');

test('daily progress exposes task completion, binary travel and available actions', () => {
  const progress = normalizeDailyProgress([
    { task_code: 'create_canvas', title: '画布', accept_status: 'claimed', progress: { current: 1, target: 1 }, reward_credit: 100 },
    { task_code: 'template_5', title: '模板', accept_status: 'completed', progress: { current: 5, target: 5 }, reward_credit: 100 },
    { task_code: 'chat_5', title: '对话', accept_status: 'accepted', progress: { current: 2, target: 5 }, reward_credit: 100 },
    { task_code: 'Expert_Philanthropy', title: '公益', accept_status: 'accepted', progress: { current: 0, target: 1 }, reward_credit: 0 },
  ], {
    state: 'traveling',
    arrive_at: 1789578000,
    server_now: 1789574400,
  }, {
    fetchedAt: 1789574400000,
    gacha: { affordable: 2, balance: 23, cost_per_open: 10 },
    lottery: { balance: 1 },
  });

  assert.deepEqual(progress.growth, {
    completed: 2,
    total: 4,
    ratio: 0.5,
    tasks: [
      { taskCode: 'create_canvas', title: '画布', guide: '', tag: '', deadline: null, reward: { credits: 100, energy: 0, buddy: false }, current: 1, target: 1, state: 'claimed' },
      { taskCode: 'template_5', title: '模板', guide: '', tag: '', deadline: null, reward: { credits: 100, energy: 0, buddy: false }, current: 5, target: 5, state: 'completed' },
      { taskCode: 'chat_5', title: '对话', guide: '', tag: '', deadline: null, reward: { credits: 100, energy: 0, buddy: false }, current: 2, target: 5, state: 'in_progress' },
      { taskCode: 'Expert_Philanthropy', title: '公益', guide: '', tag: '', deadline: null, reward: { credits: 0, energy: 0, buddy: false }, current: 0, target: 1, state: 'in_progress' },
    ],
  });
  assert.deepEqual(progress.rewards, { claimed: 1, total: 3, pending: 1, ratio: 1 / 3 });
  assert.equal(progress.cat.state, 'traveling');
  assert.equal(progress.cat.progress, 1);
  assert.equal(progress.cat.arriveAt, 1789578000000);
  assert.deepEqual(progress.actions, {
    gacha: { available: true, count: 2, energy: 23, cost: 10 },
    lottery: { available: true, count: 1 },
  });
  assert.deepEqual(progress.manualTasks, ['公益']);
});

test('daily progress follows the current growth center task list and locks travel without a Buddy', async () => {
  const calls = [];
  const payloads = {
    '/v2/activity/growth/tasks': { code: 0, data: { tasks: [
      { task_code: 'first_buddy', title: '领取一只 Buddy', accept_status: 'completed', progress: { current: 1, target: 1 }, reward_credit: 300 },
      { task_code: 'RichMeow_Chat', title: '桌面端对话1次', accept_status: 'not_accepted', progress: null, reward_credit: 100 },
      { task_code: 'chat_5', title: '和 AI 聊天 5 次', accept_status: 'not_accepted', progress: null, reward_credit: 100 },
    ] } },
    '/activity/growth/buddy/travel/status': { code: 0, data: { state: 'idle', daily_limit_reached: false } },
    '/activity/growth/buddy/info': { code: 0, data: {} },
    '/activity/growth/buddy/list': { code: 0, data: { buddies: [] } },
    '/activity/growth/buddy/quota': { code: 0, data: { affordable: 1, balance: 10, cost_per_open: 10 } },
    '/activity/growth/lottery/chances': { code: 0, data: { balance: 3 } },
  };
  const result = await fetchDailyProgress('secret-token', {
    apiHost: 'https://www.codebuddy.cn',
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      calls.push(pathname);
      assert.notEqual(pathname, '/activity/growth/tasks', 'legacy task list must not win over the growth center V2 list');
      return new Response(JSON.stringify(payloads[pathname]), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    now: () => 1789574400000,
  });

  assert.deepEqual(calls, [
    '/v2/activity/growth/tasks',
    '/activity/growth/buddy/travel/status',
    '/activity/growth/buddy/info',
    '/activity/growth/buddy/list',
    '/activity/growth/buddy/quota',
    '/activity/growth/lottery/chances',
  ]);
  assert.deepEqual(result.growth, {
    completed: 1,
    total: 2,
    ratio: 0.5,
    tasks: [
      { taskCode: 'first_buddy', title: '领取一只 Buddy', guide: '', tag: '', deadline: null, reward: { credits: 300, energy: 0, buddy: false }, current: 1, target: 1, state: 'completed' },
      { taskCode: 'RichMeow_Chat', title: '桌面端对话1次', guide: '', tag: '', deadline: null, reward: { credits: 100, energy: 0, buddy: false }, current: 0, target: 1, state: 'not_accepted' },
    ],
  });
  assert.deepEqual(result.rewards, { claimed: 0, total: 2, pending: 1, ratio: 0 });
  assert.equal(result.cat.state, 'locked');
  assert.equal(result.cat.available, false);
  assert.equal(result.actions.gacha.count, 1);
  assert.equal(result.actions.lottery.count, 3);
});

test('idle travel with owned but no current Buddy requires an explicit choice', async () => {
  const payloads = {
    '/v2/activity/growth/tasks': { code: 0, data: { tasks: [] } },
    '/activity/growth/buddy/travel/status': { code: 0, data: { state: 'idle', buddy_id: 0, daily_limit_reached: false } },
    '/activity/growth/buddy/info': { code: 0, data: { buddy: null } },
    '/activity/growth/buddy/list': { code: 0, data: { buddies: [
      { instance_id: 11, name: 'Buddy A', current_buddy: false },
      { instance_id: 12, name: 'Buddy B', current_buddy: false },
    ] } },
    '/activity/growth/buddy/quota': { code: 0, data: {} },
    '/activity/growth/lottery/chances': { code: 0, data: {} },
  };
  const result = await fetchDailyProgress('test-token', {
    fetchImpl: async (url) => new Response(JSON.stringify(payloads[new URL(url).pathname]), { status: 200 }),
  });
  assert.equal(result.cat.state, 'needs_selection');
  assert.equal(result.cat.available, true);
  assert.equal(result.cat.activeBuddy, false);
  assert.deepEqual(result.cat.buddies, [{ instanceId: 11, name: 'Buddy A' }, { instanceId: 12, name: 'Buddy B' }]);
});

test('daily progress retains task instructions, deadline, rewards and arrived gift state', () => {
  const progress = normalizeDailyProgress([{
    task_code: 'Expert_lighthouse',
    title: '体验「腾讯轻量云」专家',
    description: '召唤专家并完成一次对话。',
    task_desc: '完成一次专家对话',
    tag: '限量',
    valid_end: '2026-11-13T23:59:00+08:00',
    reward_credit: 100,
    reward_energy: 5,
    reward_buddy: true,
    accept_status: 'accepted',
    progress: { current: 0, target: 1 },
  }], {
    state: 'arrived',
    daily_limit_reached: true,
    reward_credit: 6,
  });

  assert.deepEqual(progress.growth.tasks[0], {
    taskCode: 'Expert_lighthouse',
    title: '体验「腾讯轻量云」专家',
    guide: '召唤专家并完成一次对话。',
    tag: '限量',
    deadline: '2026-11-13T23:59:00+08:00',
    reward: { credits: 100, energy: 5, buddy: true },
    current: 0,
    target: 1,
    state: 'in_progress',
  });
  assert.deepEqual(progress.cat, {
    state: 'arrived',
    progress: 1,
    arriveAt: null,
    dailyLimitReached: true,
    available: true,
    activeBuddy: false,
    buddies: [],
    reward: { credits: 6, energy: 0 },
  });
});

test('growth task accept uses the current official endpoint and bearer auth', async () => {
  const calls = [];
  const result = await acceptGrowthTasks('secret-token', ['RichMeow_Chat'], {
    apiHost: 'https://www.codebuddy.cn',
    fetchImpl: async (url, options) => {
      calls.push([url, options]);
      return new Response(JSON.stringify({ code: 0, data: { accepted: ['RichMeow_Chat'] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'https://www.codebuddy.cn/activity/growth/tasks/accept');
  assert.equal(calls[0][1].method, 'POST');
  assert.equal(calls[0][1].headers.authorization, 'Bearer secret-token');
  assert.equal(calls[0][1].headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0][1].body), { task_codes: ['RichMeow_Chat'] });
  assert.deepEqual(result, { accepted: ['RichMeow_Chat'] });
});

test('growth task accept rejects unsafe task codes and official failures', async () => {
  await assert.rejects(
    () => acceptGrowthTasks('secret-token', ['../../bad'], { fetchImpl: async () => { throw new Error('must not request'); } }),
    /任务码无效/,
  );
  await assert.rejects(
    () => acceptGrowthTasks('secret-token', ['chat_5'], {
      fetchImpl: async () => new Response(JSON.stringify({ code: 12004, msg: '任务不可领取' }), { status: 200 }),
    }),
    /任务不可领取/,
  );
});

test('buddy travel reward claim uses the official endpoint and bearer auth', async () => {
  const calls = [];
  const result = await claimBuddyTravelReward('secret-token', {
    apiHost: 'https://www.codebuddy.cn',
    fetchImpl: async (url, options) => {
      calls.push([url, options]);
      return new Response(JSON.stringify({ code: 0, data: { reward_credit: 6 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'https://www.codebuddy.cn/activity/growth/buddy/travel/claim');
  assert.equal(calls[0][1].method, 'POST');
  assert.equal(calls[0][1].headers.authorization, 'Bearer secret-token');
  assert.equal(calls[0][1].headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0][1].body), {});
  assert.deepEqual(result, { reward_credit: 6 });
});

test('buddy travel reward claim never treats official failures as success', async () => {
  await assert.rejects(
    () => claimBuddyTravelReward('secret-token', {
      fetchImpl: async () => new Response(JSON.stringify({ code: 12004, msg: '礼物已领取' }), { status: 200 }),
    }),
    /礼物已领取/,
  );
  await assert.rejects(
    () => claimBuddyTravelReward('secret-token', {
      fetchImpl: async () => new Response(JSON.stringify({ msg: 'gateway failed' }), { status: 502 }),
    }),
    /gateway failed/,
  );
});

test('first Buddy unlock uses the official claim endpoint and rejects business errors', async () => {
  const calls = [];
  const result = await claimFirstBuddy('secret-token', {
    apiHost: 'https://www.workbuddy.cn',
    fetchImpl: async (url, options) => {
      calls.push([url, options]);
      return new Response(JSON.stringify({ code: 0, data: { buddy: { instance_id: 42 } } }), { status: 200 });
    },
  });
  assert.equal(calls[0][0], 'https://www.workbuddy.cn/activity/growth/buddy/first');
  assert.equal(calls[0][1].method, 'POST');
  assert.equal(calls[0][1].headers.authorization, 'Bearer secret-token');
  assert.equal(calls[0][1].body, undefined);
  assert.deepEqual(result, { buddy: { instance_id: 42 } });
  await assert.rejects(() => claimFirstBuddy('secret-token', {
    fetchImpl: async () => new Response(JSON.stringify({ code: 12004, msg: '请先完成新手任务' }), { status: 200 }),
  }), /请先完成新手任务/);
});

test('buddy travel departure selects the first official location and returns arrival data', async () => {
  const calls = [];
  const result = await departBuddyTravel('secret-token', {
    apiHost: 'https://www.workbuddy.cn',
    fetchImpl: async (url, options) => {
      calls.push([url, options]);
      if (url.endsWith('/config')) {
        return new Response(JSON.stringify({ code: 0, data: { locations: [{ id: 'forest', name: '森林' }] } }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: 0, data: { state: 'traveling', arrive_at: 1789578000 } }), { status: 200 });
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], 'https://www.workbuddy.cn/v2/activity/growth/buddy/travel/config');
  assert.equal(calls[0][1].method, 'GET');
  assert.equal(calls[1][0], 'https://www.workbuddy.cn/v2/activity/growth/buddy/travel/depart');
  assert.equal(calls[1][1].method, 'POST');
  assert.deepEqual(JSON.parse(calls[1][1].body), { location_id: 'forest' });
  assert.deepEqual(result, { state: 'traveling', arrive_at: 1789578000 });
});

test('buddy travel departure fails closed when no official location is available', async () => {
  await assert.rejects(
    () => departBuddyTravel('secret-token', {
      fetchImpl: async () => new Response(JSON.stringify({ code: 0, data: { locations: [] } }), { status: 200 }),
    }),
    /暂无可用旅行地点/,
  );
});

test('current Buddy selection uses only the explicit official instance id', async () => {
  const calls = [];
  await selectCurrentBuddy('test-token', 12, {
    apiHost: 'https://www.workbuddy.cn',
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 });
    },
  });
  assert.deepEqual(calls, [{
    url: 'https://www.workbuddy.cn/activity/growth/buddy/switch',
    method: 'POST',
    body: { instance_id: 12 },
  }]);
  await assert.rejects(() => selectCurrentBuddy('test-token', '../12'), /Buddy 编号无效/);
});

test('buddy blind box opens exactly one box through the official endpoint', async () => {
  const calls = [];
  const result = await openBuddyBlindBox('secret-token', {
    apiHost: 'https://www.workbuddy.cn',
    fetchImpl: async (url, options) => {
      calls.push([url, options]);
      return new Response(JSON.stringify({ code: 0, data: { results: [{ instance: { name: '星际喵', rarity: 'SR' } }] } }), { status: 200 });
    },
  });

  assert.equal(calls[0][0], 'https://www.workbuddy.cn/v2/activity/growth/buddy/open');
  assert.equal(calls[0][1].method, 'POST');
  assert.equal(calls[0][1].headers.authorization, 'Bearer secret-token');
  assert.deepEqual(JSON.parse(calls[0][1].body), { count: 1 });
  assert.deepEqual(result.results[0].instance, { name: '星际喵', rarity: 'SR' });
  assert.equal(summarizeGrowthActionReward('gacha', result), '星际喵 · SR');
});

test('growth lottery draws once with a unique client token and summarizes the prize', async () => {
  const calls = [];
  const result = await drawGrowthLottery('secret-token', {
    apiHost: 'https://www.workbuddy.cn',
    clientToken: 'draw-fixed-test-token',
    fetchImpl: async (url, options) => {
      calls.push([url, options]);
      return new Response(JSON.stringify({ code: 0, data: { prize_name: '50 Credits', credit_granted: 50 } }), { status: 200 });
    },
  });

  assert.equal(calls[0][0], 'https://www.workbuddy.cn/v2/activity/growth/lottery/draw');
  assert.equal(calls[0][1].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0][1].body), { client_token: 'draw-fixed-test-token' });
  assert.equal(summarizeGrowthActionReward('lottery', result), '50 Credits');
});

test('growth action helpers reject official failures and never expose arbitrary payload objects', async () => {
  await assert.rejects(
    () => openBuddyBlindBox('secret-token', {
      fetchImpl: async () => new Response(JSON.stringify({ code: 12004, msg: '能量不足' }), { status: 200 }),
    }),
    /能量不足/,
  );
  assert.equal(summarizeGrowthActionReward('lottery', { nested: { token: 'must-not-render' } }), '奖励已到账');
});

test('daily progress fetch uses official account auth without leaking it in results', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push([url, options]);
    const payload = url.includes('/tasks')
      ? { code: 0, data: { tasks: [] } }
      : { code: 0, data: { state: 'idle', daily_limit_reached: false } };
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const result = await fetchDailyProgress('secret-token', {
    apiHost: 'https://www.codebuddy.cn',
    fetchImpl,
    now: () => 1789574400000,
  });
  assert.equal(calls.length, 6);
  assert.equal(calls[0][1].headers.authorization, 'Bearer secret-token');
  assert.equal(JSON.stringify(result).includes('secret-token'), false);
  assert.equal(result.status, 'ready');
});

test('daily progress cache deduplicates requests and supports a forced refresh', async () => {
  let count = 0;
  const cache = createDailyProgressCache(async (uid) => ({ uid, count: ++count }), { now: () => 1000, ttlMs: 5000 });
  const [a, b] = await Promise.all([cache.get('u1'), cache.get('u1')]);
  assert.equal(a.count, 1);
  assert.equal(b.count, 1);
  assert.equal((await cache.get('u1')).count, 1);
  assert.equal((await cache.get('u1', { force: true })).count, 2);
});
