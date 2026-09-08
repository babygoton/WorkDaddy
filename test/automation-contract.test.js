'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {executeTask,taskMatchesEvent,validateTask}=require('../scripts/automation');
const run=(steps,options={})=>executeTask({id:'contract',steps},options);
test('HTTP recursively resolves typed templates, status saveAs and account fallback',async()=>{
 let request,account;
 await run([{op:'account.status',saveAs:'status'},{op:'http.requestAsAccount',url:'https://www.workbuddy.cn/api',body:{count:'{{vars.status.days}}',nested:['{{vars.status.days}}']}}],{
 currentAccount:()=>({uid:'fake'}),accountStatus:async()=>({days:5}),httpRequest:async(r,a)=>{request=r;account=a;return{ok:true}}});
 assert.deepEqual(request.body,{count:5,nested:[5]});assert.equal(account.uid,'fake');
});
test('HTTP error opt-in throws and retries; default preserves response branching',async()=>{
 let count=0;
 await run([{op:'logic.retry',times:2,delayMs:1,steps:[{op:'http.request',url:'https://example.com',throwOnHttpError:true}]}],{httpRequest:async()=>({ok:++count>1,status:count===1?500:200})});
 assert.equal(count,2);
});
test('lifecycle distinguishes actual switch and connection from ordinary reload',()=>{
 const t=type=>({enabled:true,trigger:{type}});
 assert.equal(taskMatchesEvent(t('accountSwitched'),'pageReady',{source:'load'}),false);
 assert.equal(taskMatchesEvent(t('accountSwitched'),'pageReady',{source:'account-switch'}),true);
 assert.equal(taskMatchesEvent(t('clientLoaded'),'pageReady',{source:'load'}),false);
 assert.equal(taskMatchesEvent(t('clientLoaded'),'pageReady',{source:'connect'}),true);
 assert.equal(taskMatchesEvent(t('pageLoaded'),'pageReady',{source:'load'}),true);
});
test('stop interrupts a long delay promptly even inside catch/retry',async()=>{
 let stopped=false;const timer=setTimeout(()=>{stopped=true},30),start=Date.now();
 await assert.rejects(run([{op:'logic.retry',times:5,steps:[{op:'logic.catch',steps:[{op:'logic.delay',ms:20000}]}]}],{isCancelled:()=>stopped}),/停止/);
 clearTimeout(timer);assert.ok(Date.now()-start<1000);
});
test('forEach/break and numeric comparisons preserve loop context',async()=>{
 const r=await run([{op:'logic.forEach',items:[1,2,3],steps:[{op:'vars.set',key:'last',value:'{{vars.item}}'},{op:'logic.if',condition:{left:'{{vars.item}}',operator:'gte',right:2},then:[{op:'logic.break'}]}]}]);
 assert.equal(r.context.vars.last,2);assert.equal(r.context.vars.item,undefined);
});
test('account loops restore outer context and expose public account helpers',async()=>{
 const r=await run([{op:'account.getCurrent',saveAs:'current'},{op:'account.forEach',steps:[{op:'account.status',saveAs:'s'}]},{op:'account.status',saveAs:'after'}],{currentAccount:()=>({uid:'a'}),listAccounts:async()=>[{uid:'b'}],accountStatus:async a=>({uid:a.uid})});
 assert.equal(r.context.vars.after.uid,'a');assert.equal(r.context.vars.current.uid,'a');
});
test('unknown state scope and missing key fail validation',()=>{
 assert.throws(()=>validateTask({steps:[{op:'state.set',scope:'global',key:'x'}]}));
 assert.throws(()=>validateTask({steps:[{op:'state.get'}]}));
});
test('popup observers can run between sends; typing and account loops retain renderer lease',()=>{
 const {taskIsPassiveCleanup}=require('../scripts/automation');
 const popup=require('../scripts/builtin/automations/close-buddy-popups.json');
 assert.equal(taskIsPassiveCleanup(popup),true);
 for(const step of [{op:'dom.type'},{op:'session.create'},{op:'account.forEach',switch:true}])assert.equal(taskIsPassiveCleanup({...popup,steps:[...popup.steps,step]}),false);
 assert.equal(taskIsPassiveCleanup({...popup,trigger:{type:'manual'}}),false);
});
test('cancellation restores original account with an explicit restoration flag',async()=>{
 let current={uid:'a'},stopped=false;const switches=[];
 await assert.rejects(run([{op:'account.forEach',switch:true,steps:[{op:'logic.delay',ms:10000}]}],{
 currentAccount:()=>current,listAccounts:async()=>[{uid:'b'}],isCancelled:()=>stopped,
 accountSwitch:async(a,detail)=>{switches.push({uid:a.uid,restore:!!detail?.restore});current=a;if(a.uid==='b')stopped=true;}
 }),/停止/);
 assert.deepEqual(switches,[{uid:'b',restore:false},{uid:'a',restore:true}]);
});
