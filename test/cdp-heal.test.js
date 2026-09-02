'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const daemon = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'daemon.js'), 'utf8');

test('CDP reconnect loop has a bounded managed restart path after WorkBuddy drops the debug port', () => {
  assert.match(daemon, /const CDP_HEAL_GRACE_MS = 90 \* 1000;/);
  assert.match(daemon, /const CDP_HEAL_COOLDOWN_MS = 3 \* 60 \* 1000;/);
  assert.match(daemon, /everConnected:\s*false/);
  assert.match(daemon, /cdp\.everConnected = true/);
  assert.match(daemon, /coldStartEligible = IS_WIN && process\.env\.WBSWITCH_NATIVE_LAUNCHER === '1'/);

  const start = daemon.indexOf('async function maybeHealCdp()');
  assert.notEqual(start, -1);
  const source = daemon.slice(start, start + 2600);
  assert.match(source, /await findCdpEndpoint\(\)/);
  assert.match(source, /workBuddyRunning\(\)/);
  assert.match(source, /if \(!running\)[\s\S]*cdpLostAt = 0[\s\S]*return false/);
  assert.match(source, /await quitWorkBuddy\(\)[\s\S]*await relaunchWorkBuddy\(\)/);
});

test('planned logout suppresses the CDP auto-heal loop before stopping WorkBuddy', () => {
  const start = daemon.indexOf("p === '/api/logout'");
  assert.notEqual(start, -1);
  const source = daemon.slice(start, start + 1800);
  const suppress = source.indexOf('suppressCdpHeal(5 * 60 * 1000)');
  const quit = source.indexOf('await quitWorkBuddy()');
  assert.ok(suppress >= 0 && quit > suppress);
});
