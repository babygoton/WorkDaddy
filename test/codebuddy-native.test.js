'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {replaceNativeSession}=require('../scripts/codebuddy-native.js');
const original={account:{uid:'old'},auth:{accessToken:'fixture-old'}};
const next={account:{uid:'new'},auth:{accessToken:'fixture-new'}};
function service(){const events=[];return {events,currentSession:original,initialized:Promise.resolve(),storeSession:async function(s){events.push('store:'+s.account.uid);},_onDidChangeSession:{fire:s=>events.push('notify:'+s.account.uid)},scheduleRefresh:()=>events.push('schedule')};}
test('native switch persists, publishes and schedules without quitting or relaunching',async()=>{
  const s=service();assert.deepEqual(await replaceNativeSession.call(s,next),{uid:'new'});
  assert.deepEqual(s.events,['store:new','notify:new','schedule']);assert.equal(s.currentSession,next);
});
test('native switch rolls back a failed publish and refuses refresh races',async()=>{
  const s=service();s._onDidChangeSession.fire=x=>{if(x===next)throw Error('fail');s.events.push('notify:old');};
  await assert.rejects(replaceNativeSession.call(s,next),/原登录态/);
  assert.equal(s.currentSession,original);assert.deepEqual(s.events,['store:new','store:old','notify:old','schedule']);
  s.refreshInFlight=true;await assert.rejects(replaceNativeSession.call(s,next),/正在更新/);
});
test('invalid backups never reach native storage',async()=>{
  const s=service();await assert.rejects(replaceNativeSession.call(s,{account:{uid:'x'}}),/无效/);assert.deepEqual(s.events,[]);
});

test('a failed switch from logged-out state removes the new encrypted identity', async () => {
  const s = service(); s.currentSession = undefined;
  s.storageService = {remove:async () => s.events.push('remove')};
  s.getStorageKey = () => 'fixture';
  s._onDidChangeSession.fire = value => { if(value) throw Error('fail'); };
  await assert.rejects(replaceNativeSession.call(s,next), /已恢复/);
  assert.equal(s.currentSession, undefined);
  assert.deepEqual(s.events, ['store:new','remove','schedule']);
  assert.equal(s.refreshInFlight, false);
});
test('native switching excludes a concurrent transaction and fake logout never revokes tokens', async () => {
  const s = service(); let finish;
  s.storeSession = () => new Promise(resolve => { finish = resolve; });
  const first = replaceNativeSession.call(s, next);
  await Promise.resolve();
  await assert.rejects(replaceNativeSession.call(s, original), /正在更新/);
  finish(); await first;
  s.storageService = {remove:async () => s.events.push('remove')};
  s.getStorageKey = () => 'fixture';
  s._onDidChangeSession.fire = value => s.events.push(value ? 'login' : 'logout');
  await replaceNativeSession.call(s, null);
  assert.equal(s.currentSession, undefined);
  assert.ok(s.events.includes('remove'));
});

test('native session changes persist before notifying both renderer generations, reject stale/running sessions',async()=>{
  const {writeNativeSessions}=require('../scripts/codebuddy-native');
  const before={conversationId:'fixture',userId:'u1',updatedAt:1,deletedAt:2};
  const events=[];
  const s={_sessions:new Map([['fixture',before]]),_newSessions:new Set(),enqueueV2Write:fn=>fn(),
    _db:{updateItems:async()=>events.push('persist')},nextV2Revision:()=>3,
    broadcastV2:()=>events.push('v2'),notifyAgentManager:()=>events.push('legacy')};
  const next={...before,deletedAt:null,updatedAt:4};
  await writeNativeSessions.call(s,[{id:'fixture',before,after:next}]);
  assert.equal(s._sessions.get('fixture').deletedAt,undefined);
  assert.deepEqual(events,['persist','v2','legacy']);
  await assert.rejects(writeNativeSessions.call(s,[{id:'fixture',before,after:next}]),/已变化/);
  s._sessions.set('fixture',{...next,status:'Working'});
  await assert.rejects(writeNativeSessions.call(s,[{id:'fixture',before:s._sessions.get('fixture'),after:null}]),/正在运行/);
});
