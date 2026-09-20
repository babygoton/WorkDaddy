'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAutomationLikesClient } = require('../scripts/automation-likes');

const key = 'a'.repeat(64);
const actor = '11111111-1111-4111-8111-111111111111';

test('automation likes client decorates discovery and invalidates cache after toggle', async () => {
  const calls = [];
  const fetchImpl = async (input, init) => {
    calls.push({ url: String(input), init });
    if (init && init.method === 'POST') return new Response(JSON.stringify({ ok: true, taskKey: key, favoriteCount: 4, favorited: true }));
    return new Response(JSON.stringify({ ok: true, favorites: { [key]: { count: 3, favorited: false } } }));
  };
  const client = createAutomationLikesClient({ endpoint: 'https://workdaddy.dev/api/automation-likes', fetchImpl, getActorId: () => actor });
  const catalog = await client.decorate({ tasks: [{ key, name: '任务' }] });
  assert.deepEqual(catalog.tasks[0].favoriteCount, 3);
  assert.equal(catalog.tasks[0].favorited, false);
  await client.toggle(key, true);
  await client.decorate({ tasks: [{ key, name: '任务' }] });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].init.headers['X-WorkDaddy-Actor'], actor);
  assert.match(calls[1].init.body, /"favorite":true/);
});

test('automation likes client ignores invalid catalog keys', async () => {
  let calls = 0;
  const client = createAutomationLikesClient({ fetchImpl: async () => { calls += 1; return new Response('{}'); } });
  assert.deepEqual(await client.getFavorites([{ key: 'bad' }]), {});
  assert.equal(calls, 0);
});

