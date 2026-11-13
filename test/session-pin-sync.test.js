'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSessionPinSync, readPinsInRenderer, applyPinsInRenderer } = require('../scripts/session-pin-sync');

function harness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbs-pins-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let active = 'a';
  const pins = { a: ['a2', 'a1'], b: ['b-own'], c: [] }, writes = [];
  const mappings = { 'a:b': { a1: 'b1', a2: 'b2' }, 'b:c': { b1: 'c1', b2: 'c2' } };
  const options = { file: path.join(dir, 'pins.json'),
    read: async uid => active === uid ? pins[uid].slice() : null,
    resolve: async (from, to, ids) => ids.map(id => ({ sourceId:id, targetId:mappings[from+':'+to]?.[id] })).filter(x=>x.targetId),
    apply: async (uid, ids) => {
      if (active !== uid) return false;
      writes.push([uid, ids.slice()]); pins[uid] = [...ids.filter(id=>!pins[uid].includes(id)), ...pins[uid]]; return true;
    },
  };
  return { options, pins, writes, setActive: uid => { active=uid; }, service: createSessionPinSync(options) };
}
test('copy carries official pin order to mapped IDs and preserves both accounts existing pins', async t => {
  const h=harness(t); await h.service.capture('a'); h.setActive('b');
  await h.service.sync('a','b');
  assert.deepEqual(h.pins.a,['a2','a1']); assert.deepEqual(h.pins.b,['b2','b1','b-own']);
  assert.equal(h.pins.b.includes('a1'),false);
});
test('pending pins survive restart and only apply to the matching account', async t => {
  const h=harness(t); await h.service.capture('a');
  await h.service.sync('a','b'); assert.equal(h.writes.length,0);
  const service=createSessionPinSync(h.options); h.setActive('c'); await service.flush('b');
  assert.equal(h.writes.length,0); h.setActive('b'); await service.flush('b');
  assert.deepEqual(h.pins.b,['b2','b1','b-own']);
});
test('same mapping is delivered once so a later manual unpin is respected', async t => {
  const h=harness(t); await h.service.capture('a'); h.setActive('b'); await h.service.sync('a','b');
  h.pins.b=['b-own']; await h.service.sync('a','b'); assert.deepEqual(h.pins.b,['b-own']);
  assert.equal(h.writes.length,1);
});
test('empty source pins cancel pending work; unmapped and deleted target sessions are ignored', async t => {
  const h=harness(t); await h.service.capture('a'); await h.service.sync('a','b');
  h.pins.a=[]; await h.service.capture('a'); h.setActive('b'); await h.service.flush('b');
  assert.deepEqual(h.pins.b,['b-own']); assert.equal(h.writes.length,0);
});
test('pins propagate through a rapid A to B to C chain even before B renderer loads', async t => {
  const h=harness(t); await h.service.capture('a'); h.setActive('c');
  await h.service.sync('a','b'); await h.service.sync('b','c');
  assert.deepEqual(h.pins.c,['c2','c1']);
});
test('failed reads do not replace a known snapshot with an empty list', async t => {
  const h=harness(t); await h.service.capture('a'); h.setActive('b'); await h.service.capture('a');
  await h.service.sync('a','b'); assert.deepEqual(h.pins.b,['b2','b1','b-own']);
});
test('renderer uses official pin API and verifies account scope before every mutation', async () => {
  let uid='a'; let pins=['own']; const calls=[];
  const wb={account:{profile:async()=>({uid,type:'personal'})},conversations:{
    listPinned:async()=>pins.map(id=>({id,groupKey:''})),
    pin:async id=>{calls.push(id); pins.unshift(id);},
  }};
  const before=global.window; global.window={wb};
  try {
    assert.deepEqual(await readPinsInRenderer({uid:'a',type:'personal'}),['own']);
    assert.equal(await readPinsInRenderer({uid:'b',type:'personal'}),null);
    assert.equal(await applyPinsInRenderer({uid:'a',type:'personal'},['one','two']),true);
    assert.deepEqual(pins,['one','two','own']);
    wb.conversations.pin=async id=>{calls.push(id);uid='b';};
    assert.equal(await applyPinsInRenderer({uid:'a',type:'personal'},['three','four']),false);
    assert.equal(calls.includes('three'),false);
    assert.equal(await applyPinsInRenderer({uid:'b',type:'ultimate',enterpriseId:'org'},['x']),false);
  } finally {global.window=before;}
});
test('the obsolete reminder button is removed and pin synchronization is wired into switch and copy',()=>{
  const inject=fs.readFileSync(path.join(__dirname,'../scripts/inject.js'),'utf8');
  const daemon=fs.readFileSync(path.join(__dirname,'../scripts/daemon.js'),'utf8');
  assert.doesNotMatch(inject,/wbs-sess-remember|rememberedSessionsKey/);
  assert.match(daemon,/await captureSessionPins\(\)/);
  assert.match(daemon,/await syncSessionPins\(job.sourceUid, job.targetUid\)/);
});

