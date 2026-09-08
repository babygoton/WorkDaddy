'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const daemon = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'daemon.js'), 'utf8');

test('automation task owns startup, panel-open and hourly check-in triggers', () => {
  const preset = require('../scripts/builtin/automations/daily-account-checkin.json');
  assert.deepEqual(preset.trigger.types, ['clientLoaded', 'panelOpened']);
  assert.deepEqual(preset.schedule, { type: 'interval', minutes: 60 });
  assert.match(daemon, /installBuiltinTask\(DATA_DIR/);
  assert.match(daemon, /automationScheduleTimer\.unref && automationScheduleTimer\.unref\(\)/);
  assert.doesNotMatch(daemon, /startupCheckinTimer|periodicCheckinTimer|claimDailyForAll/);
});

test('check-in refreshes expired credentials only after checking confirmed daily records', () => {
  const body = daemon.slice(daemon.indexOf('async function performAccountCheckin'), daemon.indexOf('/** 通过 CDP 把右下角组件'));
  assert.ok(body.indexOf('getDailyCheckin') < body.indexOf('refreshAccountBackupToken(uid)'));
  assert.ok(body.indexOf('return migrated') < body.indexOf('refreshAccountBackupToken(uid)'));
  assert.doesNotMatch(body, /dailyKeepalive/);
});
