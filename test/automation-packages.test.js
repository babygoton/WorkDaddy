'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const automation=require('../scripts/automation');
test('editing another task preserves future-schema documents without executing them',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wd-package-'));
 try {
  const future={schemaVersion:2,id:'future',name:'Future task',enabled:true,trigger:{type:'panelOpened'},schedule:{type:'interval',minutes:1},steps:[],futureConfig:{value:1}};
  fs.writeFileSync(path.join(dir,'automations.json'),JSON.stringify([future]));
  const tasks=automation.readAutomations(dir);
  assert.deepEqual(tasks[0],future);
  assert.equal(automation.canManuallyRunTask({...future,trigger:{type:'manual'},schedule:{type:'manual'}}),false);
  assert.equal(automation.taskMatchesEvent(future,'panelOpened'),false);
  const tick=automation.createScheduleTicker(),calls=[];tick(tasks,t=>calls.push(t),()=>false,0);tick(tasks,t=>calls.push(t),()=>false,60000);assert.equal(calls.length,0);
  automation.writeAutomations(dir,[...tasks,automation.validateTask({id:'local',steps:[]})]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'automations.json')))[0],future);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('v1 task extension metadata survives normalization and validation',()=>{
 const task={id:'metadata',steps:[],'x-example':{nested:[1,2]}};
 assert.deepEqual(automation.validateTask(task)['x-example'],task['x-example']);
});

