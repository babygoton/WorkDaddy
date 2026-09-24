'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTaskState } = require('../scripts/automation-runtime');
const {
  SCHEMA_VERSION,
  executeTask,
  isSupportedTaskSchema,
  validateTask,
} = require('../scripts/automation');

test('automation v2 remains backward compatible and exposes generic runtime metadata', async () => {
  assert.equal(SCHEMA_VERSION, 3);
  assert.equal(isSupportedTaskSchema({ schemaVersion: 1 }), true);
  assert.equal(isSupportedTaskSchema({ schemaVersion: 2 }), true);
  assert.equal(isSupportedTaskSchema({ schemaVersion: 4 }), false);

  const task = validateTask({
    schemaVersion: 2,
    id: 'runtime-context',
    name: 'runtime-context',
    concurrency: { policy: 'skip' },
    steps: [
      { op: 'value.uuid', saveAs: 'eventId' },
      { op: 'time.now', format: 'epochMs', saveAs: 'stepTime' },
      { op: 'value.number', operator: 'subtract', values: [8, 3], min: 0, saveAs: 'remaining' },
      { op: 'vars.set', key: 'runId', value: '{{runtime.run.id}}' },
      { op: 'vars.set', key: 'today', value: '{{runtime.time.localDate}}' },
      { op: 'vars.set', key: 'trigger', value: '{{runtime.trigger.type}}' },
    ],
  });
  const result = await executeTask(task, {
    now: 1789574400123,
    runId: 'run-test-1',
    event: { type: 'panelOpened' },
  });
  assert.match(result.context.vars.eventId, /^[0-9a-f-]{36}$/);
  assert.equal(result.context.vars.stepTime, 1789574400123);
  assert.equal(result.context.vars.remaining, 5);
  assert.equal(result.context.vars.runId, 'run-test-1');
  assert.equal(result.context.vars.today, '2026-09-17');
  assert.equal(result.context.vars.trigger, 'panelOpened');
});

test('automation v2 state TTL is generic and expired values disappear', async () => {
  let now = 1000;
  let db = {};
  const state = createTaskState('daily', () => structuredClone(db), (value) => { db = value; }, () => now);
  await state.set('account', 'u1', 'done', true, { ttlMs: 500 });
  assert.equal(await state.get('account', 'u1', 'done'), true);
  now = 1501;
  assert.equal(await state.get('account', 'u1', 'done'), undefined);
  assert.equal(Object.keys(db).length, 0);
});

test('v2-only fields are rejected by v1 tasks and accepted by v2 tasks', () => {
  assert.throws(() => validateTask({
    schemaVersion: 1,
    id: 'old',
    name: 'old',
    concurrency: { policy: 'skip' },
    steps: [],
  }), /V2/);
  assert.doesNotThrow(() => validateTask({
    schemaVersion: 2,
    id: 'new',
    name: 'new',
    concurrency: { policy: 'skip' },
    steps: [{ op: 'state.set', key: 'cache', value: true, ttlMs: 1000 }],
  }));
});
