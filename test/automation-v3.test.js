'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SCHEMA_VERSION, executeTask, validateTask, isSupportedTaskSchema, capabilityText } = require('../scripts/automation');
const { previewPackage } = require('../scripts/automation-packages');

test('V3 advertises current schema and imports V1/V2/V3 including requirements', () => {
  assert.equal(SCHEMA_VERSION, 3);
  for (const schemaVersion of [1, 2, 3]) {
    assert.equal(isSupportedTaskSchema({ schemaVersion }), true);
    const result = previewPackage({ schemaVersion, id: 'compat', steps: [], requires: { minWorkDaddyVersion: '1.0.0', taskSchemaVersion: schemaVersion, capabilities: [] } }, { runtime: { version: '1.2.91' } });
    assert.equal(result.compatible, true);
  }
  assert.equal(isSupportedTaskSchema({ schemaVersion: 4 }), false);
});

test('V3 filters before physical switches and restores original after awaited work', async () => {
  let active = { uid: 'original' };
  const switches = [], sends = [], reads = [];
  const task = { schemaVersion: 3, id: 'filtered', steps: [{
    op: 'account.forEach', switch: true, accounts: 'all',
    prepare: [{ op: 'state.get', scope: 'account', key: 'pending', saveAs: 'pending' }],
    condition: { left: '{{vars.pending}}', operator: 'truthy' },
    steps: [{ op: 'session.create', message: 'fixture', model: 'hy3' }],
  }] };
  await executeTask(task, {
    listAccounts: async () => [{ uid: 'done' }, { uid: 'pending' }, { uid: 'done2' }],
    currentAccount: () => active,
    getState: async (_scope, uid) => { reads.push(uid); return uid === 'pending'; },
    accountSwitch: async account => { await new Promise(resolve => setImmediate(resolve)); switches.push(account.uid); active = account; },
    sessionAction: async () => { sends.push(active.uid); },
  });
  assert.deepEqual(reads, ['done', 'pending', 'done2']);
  assert.deepEqual(switches, ['pending', 'original']);
  assert.deepEqual(sends, ['pending']);
});

test('preparation cannot send, switch or write persistent state; old tasks cannot silently ignore V3 fields', () => {
  for (const op of ['session.create', 'account.forEach', 'account.checkin', 'state.set', 'http.request']) {
    assert.throws(() => validateTask({ schemaVersion: 3, id: 'invalid', steps: [{ op: 'account.forEach', prepare: [{ op }], steps: [] }] }), /prepare/);
  }
  for (const schemaVersion of [1, 2]) assert.throws(() => validateTask({ schemaVersion, id: 'old', steps: [{ op: 'account.forEach', condition: { left: true }, steps: [] }] }), /V3/);
});
