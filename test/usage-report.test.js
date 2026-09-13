'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createUsageReporter, usageDay } = require('../scripts/usage-report.js');

function fixture(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbs-usage-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let time = Date.parse('2026-09-10T04:00:00Z'), enabled = true;
  const calls = [];
  const options = { dataDir: dir, profile: 'workbuddy-cn', version: '1.2.9',
    now: () => time, enabled: () => enabled,
    installationId: () => '11111111-1111-4111-8111-111111111111',
    send: async (body) => { calls.push(body); return { status: 204 }; }, ...extra };
  return { options, calls, reporter: createUsageReporter(options),
    advance: (ms) => { time += ms; }, disable: () => { enabled = false; } };
}

test('usage uses Beijing day and survives restart without duplicate reports', async t => {
  assert.equal(usageDay(Date.parse('2026-09-10T16:00:00Z')), '2026-09-11');
  const f = fixture(t);
  await Promise.all([f.reporter.report(), f.reporter.report()]);
  await createUsageReporter(f.options).report();
  assert.equal(f.calls.length, 1);
  f.advance(86400000);
  await f.reporter.report();
  assert.equal(f.calls.length, 2);
  assert.deepEqual(Object.keys(f.calls[0]).sort(), ['arch', 'installationId', 'osRelease', 'platform', 'profile', 'version']);
});

test('disabled telemetry and missing persistent identity never send', async t => {
  const f = fixture(t); f.disable();
  await f.reporter.report();
  assert.equal(f.calls.length, 0);
  const missing = fixture(t, { installationId: () => null });
  await missing.reporter.report();
  assert.equal(missing.calls.length, 0);
});

test('failed reports back off across restart and stop after three daily attempts', async t => {
  let count = 0;
  const f = fixture(t, { send: async () => { count++; throw new Error('offline'); } });
  for (let i = 0; i < 8; i++) {
    await createUsageReporter(f.options).report();
    await f.reporter.report();
    f.advance(2 * 3600000);
  }
  assert.equal(count, 3);
});

test('only exact collector acknowledgement is success; static Pages 200 is not', async t => {
  let count = 0;
  const f = fixture(t, { send: async () => ({ status: ++count === 1 ? 200 : 204 }) });
  await f.reporter.report();
  f.advance(6 * 3600000);
  await f.reporter.report();
  await createUsageReporter(f.options).report();
  assert.equal(count, 2);
});

test('corrupt state fails closed instead of generating unbounded requests', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.options.dataDir, 'usage-state.json'), '{broken');
  await f.reporter.report();
  assert.equal(f.calls.length, 0);
});

test('separate profile reporters share the daily lock and a crashed lock recovers', async t => {
  const f = fixture(t);
  const ai = createUsageReporter({ ...f.options, profile: 'workbuddy-ai' });
  const lock = path.join(f.options.dataDir, '.usage-report.lock');
  fs.mkdirSync(lock);
  await ai.report();
  assert.equal(f.calls.length, 0);
  const stale = new Date(Date.now() - 120000);
  fs.utimesSync(lock, stale, stale);
  await Promise.all([f.reporter.report(), ai.report()]);
  assert.equal(f.calls.length, 1);
  assert.equal(fs.existsSync(lock), false);
});

test('disabling telemetry can abort the pending request and release its lock', async t => {
  let aborted = false;
  const f = fixture(t, { send: (_body, signal) => new Promise(resolve => {
    signal.addEventListener('abort', () => { aborted = true; resolve({ status: 0 }); });
  }) });
  const pending = f.reporter.report();
  f.disable(); f.reporter.cancel();
  await pending;
  assert.equal(aborted, true);
  assert.equal(fs.existsSync(path.join(f.options.dataDir, '.usage-report.lock')), false);
});
