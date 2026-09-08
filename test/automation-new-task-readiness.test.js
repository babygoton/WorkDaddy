'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../scripts/daemon.js'),'utf8');
const begin=source.indexOf('async function ensureAutomationNewTask('),end=source.indexOf('let automationAgentCreating =',begin);
function harness({buttonAfter=4,readyAfter=7,transientAt=0,cancelAt=Infinity,missing=false,accountChanges=false}={}){
 let clock=0,reads=0;const calls=[];
 const ctx={cdp:{connected:true},Date:{now:()=>clock},sleep:async ms=>{clock+=ms},automationAgentSurfaceExpression:()=> '({newTaskReady:true})',
  readAutomationAgentSurface:async()=>{reads++;if(reads===transientAt)throw Error('Execution context was destroyed');return {newTaskReady:!missing&&reads>=readyAfter,hasComposer:!missing&&reads>=readyAfter,composerText:'',button:!missing&&reads>=buttonAfter?{x:1,y:1}:null}},
  cdpMouseClick:async()=>calls.push('navigate'),cdpSend:async()=>{calls.push('backup');return {result:{value:{saved:true}}}},
 };
 vm.runInNewContext(source.slice(begin,end),ctx);
 return {calls,time:()=>clock,run:()=>ctx.ensureAutomationNewTask({guard:()=>{if(reads>=cancelAt)throw Error(accountChanges?'account changed':'cancelled')}})};
}
test('second account can render the New Task entry after several empty page probes',async()=>{
 const first=harness({buttonAfter:1,readyAfter:1});await first.run();assert.deepEqual(first.calls,['backup']);
 const next=harness();await next.run();assert.deepEqual(next.calls,['navigate','backup']);assert.ok(next.time()>=1000);
});
test('a transient navigation context loss is retried before touching the composer',async()=>{
 const h=harness({transientAt:2});await h.run();assert.deepEqual(h.calls,['navigate','backup']);
});
test('cancellation and account changes during page readiness abort without draft operations',async()=>{
 for(const accountChanges of [false,true]){const h=harness({cancelAt:2,accountChanges});await assert.rejects(h.run(),accountChanges?/account changed/:/cancelled/);assert.deepEqual(h.calls,[])}
});
test('a login or unsupported page without a New Task entry times out without typing or clicking',async()=>{
 const h=harness({missing:true});await assert.rejects(h.run(),/未找到 WorkBuddy 的新建任务入口/);assert.ok(h.time()>=10000&&h.time()<=20000);assert.deepEqual(h.calls,[]);
});
test('the New Task entry is clicked once even while the destination composer stays unavailable',async()=>{
 const h=harness({buttonAfter:1,readyAfter:Infinity});await assert.rejects(h.run(),/新建任务页面未准备完成/);assert.deepEqual(h.calls,['navigate']);
});

test('a briefly ready composer that remounts must settle before draft backup',async()=>{
 const h=harness({readyAfter:1,buttonAfter:Infinity,transientAt:2});
 await h.run();assert.deepEqual(h.calls,['backup']);assert.ok(h.time()>=600);
});
