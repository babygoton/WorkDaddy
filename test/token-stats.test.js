'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanTokenStats, scanTokenStatsCached, dateBounds, tokenStatsCacheReady } = require('../scripts/token-stats.js');

test('scans usage metadata without reading message semantics into the result', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wbs-token-stats-'));
  fs.mkdirSync(path.join(root, 'project-a'), { recursive: true });
  fs.writeFileSync(path.join(root, 'project-a', 'session.jsonl'), [
    JSON.stringify({ timestamp: '2026-09-10T10:00:00Z', model: 'model-x', message: 'secret', usage: { input_tokens: 10, output_tokens: 4, cache_read_tokens: 2 } }),
    '{broken',
  ].join('\n'));
  const result = scanTokenStats(root, { now: Date.parse('2026-09-11T10:00:00Z'), days: 7 });
  assert.deepEqual(result.totals, { input: 10, output: 4, cacheRead: 2, cacheWrite: 0, calls: 1 });
  assert.equal(result.models[0].model, 'model-x');
  assert.equal(result.parseErrors, 1);
  assert.equal('message' in result, false);
});

test('cached scan reuses history and merges today without duplicate calls', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wbs-token-cache-'));
  fs.mkdirSync(path.join(root, 'project-a'), { recursive: true });
  const now = Date.parse('2026-09-11T10:00:00Z');
  const file = path.join(root, 'project-a', 'session.jsonl');
  fs.writeFileSync(file, JSON.stringify({ timestamp: '2026-09-10T10:00:00Z', model: 'm', usage: { input_tokens: 3, output_tokens: 2 } }) + '\n');
  const ownership = { session: 'acct-a' };
  assert.equal(tokenStatsCacheReady(root, {now}), false);
  const first = scanTokenStatsCached(root, { now, days: 7, accountOptions: [{ uid: 'acct-a' }], sessionAccounts: ownership });
  assert.equal(first.totals.calls, 1);
  assert.equal(first.cacheHit, false);
  assert.equal(tokenStatsCacheReady(root, {now}), true);
  const cachePayload = JSON.parse(fs.readFileSync(path.join(root, '.workdaddy-token-stats-cache.json'), 'utf8'));
  assert.equal(Array.isArray(cachePayload.records), false);
  assert.equal(Array.isArray(cachePayload.historicalBuckets), true);
  assert.equal(typeof cachePayload.todayFiles, 'object');
  const filtered = scanTokenStatsCached(root, { now, days: 7, account: 'acct-a', accountOptions: [{ uid: 'acct-a' }], sessionAccounts: ownership });
  assert.equal(filtered.totals.calls, 1);
  assert.equal(filtered.cacheHit, true);
  fs.appendFileSync(file, JSON.stringify({ timestamp: '2026-09-11T10:01:00Z', model: 'm', usage: { input_tokens: 4, output_tokens: 1 } }) + '\n');
  const second = scanTokenStatsCached(root, { now: now + 2 * 60 * 1000, days: 7, accountOptions: [{ uid: 'acct-a' }], sessionAccounts: ownership });
  assert.equal(second.totals.calls, 2);
  const third = scanTokenStatsCached(root, { now: now + 3 * 60 * 1000, days: 7, accountOptions: [{ uid: 'acct-a' }], sessionAccounts: ownership });
  assert.equal(third.totals.calls, 2);
  assert.equal(third.cacheHit, true);
  assert.equal(third.accounts[0].account, 'acct-a');
});

test('date range is limited to 90 days', () => {
  const now = Date.parse('2026-09-11T10:00:00Z');
  assert.throws(() => dateBounds(now, { from: '2026-01-01', until: '2026-09-11' }), /不能超过 90 天/);
  assert.throws(() => dateBounds(now, { from: '2026-09-12', until: '2026-09-11' }), /不能晚于/);
});

test('today range starts at local midnight', () => {
  const now = new Date(2026, 8, 11, 10, 0, 0).getTime();
  const bounds = dateBounds(now, { days: 1 });
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  assert.equal(bounds.from, start.getTime());
});

test('cached history and live buckets do not double count calls', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wbs-token-overlap-'));
  const file = path.join(root, 'session.jsonl');
  const now = Date.parse('2026-09-11T10:00:00Z');
  fs.writeFileSync(file, JSON.stringify({ timestamp: '2026-09-10T10:00:00Z', usage: { input_tokens: 2 } }) + '\n');
  const first = scanTokenStatsCached(root, { now, days: 7 });
  assert.equal(first.totals.calls, 1);
  const second = scanTokenStatsCached(root, { now: now + 60_000, days: 7 });
  assert.equal(second.totals.calls, 1);
});

