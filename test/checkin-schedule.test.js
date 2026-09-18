'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const daemon = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'daemon.js'), 'utf8');

test('the generic scheduler remains available with no implicit check-in trigger', () => {
  assert.match(daemon, /createScheduleTicker\(DATA_DIR\)/);
  assert.match(daemon, /automationScheduleTimer\.unref && automationScheduleTimer\.unref\(\)/);
  assert.doesNotMatch(daemon, /startupCheckinTimer|periodicCheckinTimer|claimDailyForAll/);
  assert.match(daemon, /daily-account-checkin\.json/);
});

test('check-in refreshes expired credentials only after checking confirmed daily records', () => {
  const body = daemon.slice(daemon.indexOf('async function performAccountCheckin'), daemon.indexOf('/** 通过 CDP 把右下角组件'));
  assert.ok(body.indexOf('getDailyCheckin') < body.indexOf('refreshAccountBackupToken(uid)'));
  assert.ok(body.indexOf('return migrated') < body.indexOf('refreshAccountBackupToken(uid)'));
  assert.doesNotMatch(body, /dailyKeepalive/);
});
