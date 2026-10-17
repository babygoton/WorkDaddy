'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOfficialAutomationSync } = require('../scripts/official-automation-sync');

function makeDb(initial) {
  const rows = initial.map((row) => ({ ...row }));
  return {
    rows,
    async all(sql, params) {
      const owner = params[0];
      return rows.filter((row) => row.owner_user_id === owner && row.deleted_at == null && row.status !== 'ARCHIVED')
        .map((row) => ({ ...row }));
    },
    async transaction(statements) {
      for (const statement of statements) {
        if (/^DELETE FROM automations/.test(statement.sql)) {
          const [id, owner] = statement.params;
          const index = rows.findIndex((row) => row.id === id && row.owner_user_id === owner);
          if (index >= 0) rows.splice(index, 1);
          continue;
        }
        assert.match(statement.sql, /^INSERT INTO automations/);
        const values = statement.params;
        rows.push({
          id: values[0], name: values[1], prompt: values[2], status: values[3],
          schedule_type: values[4], next_run_at: values[5], last_run_at: values[6],
          cwds: values[7], rrule: values[8], scheduled_at: values[9], valid_from: values[10],
          valid_until: values[11], model_id: values[12], model_is_thinking: values[13],
          skills_json: values[14], push_to_wechat: values[15], push_to_wecom_bot: values[16],
          owner_user_id: values[17], owner_status: values[18], owner_source: values[19],
          expert_id: values[20], expert_marketplace: values[21], connector_ids_json: values[22],
          permission_mode: values[23], created_at: values[24], updated_at: values[25],
          deleted_at: values[26], wecom_bot_source: values[27], context_window: values[28],
          reasoning_effort: values[29], workspace_scope: values[30], wecom_bot_chat_id: values[31],
        });
      }
    },
  };
}

const sourceTask = {
  id: 'source-id', name: '每天早上 10 点搜索 AI 信息汇总', prompt: 'search AI', status: 'ACTIVE',
  schedule_type: 'recurring', rrule: 'FREQ=DAILY;BYHOUR=10;BYMINUTE=0', owner_user_id: 'source',
  owner_status: 'confirmed', owner_source: 'local', created_at: '2026-10-17T00:00:00.000Z',
  updated_at: '2026-10-17T00:00:00.000Z', deleted_at: null,
};

test('official account task sync copies once and preserves target edits', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-official-automation-'));
  try {
    const db = makeDb([sourceTask, { ...sourceTask, id: 'deleted', name: 'deleted', deleted_at: '2026-10-17' }, { ...sourceTask, id: 'archived', name: 'archived', status: 'ARCHIVED' }]);
    let id = 0;
    const sync = createOfficialAutomationSync({
      dataDir,
      db,
      idFactory: () => `00000000-0000-4000-8000-00000000000${++id}`,
    });

    const first = await sync('source', 'target');
    assert.deepEqual(first, { copied: 1, skipped: 0, total: 1 });
    const copied = db.rows.find((row) => row.owner_user_id === 'target');
    assert.ok(copied);
    assert.equal(copied.id, '00000000-0000-4000-8000-000000000001');
    assert.equal(copied.owner_user_id, 'target');
    assert.equal(copied.name, sourceTask.name);
    assert.notEqual(copied.id, sourceTask.id);

    copied.name = '目标账号自己的编辑';
    const second = await sync('source', 'target');
    assert.deepEqual(second, { copied: 0, skipped: 1, total: 1 });
    assert.equal(db.rows.find((row) => row.id === copied.id).name, '目标账号自己的编辑');

    sourceTask.name = '源账号后续编辑';
    const third = await sync('source', 'target');
    assert.equal(third.copied, 0);
    assert.equal(db.rows.filter((row) => row.owner_user_id === 'target').length, 1);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('historical one-time tasks with NULL rrule are copied with the official empty default', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-official-automation-once-'));
  try {
    const db = makeDb([{ ...sourceTask, id: 'once-source', name: '一次性任务', schedule_type: 'once', rrule: null }]);
    const sync = createOfficialAutomationSync({
      dataDir,
      db,
      idFactory: () => '00000000-0000-4000-8000-000000000009',
    });
    assert.deepEqual(await sync('source', 'target'), { copied: 1, skipped: 0, total: 1 });
    const copied = db.rows.find((row) => row.owner_user_id === 'target');
    assert.equal(copied.rrule, '');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('renamed copies follow the mapping lineage and remove only generated duplicates', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-official-automation-lineage-'));
  try {
    const source = { ...sourceTask, id: 'source-id', name: '源任务' };
    const firstCopy = { ...source, id: 'target-original', name: '目标改名', owner_user_id: 'target', updated_at: '3' };
    const duplicate = { ...source, id: 'target-duplicate', name: '再次改名', owner_user_id: 'target', updated_at: '2' };
    const db = makeDb([source, firstCopy, duplicate]);
    fs.writeFileSync(path.join(dataDir, 'official-automation-sync.json'), JSON.stringify({
      'source:source-id:middle': { targetAutomationId: 'middle-copy', sourceUpdatedAt: '1' },
      'middle:middle-copy:target': { targetAutomationId: 'target-original', sourceUpdatedAt: '1' },
      'target:target-original:other': { targetAutomationId: 'other-copy', sourceUpdatedAt: '1' },
      'other:other-copy:target': { targetAutomationId: 'target-duplicate', sourceUpdatedAt: '1' },
    }));
    const sync = createOfficialAutomationSync({ dataDir, db, idFactory: () => 'never-used' });
    const result = await sync('source', 'target');
    assert.deepEqual(result, { copied: 0, skipped: 1, total: 1 });
    assert.deepEqual(db.rows.filter((row) => row.owner_user_id === 'target').map((row) => row.id), ['target-original']);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('lineage cleanup keeps the latest target edit even when mapping order is reversed', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-official-automation-reversed-'));
  try {
    const source = { ...sourceTask, id: 'source-id', name: '源任务' };
    const older = { ...source, id: 'target-older', name: '旧副本', owner_user_id: 'target', updated_at: '10' };
    const latest = { ...source, id: 'target-latest', name: '最新改名', owner_user_id: 'target', updated_at: '20' };
    const db = makeDb([source, older, latest]);
    fs.writeFileSync(path.join(dataDir, 'official-automation-sync.json'), JSON.stringify({
      // Deliberately put the newer duplicate first, as happens after a
      // reverse account switch writes a later mapping entry.
      'middle:middle-copy:target': { targetAutomationId: 'target-latest', sourceUpdatedAt: '2' },
      'source:source-id:middle': { targetAutomationId: 'middle-copy', sourceUpdatedAt: '1' },
      'other:other-copy:target': { targetAutomationId: 'target-older', sourceUpdatedAt: '1' },
      'target:target-latest:other': { targetAutomationId: 'other-copy', sourceUpdatedAt: '2' },
    }));
    const sync = createOfficialAutomationSync({ dataDir, db, idFactory: () => 'never-used' });
    assert.deepEqual(await sync('source', 'target'), { copied: 0, skipped: 1, total: 1 });
    assert.deepEqual(db.rows.filter((row) => row.owner_user_id === 'target').map((row) => row.id), ['target-latest']);
    assert.equal(db.rows.find((row) => row.id === 'target-latest').name, '最新改名');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
