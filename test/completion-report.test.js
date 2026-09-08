'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runCompletionReport } = require('../scripts/completion-report');
function fixture(overrides = {}) {
  let time = 0, sends = [];
  return { sends, options: { primaryUid: () => 'primary', currentAccount: () => ({ uid: 'worker', nickname: '测试' }),
    snapshot: async () => ({ known: true, sessions: [{ id: 'one', status: 'completed', busy: false }] }),
    send: async (uid, message) => { sends.push({ uid, message }); return { conversationId: 'cloud' }; },
    now: () => time, wait: async ms => { time += ms; }, isCancelled: () => false, ...overrides } };
}
test('missing primary and current primary skip without inspection or sending', async () => {
  for (const uid of ['', 'worker']) {
    const f = fixture({ primaryUid: () => uid, snapshot: () => { throw Error('must not inspect'); } });
    assert.equal((await runCompletionReport(f.options)).skipped, true); assert.equal(f.sends.length, 0);
  }
});
test('waits for pending/background work, then sends once to captured primary', async () => {
  let scans = 0;
  const f = fixture({ snapshot: async () => ({ known: true, sessions: [{ id: 'one', status: ++scans < 3 ? 'pending' : 'completed', busy: scans < 3 }] }) });
  assert.equal((await runCompletionReport(f.options)).ok, true);
  assert.ok(scans >= 4); assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].uid, 'primary'); assert.match(f.sends[0].message, /^测试 账号于 .* 完成所有任务$/);
});
test('unknown, lost or failed running sessions cannot produce completion reports', async () => {
  for (const next of [ { known: false }, { known: true, sessions: [] }, { known: true, sessions: [{ id: 'one', status: 'failed', busy: false }] } ]) {
    let scans=0;
    const f=fixture({snapshot:async()=> ++scans === 1 ? {known:true,sessions:[{id:'one',status:'running',busy:true}]} : next});
    await assert.rejects(runCompletionReport({...f.options,timeoutMs:5000})); assert.equal(f.sends.length,0);
  }
});
test('account/primary changes and cancellation never send', async () => {
  for (const mode of ['account', 'primary', 'cancel']) {
    let scans=0;const f=fixture({ snapshot:async()=> {scans++;return {known:true,sessions:[{id:'one',status:'completed',busy:false}]};},
      currentAccount:()=>({uid:mode==='account'&&scans?'other':'worker'}),primaryUid:()=>mode==='primary'&&scans?'other':'primary',isCancelled:()=>mode==='cancel'&&scans>0 });
    await assert.rejects(runCompletionReport(f.options));assert.equal(f.sends.length,0);
  }
});
test('report task is manual and dispatched through bounded completion capability', async () => {
  const {validateTask,executeTask,canManuallyRunTask}=require('../scripts/automation');
  const task={schemaVersion:1,id:'report-to-primary',name:'Completion report capability',trigger:{type:'manual'},steps:[{op:'notify.afterAllTasks'}]};
  assert.equal(validateTask(task).id,'report-to-primary');assert.equal(canManuallyRunTask(task),true);
  let n=0; await executeTask(task,{completionReport:async()=>{n++;return {ok:true};}});assert.equal(n,1);
});
test('renderer probe uses account scope and preserves pending, streaming and queued work', async () => {
  const { probeAccountCompletion } = require('../scripts/completion-report');
  const vm = require('node:vm');
  let options;
  const resource = {
    list: async o => { options=o; return {agents:[{id:'one',status:'completed'},{id:'two',status:'pending'}],pagination:null}; },
    getConversationMessageQueue: async id => id==='one'?{items:[{id:'queued'}]}:undefined,
  };
  const context={window:{__wbsWorkBuddyCompat:{findQueueAdapter:()=>({adapter:{sessionsResource:resource}}),findConversationControllers:()=>[]}},document:{}};
  const result = await vm.runInNewContext('('+probeAccountCompletion.toString()+')("worker")', context);
  assert.equal(options.userId,'worker'); assert.equal(result.known,true); assert.equal(result.sessions[0].busy,true); assert.equal(result.sessions[1].status,'pending');
  resource.list=async()=>({agents:[],pagination:null});
  assert.equal((await vm.runInNewContext('('+probeAccountCompletion.toString()+')("worker")',context)).known,false);
  resource.list=async()=>({agents:[{id:'one',status:'completed'}],pagination:{hasNext:true}});
  assert.equal((await vm.runInNewContext('('+probeAccountCompletion.toString()+')("worker")',context)).known,false);
});