test('token statistics UI keeps results under an overlay and exposes presets through 90 days only', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'inject.js'), 'utf8');
  assert.match(source, /class="wbs-token-stats-content"/);
  assert.match(source, /class="wbs-token-stats-overlay"/);
  assert.match(source, /overlay\.hidden = false/);
  assert.doesNotMatch(source, /data-token-search|data-token-reset/);
  assert.doesNotMatch(source, /data-token-from|data-token-until|value="custom"/);
  assert.doesNotMatch(source, /wbs-token-stats-diagnostics/);
  assert.match(source, /api\('\/api\/token-stats\?cacheStatus=1'\)/);
  assert.match(source, /if \(!metadata\.cacheReady\)/);
  assert.doesNotMatch(source, /__wbsTokenStatsCacheReady/);
  assert.match(source, /setTimeout\(function \(\) \{ if \(!overlay\.hidden\)/);
  assert.match(source, /formatTokenCount\(item\.calls/);
  assert.match(source, /var tokenDays = \[\]/);
  assert.match(source, /data-token-days><option value="1">今天<\/option><option value="7" selected>/);
  assert.match(source, /data-credit-days><option value="1">今天<\/option><option value="7" selected>/);
});

test('token cache survives local day rollover without rereading unchanged JSONL files', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wbs-token-rollover-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'s.jsonl');
  const firstTime=new Date(2026,8,10,23,30).getTime();
  fs.writeFileSync(file,JSON.stringify({timestamp:firstTime,usage:{input_tokens:8}})+'\n');
  scanTokenStatsCached(root,{now:firstTime,days:7});
  const read=fs.readFileSync;let reads=0;
  fs.readFileSync=function(p,...args){if(p===file)reads++;return read.call(this,p,...args);};
  t.after(()=>{fs.readFileSync=read;});
  const second=scanTokenStatsCached(root,{now:new Date(2026,8,12,10).getTime(),days:30});
  assert.equal(second.cacheHit,true);assert.equal(reads,0);assert.equal(second.totals.input,8);
  fs.appendFileSync(file,JSON.stringify({timestamp:new Date(2026,8,11,15).getTime(),usage:{input_tokens:3}})+'\n');
  const third=scanTokenStatsCached(root,{now:new Date(2026,8,12,11).getTime(),days:30});
  assert.equal(third.totals.input,11);assert.equal(reads,1);
});

test('AI usage after local midnight is visible today and in seven days', t => {
  const previousTZ = process.env.TZ; process.env.TZ = 'Asia/Shanghai';
  t.after(() => { if (previousTZ === undefined) delete process.env.TZ; else process.env.TZ = previousTZ; });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wbs-ai-midnight-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'projects', 'p'), { recursive: true });
  const file = path.join(root, 'projects', 'p', 'session.jsonl');
  const now = Date.parse('2026-09-13T01:00:00+08:00');
  const records = [
    { timestamp: '2026-09-12T23:00:00+08:00', model: 'm', usage: { input_tokens: 9 } },
    ...[279, 110, 114, 124].map((output, i) => ({
      timestamp: Date.parse('2026-09-13T00:43:00+08:00') + i * 1000,
      type: i === 3 ? 'message' : 'function_call',
      providerData: { model: 'm', usage: { inputTokens: 100, outputTokens: output } },
      message: { usage: { input_tokens: 100, output_tokens: output, cache_read_input_tokens: 60 } }
    }))
  ];
  fs.writeFileSync(file, records.map(JSON.stringify).join('\n'));
  const options = { now, sessionAccounts: { session: 'acct' } };
  const today = scanTokenStatsCached(root, { ...options, days: 1 });
  assert.equal(today.totals.calls, 4);
  assert.equal(today.totals.input, 400);
  assert.equal(today.totals.cacheRead, 240);
  assert.deepEqual(today.daily.map(x => x.day), ['2026-09-13']);
  assert.equal(today.accounts[0].calls, 4);
  const read = fs.readFileSync; let reads = 0;
  fs.readFileSync = function(p, ...args) { if (p === file) reads++; return read.call(this, p, ...args); };
  t.after(() => { fs.readFileSync = read; });
  const week = scanTokenStatsCached(root, { ...options, days: 7 });
  assert.equal(week.totals.calls, 5);
  assert.deepEqual(week.daily.map(x => x.day), ['2026-09-12', '2026-09-13']);
  assert.equal(scanTokenStatsCached(root, { ...options, days: 1 }).totals.calls, 4);
  assert.equal(scanTokenStatsCached(root, { ...options, days: 30 }).totals.calls, 5);
  assert.equal(reads, 0, 'switching filters never reparses unchanged session files');
});

test('seven-day totals match calendar dates and ignore diagnostic copies', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wbs-token-calendar-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'projects')); fs.mkdirSync(path.join(root, 'logs'));
  const now = new Date(2026, 8, 13, 1).getTime();
  const rows = [6, 7, 12, 13].map(day => ({timestamp: new Date(2026,8,day,0,30).getTime(),usage:{input_tokens:day}}));
  fs.writeFileSync(path.join(root, 'projects', 's.jsonl'), rows.map(JSON.stringify).join('\n'));
  fs.writeFileSync(path.join(root, 'logs', 'diagnostic.jsonl'), JSON.stringify(rows[3]));
  const stats = scanTokenStatsCached(root, { now, days: 7 });
  assert.equal(stats.totals.calls, 3);
  assert.equal(stats.totals.input, 32);
  assert.deepEqual(stats.daily.map(x => x.day), ['2026-09-07', '2026-09-12', '2026-09-13']);
});
