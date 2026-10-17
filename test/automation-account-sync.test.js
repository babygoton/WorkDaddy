'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeAutomations, readAutomations } = require('../scripts/automation');
const sync = require('../scripts/automation-account-sync');
const daemonSource = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');
const injectSource = fs.readFileSync(path.join(__dirname, '../scripts/inject.js'), 'utf8');

const task = (id, extra = {}) => ({
  schemaVersion: 1,
  id,
  name: id,
  enabled: true,
  trigger: { type: 'manual' },
  steps: [],
  ...extra,
});

test('account task sync scopes source tasks and preserves target edits', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-automation-sync-'));
  try {
    writeAutomations(dir, [
      task('source-task', { schedule: { type: 'interval', minutes: 60 }, [sync.ACCOUNT_SCOPE_KEY]: ['source'] }),
      task('legacy-scheduled', { schedule: { type: 'daily', time: '08:00' } }),
      task('legacy-global'),
      task('already-target', { schedule: { type: 'daily', time: '09:00' }, [sync.ACCOUNT_SCOPE_KEY]: ['source', 'target'] }),
      task('target-edit', { enabled: false, [sync.ACCOUNT_SCOPE_KEY]: ['target'] }),
      task('manual-source', { [sync.ACCOUNT_SCOPE_KEY]: ['source'] }),
    ]);
    const result = sync.syncAutomationsToAccount(dir, 'source', 'target');
    assert.equal(result.copied, 2);
    assert.equal(result.skipped, 1);
    const tasks = readAutomations(dir);
    assert.deepEqual(tasks.find((item) => item.id === 'source-task')[sync.ACCOUNT_SCOPE_KEY], ['source', 'target']);
    assert.deepEqual(tasks.find((item) => item.id === 'legacy-scheduled')[sync.ACCOUNT_SCOPE_KEY], ['source', 'target']);
    assert.equal(tasks.find((item) => item.id === 'legacy-global')[sync.ACCOUNT_SCOPE_KEY], undefined);
    assert.equal(tasks.find((item) => item.id === 'target-edit').enabled, false);
    assert.deepEqual(sync.readAccountAutomations(dir, 'target').map((item) => item.id).sort(), ['already-target', 'legacy-global', 'legacy-scheduled', 'source-task', 'target-edit']);
    assert.deepEqual(sync.readAccountAutomations(dir, 'other').map((item) => item.id), ['legacy-global']);
    assert.deepEqual(readAutomations(dir).find((item) => item.id === 'manual-source')[sync.ACCOUNT_SCOPE_KEY], ['source']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sync setting is explicit and disabled by default', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-automation-sync-setting-'));
  try {
    assert.deepEqual(sync.readAutomationSyncSettings(dir), { enabled: false });
    assert.deepEqual(sync.writeAutomationSyncSettings(dir, true), { enabled: true });
    assert.deepEqual(sync.readAutomationSyncSettings(dir), { enabled: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('daemon and sessions pane expose account task sync without coupling it to session copy', () => {
  assert.match(daemonSource, /GET' && p === '\/api\/automations\/auto-sync'/);
  assert.match(daemonSource, /POST' && p === '\/api\/automations\/auto-sync'/);
  assert.match(daemonSource, /syncAccountAutomations\(sourceUid, uid\)/);
  assert.match(daemonSource, /automationSync/);
  assert.match(injectSource, /id="wbs-sess-auto-automations"/);
  assert.match(injectSource, /loadAutomationSyncSetting/);
  assert.match(injectSource, /\/api\/automations\/auto-sync/);
  assert.match(injectSource, /同步定时任务/);
});
