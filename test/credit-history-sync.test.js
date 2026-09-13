'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCreditHistorySync, historyRange } = require('../scripts/credit-history-sync.js');
const { fetchUsageSinceAnchor } = require('../scripts/credit-request-usage.js');
const now = new Date(2026, 8, 12, 12);
const settle = async (sync) => { while (sync.status().running) await new Promise(resolve => setImmediate(resolve)); return sync.status(); };

test('historical sync fetches all pages without today cache or anchor, limits to 90 days, reports progress and deduplicates active jobs', async () => {
  const requests = [], progress = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const sync = createCreditHistorySync({ now: () => now, getAccessToken: async () => 'test',
    fetchUsage: options => fetchUsageSinceAnchor({ ...options, apiHost: 'https://usage.test', pageSize: 1,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(init.body); requests.push(body); if (requests.length === 1) await gate;
        return {ok:true, text:async () => JSON.stringify({code:0,data:{total:2,data:[{requestId:'r'+body.pageNum,requestTime: body.pageNum === 1 ? '2026-09-12 10:00:00' : '2026-07-01 10:00:00',credit:1}]}})};
      }, onProgress: value => { options.onProgress(value); progress.push(sync.status()); } })
  });
  const job = sync.start({accounts:[{uid:'one',nickname:'A'}],days:900});
  assert.equal(job.running, true);
  assert.equal(sync.start({accounts:[{uid:'one',nickname:'A'}],days:900}).id, job.id);
  assert.throws(() => sync.start({accounts:[{uid:'two'}],days:7}), /正在进行/);
  release();
  const end = await settle(sync);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(r => r.pageNum), [1,2]);
  assert.equal(requests[0].startTime, '2026-06-15 00:00:00');
  assert.equal(end.daily.reduce((n,d)=>n+d.count,0), 2);
  assert.equal(end.from, '2026-06-15');
  assert.equal(progress[0].page, 1); assert.equal(progress[0].pages, 2);
  assert.equal(end.completed, 1); assert.equal(end.synced, 1); assert.equal(end.percent, 100);
});

test('failed account does not block other accounts and raw server errors stay private', async () => {
  const sync=createCreditHistorySync({now:()=>now,getAccessToken:async uid=>uid,fetchUsage:async o=>{if(o.accessToken==='bad') throw Error('Bearer private-secret');return {records:[]}}});
  sync.start({days:7,accounts:[{uid:'bad'},{uid:'good'}]});
  const state=await settle(sync);
  assert.equal(state.completed,2);assert.equal(state.synced,1);assert.equal(state.failures.length,1);assert.ok(state.daily.every(d=>d.uid==='good'));
  assert.doesNotMatch(JSON.stringify(state),/private-secret/);
});

test('history date bounds reject invalid ranges and use local calendar days',()=>{
  for(const days of ['oops',0,-1,1.5,Infinity]) assert.throws(()=>historyRange(days,now));
  assert.equal(historyRange(7,now).from,'2026-09-06');
});