const {previewPackage,versionAtLeast}=require('../scripts/automation-packages');
const runtime={version:'1.1.91',profileId:'workbuddy-cn',platform:'darwin'};
const example=()=>({kind:'workdaddy.automation-package',formatVersion:1,id:'org.example.account-notice',version:'1.0.0',name:'Account notice',requires:{minWorkDaddyVersion:'1.1.90',taskSchemaVersion:1,capabilities:['account.status'],profiles:['workbuddy-cn'],platforms:['darwin','win32']},inputs:{message:{type:'string',title:'Message',default:'Hello'}},task:{schemaVersion:1,name:'Notice',trigger:{type:'panelOpened'},steps:[{op:'account.status',saveAs:'status'},{op:'notify.toast',message:'{{vars.message}}'}]}});
test('package preview binds inputs, derives capabilities and stays disabled without mutating input',()=>{
 const input=example(),before=JSON.stringify(input);const p=previewPackage(input,{runtime,values:{message:'Custom'}});
 assert.equal(p.compatible,true);assert.equal(p.executed,false);assert.equal(p.task.enabled,false);assert.equal(p.task.variables.message,'Custom');
 assert.ok(p.analysis.capabilities.includes('event.panelOpened'));assert.ok(p.analysis.capabilities.includes('notify.toast'));assert.equal(JSON.stringify(input),before);assert.match(p.sha256,/^[a-f0-9]{64}$/);
});
test('package compatibility rejects newer versions, other profiles/platforms and undeclared missing capabilities',()=>{
 const input=example();input.requires.minWorkDaddyVersion='2.0.0';input.task.steps.push({op:'future.send'});
 const p=previewPackage(input,{runtime:{...runtime,profileId:'workbuddy-ai',platform:'linux'}});
 assert.equal(p.compatible,false);for(const code of ['workdaddy_version','profile','platform','capability'])assert.ok(p.issues.some(i=>i.code===code));
});
test('future formats are not silently reinterpreted as legacy tasks',()=>{
 for(const patch of [{formatVersion:2},{kind:'other-package'}])assert.equal(previewPackage({...example(),...patch},{runtime}).compatible,false);
 const p=example();p.requires.taskSchemaVersion=2;p.task.schemaVersion=2;assert.equal(previewPackage(p,{runtime}).task,null);
});
test('legacy JSON remains previewable; hashes identify bytes, not publisher trust',()=>{
 const text='{"id":"legacy","steps":[]}';const p=previewPackage(text,{runtime});assert.equal(p.kind,'legacy-task');assert.equal(p.compatible,true);
 assert.notEqual(p.sha256,previewPackage(text+'\n',{runtime}).sha256);
});
test('input requirements and types cannot silently coerce or inject extra variables',()=>{
 const p=example();p.inputs.message={type:'string',required:true};assert.ok(previewPackage(p,{runtime}).issues.some(i=>i.code==='input_required'));
 assert.throws(()=>previewPackage(p,{runtime,values:{message:3}}));assert.throws(()=>previewPackage(p,{runtime,values:{extra:'x'}}));
 p.inputs.message.default=123;assert.throws(()=>previewPackage(p,{runtime}));
});
test('unknown behavioral fields require a new contract; x- metadata is accepted',()=>{
 assert.throws(()=>previewPackage({...example(),shell:'echo hi'},{runtime}));assert.equal(previewPackage({...example(),'x-author-notes':'metadata only'},{runtime}).compatible,true);
 assert.throws(()=>previewPackage({...example(),id:'unscoped'},{runtime}));assert.throws(()=>previewPackage({...example(),version:'latest'},{runtime}));
 assert.equal(versionAtLeast('1.10.0','1.9.9'),true);assert.equal(versionAtLeast('1.1.91','2.0.0'),false);
});
test('preview refuses oversized documents and collects onFailure side effects',()=>{
 assert.throws(()=>previewPackage(' '.repeat(1024*1024+1)));
 const p=example();p.task.onFailure=[{op:'account.forEach',switch:true,steps:[{op:'session.create',message:'hello'}]}];
 const result=previewPackage(p,{runtime});assert.ok(result.analysis.effects.includes('account-switch'));assert.ok(result.analysis.effects.includes('send-message'));
});
test('same-schema tasks also stop on version downgrade or missing capabilities',async()=>{
 automation.configureAutomationRuntime(runtime);
 const task=previewPackage(example(),{runtime}).task;assert.equal(automation.isTaskCompatible(task),true);
 automation.configureAutomationRuntime({...runtime,version:'1.0.0'});
 assert.equal(automation.isTaskCompatible(task),false);assert.equal(automation.taskMatchesEvent({...task,enabled:true},'panelOpened'),false);
 await assert.rejects(automation.executeTask(task),/不兼容/);
 automation.configureAutomationRuntime({});
});
test('unknown events are preserved and blocked instead of becoming manual tasks',()=>{
 const task=automation.normalizeTask({id:'future-event',trigger:{type:'futureEvent'},steps:[]});
 assert.equal(task.trigger.type,'futureEvent');assert.equal(automation.isTaskCompatible(task),false);assert.equal(automation.canManuallyRunTask(task),false);
});
test('JSON request data is not mistaken for executable steps',()=>{
 const p=example();p.task.steps=[{op:'http.request',url:'https://example.com',body:{op:'future.send'}}];
 const result=previewPackage(p,{runtime});assert.equal(result.compatible,true);assert.ok(!result.analysis.capabilities.includes('future.send'));assert.deepEqual(result.analysis.effects,['network']);
});
test('published example previews successfully and never enables itself',()=>{
 const p=previewPackage(fs.readFileSync(path.join(__dirname,'../examples/automation-packages/account-summary.workdaddy.json')),{runtime});
 assert.equal(p.compatible,true);assert.equal(p.task.enabled,false);assert.equal(p.task.requires.minWorkDaddyVersion,'1.1.91');
});
test('a future larger task list is not truncated by editing another task',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wd-task-list-'));
 try{
  const tasks=Array.from({length:201},(_,i)=>({schemaVersion:2,id:'future_'+i,steps:[]}));
  fs.writeFileSync(path.join(dir,'automations.json'),JSON.stringify(tasks));
  const read=automation.readAutomations(dir);assert.equal(read.length,201);automation.writeAutomations(dir,read);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'automations.json'))),tasks);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('a package cannot be silently unwrapped by the executable task or Agent inbox',()=>{
 assert.throws(()=>automation.validateTask(example()),/不能作为本地任务/);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wd-package-inbox-'));
 try{
  const paths=automation.agentBridgePaths(dir);fs.mkdirSync(paths.inboxDir,{recursive:true});
  fs.writeFileSync(path.join(paths.inboxDir,'external.json'),JSON.stringify(example()));
  const results=automation.importAgentInbox(dir,{settleMs:0});assert.equal(results[0].ok,false);assert.deepEqual(automation.readAutomations(dir),[]);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('example index pins the exact package bytes',()=>{
 const dir=path.join(__dirname,'../examples/automation-packages');const index=JSON.parse(fs.readFileSync(path.join(dir,'workdaddy-automations.json')));
 const item=index.items[0],p=previewPackage(fs.readFileSync(path.join(dir,item.path)),{runtime});
 assert.equal(item.sha256,p.sha256);assert.equal(item.id,p.package.id);assert.equal(item.version,p.package.version);
});
test('UTF-8 BOM files from Windows retain their byte hash and preview correctly',()=>{
 const text=JSON.stringify(example()),a=previewPackage(text,{runtime}),b=previewPackage('\uFEFF'+text,{runtime});
 assert.equal(b.compatible,true);assert.notEqual(a.sha256,b.sha256);
});
