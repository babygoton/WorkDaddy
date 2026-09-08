'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {assertAccountRequestUrl,createTaskState,createRendererGate,receiptComplete}=require('../scripts/automation-runtime');
test('account tokens never go to foreign origins, ports, credentials or HTTP',()=>{
 for(const url of ['http://www.codebuddy.cn/a','https://www.codebuddy.cn.evil.test/a','https://www.codebuddy.cn:444/a','https://x:y@www.codebuddy.cn/a','https://www.workbuddy.ai/a']) assert.throws(()=>assertAccountRequestUrl(new URL(url),'https://www.codebuddy.cn'));
 assertAccountRequestUrl(new URL('https://www.workbuddy.cn/api'),'https://www.codebuddy.cn');
});
test('state isolates tasks/accounts and does not lose interleaved writes',async()=>{
 let db={};const make=id=>createTaskState(id,()=>JSON.parse(JSON.stringify(db)),v=>{db=v});const a=make('a'),b=make('b');
 await a.set('task','1','x',1);await b.set('task','1','x',2);await a.set('account','1','x',3);
 assert.equal(await a.get('task','different','x'),1);assert.equal(await b.get('task','1','x'),2);assert.equal(await a.get('account','2','x'),undefined);
 assert.equal(await a.get('account','1','x'),3);
});
test('renderer gate queues tasks and cancellation does not leak the lock',async()=>{
 const acquire=createRendererGate();const release=await acquire(()=>false);let cancelled=false;
 const waiting=acquire(()=>cancelled);cancelled=true;await assert.rejects(waiting,/停止/);release();
 const next=await acquire(()=>false);next();
});
test('completion is bound to user request, conversation and assistant identity',()=>{
 const receipt={conversationId:'c',userMessageId:'u',requestId:'r',baselineAssistantId:'a0'};
 const snap={conversationId:'c',userMessageId:'u',assistantId:'a1',assistantRequestId:'r',complete:true,busy:false};
 assert.equal(receiptComplete(receipt,snap),true);
 assert.equal(receiptComplete(receipt,{...snap,assistantId:'a0'}),false);
 assert.equal(receiptComplete(receipt,{...snap,busy:true}),false);
 assert.throws(()=>receiptComplete(receipt,{...snap,userMessageId:'u2'}));
 assert.throws(()=>receiptComplete(receipt,{...snap,conversationId:'other'}));
 assert.throws(()=>receiptComplete(receipt,{...snap,cancelled:true}));
});

const fs=require('node:fs'),vm=require('node:vm');
const daemon=fs.readFileSync(require('node:path').join(__dirname,'../scripts/daemon.js'),'utf8');
function httpHarness(fetchImpl,read=()=>'{"auth":{"accessToken":"fake-test-token"}}') {
 const scope={URL,Buffer,AbortController,setTimeout,clearTimeout,setInterval,clearInterval,fetch:fetchImpl,fs:{readFileSync:read},accountBackupFile:()=>'/fake',PROFILE:{apiHost:'https://www.codebuddy.cn'},assertAccountRequestUrl};
 vm.runInNewContext(daemon.slice(daemon.indexOf('async function automationHttpRequest('),daemon.indexOf('\nfunction automationPublicRun(')),scope);return scope.automationHttpRequest;
}
test('HTTP daemon denies token access before reading backups; aborts fetch on stop',async()=>{
 let reads=0;const blocked=httpHarness(()=>{throw Error('must not fetch')},()=>{reads++;return '{}'});
 await assert.rejects(blocked({url:'https://untrusted.test'}, {uid:'fake'}));assert.equal(reads,0);
 let stopped=false,aborted=false;
 const request=httpHarness((_,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(Object.assign(Error(),{name:'AbortError'}))})));
 const pending=request({url:'https://example.com',isCancelled:()=>stopped},null);stopped=true;await assert.rejects(pending,/停止/);assert.equal(aborted,true);
});
test('HTTP daemon bounds streamed responses and supplies JSON content type',async()=>{
 let headers;
 const request=httpHarness(async(_,options)=>{headers=options.headers;return new Response(JSON.stringify({ok:true}),{status:200,headers:{'content-type':'application/json'}})});
 const r=await request({url:'https://www.workbuddy.cn/api',body:{n:5},method:'POST'},{uid:'fake'});
 assert.equal(r.json.ok,true);assert.equal(headers.authorization,'Bearer fake-test-token');assert.equal(headers['content-type'],'application/json');
 const huge=httpHarness(async()=>new Response(new Uint8Array(1024*1024+1)));await assert.rejects(huge({url:'https://example.com'},null),/1 MiB/);
});
test('renderer receipt probe uses real messageType shape without returning private content',()=>{
 const {probeSessionReceipt}=require('../scripts/automation-runtime');
 const state={messages:[{messageType:'user',id:'u',requestId:'r',content:'private'},{messageType:'assistant',id:'a',requestId:'r',complete:true,extra:{isRequestTerminal:false},content:'private response'}]};
 const compat={getSelectedConversationId:()=> 'c',findConversationControllers:()=>[{conversationId:'c',messageStore:{getState:()=>state},getSessionViewState:()=>({})}]};
 const result=vm.runInNewContext('('+probeSessionReceipt.toString()+')()',{window:{__wbsWorkBuddyCompat:compat},document:{}});
 assert.equal(result.userMessageId,'u');assert.equal(result.requestId,'r');assert.equal(result.complete,false,'explicit non-terminal wins over interim complete');
 assert.ok(!JSON.stringify(result).includes('private'));
});