test('manual history route uses a background history job, separate from the today cache', () => {
  const fs=require('node:fs');
  const source=fs.readFileSync(require('node:path').join(__dirname,'../scripts/daemon.js'),'utf8');
  const route=source.slice(source.indexOf("if (req.method === 'POST' && p === '/api/credit-stats')"),source.indexOf('// Read-only per-account continuous activity'));
  assert.match(route,/creditHistorySync\.start/);
  assert.match(route,/json\(res, 202/);
  assert.doesNotMatch(route,/syncCurrentCreditUsage/);
  assert.match(route,/accounts\.filter/);
});

test('repeated credit queries reuse complete daily API results', async () => {
  let calls = 0;
  const sync = createCreditHistorySync({ now: () => now, getAccessToken: async () => 'test',
    fetchUsage: async () => { calls++; return { records: [{ usageDate: '2026-09-12', credit: calls, requestId: 'same' }] }; }
  });
  sync.start({ accounts: [{ uid: 'one' }] });
  const first = await settle(sync);
  assert.equal(first.source, 'server');
  assert.equal(first.from, '2026-09-06');
  assert.equal(first.daily.length, 7);
  assert.equal(first.daily.find(d => d.date === '2026-09-12').used, 1);
  assert.equal(first.daily.find(d => d.date === '2026-09-06').used, 0);
  sync.start({ accounts: [{ uid: 'one' }] });
  const second = await settle(sync);
  assert.equal(calls, 1);
  assert.equal(second.cacheHit, true);
  assert.equal(second.daily.find(d => d.date === '2026-09-12').used, 1);
});

test('failed account contributes no cached values or false zero records', async () => {
  const sync = createCreditHistorySync({ now: () => now, getAccessToken: async uid => uid,
    fetchUsage: async o => { if (o.accessToken === 'bad') throw Error('timeout'); return { records: [] }; }
  });
  sync.start({ accounts: [{ uid: 'bad' }, { uid: 'good' }], days: 7 });
  const result = await settle(sync);
  assert.equal(result.daily.length, 7);
  assert.ok(result.daily.every(d => d.uid === 'good' && d.complete && d.used === 0));
});

test('both credit statistics entry points are remote queries, not local database reads', () => {
  const fs=require('node:fs');
  const source=fs.readFileSync(require('node:path').join(__dirname,'../scripts/daemon.js'),'utf8');
  const routes=source.slice(source.indexOf("if (req.method === 'GET' && p === '/api/credit-stats')"),source.indexOf('// Read-only per-account continuous activity'));
  assert.doesNotMatch(routes,/CREDIT_USAGE_STORE|listDailyUsageRange/);
  assert.match(routes,/creditHistorySync\.wait/);
});

test('durable daily cache fills only gaps, including zero-use days, and survives restart', async t => {
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wbs-credit-cache-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const requests=[];
  const options={cacheFile:path.join(dir,'cache.json'),now:()=>now,getAccessToken:async uid=>uid,fetchUsage:async o=>{requests.push({uid:o.accessToken,from:o.startTime,to:o.endTime});return {records:[]};}};
  let sync=createCreditHistorySync(options);
  sync.start({accounts:[{uid:'a'},{uid:'b'}],days:7});await settle(sync);assert.equal(requests.length,2);
  sync=createCreditHistorySync(options);
  const cached=sync.start({accounts:[{uid:'a'}],days:7});
  assert.equal(cached.running,false);assert.equal(cached.cacheHit,true);assert.equal(cached.daily.length,7);assert.equal(requests.length,2);
  sync.start({accounts:[{uid:'a'}],days:30});await settle(sync);
  assert.equal(requests.length,3);assert.equal(requests[2].from.getTime(),new Date(2026,7,14).getTime());assert.equal(requests[2].to.getTime(),new Date(2026,8,6).getTime()-1000);
  assert.equal(sync.start({accounts:[{uid:'a'}],days:7}).cacheHit,true);assert.equal(requests.length,3);
});

test('expired today refreshes silently while historical days stay cached', async () => {
  let current=now;const requests=[];
  const sync=createCreditHistorySync({now:()=>current,todayTtlMs:60000,getAccessToken:async()=> 'a',fetchUsage:async o=>{requests.push(o);return {records:[]};}});
  sync.start({accounts:[{uid:'a'}],days:7});await settle(sync);
  current=new Date(now.getTime()+61000);
  const job=sync.start({accounts:[{uid:'a'}],days:7});assert.equal(job.hasCachedData,true);await settle(sync);
  assert.equal(requests.length,2);assert.equal(requests[1].startTime.getTime(),new Date(2026,8,12).getTime());
});

test('after midnight only yesterday snapshot and new day are fetched, not settled history', async () => {
  let current=now;const requests=[];
  const sync=createCreditHistorySync({now:()=>current,getAccessToken:async()=> 'a',fetchUsage:async o=>{requests.push(o);return {records:[]};}});
  sync.start({accounts:[{uid:'a'}],days:7});await settle(sync);
  current=new Date(2026,8,13,10);
  sync.start({accounts:[{uid:'a'}],days:7});await settle(sync);
  assert.equal(requests.length,2);assert.equal(requests[1].startTime.getTime(),new Date(2026,8,12).getTime());
});

test('failed gap remains missing and retry does not fetch successful accounts again', async () => {
  let failing=true;const calls=[];
  const sync=createCreditHistorySync({now:()=>now,getAccessToken:async uid=>uid,fetchUsage:async o=>{calls.push(o.accessToken);if(failing&&o.accessToken==='b')throw Error('timeout');return {records:[]};}});
  sync.start({accounts:[{uid:'a'},{uid:'b'}],days:7});await settle(sync);failing=false;
  sync.start({accounts:[{uid:'a'},{uid:'b'}],days:7});await settle(sync);
  assert.deepEqual(calls,['a','b','b']);
});
