'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const daemon = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'daemon.js'), 'utf8');
const refresh = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'token-refresh.js'), 'utf8');

test('daemon checks in shortly after startup and hourly thereafter', () => {
  assert.match(daemon, /const CHECKIN_STARTUP_DELAY_MS = 30 \* 1000;/);
  assert.match(daemon, /const CHECKIN_INTERVAL_MS = 60 \* 60 \* 1000;/);
  assert.match(daemon, /startupCheckinTimer = setTimeout\([\s\S]*?CHECKIN_STARTUP_DELAY_MS\);/);
  assert.match(daemon, /periodicCheckinTimer = setInterval\([\s\S]*?CHECKIN_INTERVAL_MS\);/);
  assert.doesNotMatch(daemon, /claimDailyForAll[\s\S]{0,180}3 \* 60 \* 60 \* 1000/);
});

test('check-in timers do not keep the daemon alive', () => {
  assert.match(daemon, /startupCheckinTimer\.unref && startupCheckinTimer\.unref\(\);/);
  assert.match(daemon, /periodicCheckinTimer\.unref && periodicCheckinTimer\.unref\(\);/);
});

test('check-in path refreshes backup tokens lazily and runs daily keepalive', () => {
  assert.match(daemon, /refreshAccountBackupToken\(uid\)/);
  assert.match(daemon, /refreshAccountBackupToken\(uid, \{ dailyKeepalive: true \}\)/);
  assert.match(refresh, /auth\/token\/refresh/);
  assert.match(daemon, /lastRefreshTime/);
  assert.match(daemon, /1\.1\.34/);
});