test('daemon resolves real lineage mappings and rejects deleted, foreign or ambiguous target copies', async t => {
  const vm=require('node:vm'); const h=harness(t);
  const source=fs.readFileSync(path.join(__dirname,'../scripts/daemon.js'),'utf8');
  const pins={a:['a2','a1'],b:['b-own']}; let account={uid:'a',rawUid:'a',type:'personal'}; let ambiguous=false, queries=0;
  const wb={account:{profile:async()=>account},conversations:{
    listPinned:async()=>pins[account.uid].map(id=>({id})),
    pin:async id=>{pins[account.uid].unshift(id);},
  }};
  const ctx={createSessionPinSync,readPinsInRenderer,applyPinsInRenderer,path,
    DATA_DIR:path.dirname(h.options.file),PROFILE:{kind:'workbuddy',id:'workbuddy-cn'},
    cdp:{connected:true},accountSwitchInProgress:false,currentAccount:()=>account,
    sessionAccountAmbiguous:()=>ambiguous,log(){},setTimeout,clearTimeout,
    cdpSend:async(_,params)=>({result:{value:await vm.runInNewContext(params.expression,{window:{wb}})}}),
    resolveAutoCopyTargetId:(_,__,id)=>({a1:'b1',a2:'foreign'}[id]||''),
    isValidSessionId:id=>!!id,sqlPlaceholders:ids=>ids.map(()=>'?').join(','),
    sqliteQuery:async()=>{ queries++; return [{id:'a1',user_id:'a'},{id:'a2',user_id:'a'},{id:'b1',user_id:'b'},{id:'foreign',user_id:'c'}]; },
  };
  vm.createContext(ctx); vm.runInContext(source.slice(source.indexOf('let sessionPinSync = null;'),source.indexOf('function resolveAutoCopyTargetId(')),ctx);
  await ctx.captureSessionPins(); account={uid:'b',rawUid:'b',type:'personal'};
  await ctx.syncSessionPins('a','b'); assert.deepEqual(pins.b,['b1','b-own']);
  assert.deepEqual(pins.a,['a2','a1']);
  const beforeQueries=queries; ambiguous=true; await ctx.syncSessionPins('a','b'); assert.equal(queries,beforeQueries);
  const build=fs.readFileSync(path.join(__dirname,'../scripts/build-mac-dmg.sh'),'utf8');
  assert.match(build,/session-pin-sync\.js/);
});

test('deleted mappings are rechecked before deferred delivery', async t => {
  const h=harness(t); await h.service.capture('a'); await h.service.sync('a','b');
  h.options.resolve=async()=>[]; const service=createSessionPinSync(h.options); h.setActive('b');
  await service.flush('b'); assert.deepEqual(h.pins.b,['b-own']); assert.equal(h.writes.length,0);
});
