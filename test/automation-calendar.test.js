'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const a=require('../scripts/automation');
const at=(s)=>new Date(s).getTime();
const task=(schedule)=>a.validateTask({id:'calendar',steps:[],schedule});
test('calendar schedules validate times, weekdays, dates and manual eligibility',()=>{
 for(const schedule of [{type:'daily',time:'09:30'},{type:'weekly',time:'18:00',days:[1,3,5]},{type:'monthly',time:'10:00',day:31},{type:'once',at:'2026-09-09T08:30'}])assert.equal(a.canManuallyRunTask(task(schedule)),false);
 for(const schedule of [{type:'daily',time:'25:00'},{type:'weekly',time:'08:00',days:[]},{type:'weekly',time:'08:00',days:[7]},{type:'monthly',time:'08:00',day:0},{type:'once',at:'2026-02-30T08:00'}])assert.throws(()=>task(schedule));
});
test('daily schedule runs once per local time slot, including after restart',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wd-calendar-'));try{
 const t=task({type:'daily',time:'09:30'}),calls=[];let tick=a.createScheduleTicker(dir);const run=x=>calls.push(x.id);
 tick([t],run,()=>false,at('2026-09-08T09:29:59'));assert.equal(calls.length,0);
 tick([t],run,()=>false,at('2026-09-08T09:30:00'));tick([t],run,()=>false,at('2026-09-08T09:30:30'));assert.equal(calls.length,1);
 tick=a.createScheduleTicker(dir);tick([t],run,()=>false,at('2026-09-08T09:30:50'));assert.equal(calls.length,1);
 tick([t],run,()=>false,at('2026-09-09T10:00:00'));assert.equal(calls.length,1,'missed slot is not replayed');
 tick([t],run,()=>false,at('2026-09-10T09:30:00'));assert.equal(calls.length,2);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('weekly/monthly/once match local calendar, skip overlap and nonexistent month dates',()=>{
 for(const [schedule,miss,match] of [
 [{type:'weekly',days:[1,5],time:'08:00'},'2026-09-08T08:00','2026-09-11T08:00'],
 [{type:'monthly',day:31,time:'08:00'},'2026-09-30T08:00','2026-10-31T08:00'],
 [{type:'once',at:'2026-09-09T08:00'},'2026-09-08T08:00','2026-09-09T08:00']]){
 const tick=a.createScheduleTicker(),t=task(schedule),calls=[];const run=x=>calls.push(x.id);
 tick([t],run,()=>false,at(miss));assert.equal(calls.length,0);tick([t],run,()=>true,at(match));tick([t],run,()=>false,at(match)+10000);assert.equal(calls.length,0);
 const fresh=a.createScheduleTicker();fresh([t],run,()=>false,at(match));assert.equal(calls.length,1);
 }
});
test('all three builtins preserve existing edits and deletion across updates',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wd-builtins-'));try{
 const files=fs.readdirSync(path.join(__dirname,'../scripts/builtin/automations')).filter(f=>f.endsWith('.json'));assert.equal(files.length,3);
 const install=()=>files.forEach(f=>a.installBuiltinTask(dir,path.join(__dirname,'../scripts/builtin/automations',f)));
 install();const original=a.readAutomations(dir);assert.equal(new Set(original.map(t=>t.id)).size,3);
 const edited=original.slice(1).map(t=>({...t,name:'用户修改',enabled:false}));a.writeAutomations(dir,edited);install();assert.deepEqual(a.readAutomations(dir),edited);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('existing builtin IDs are adopted without replacing definitions when markers are absent',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wd-adopt-'));try{
 const file=path.join(__dirname,'../scripts/builtin/automations/keep-accounts-active.json');
 const t=a.validateTask({...JSON.parse(fs.readFileSync(file)),name:'用户自定义',steps:[],enabled:false});
 a.writeAutomations(dir,[t]);a.installBuiltinTask(dir,file);assert.deepEqual(a.readAutomations(dir),[t]);
 a.writeAutomations(dir,[]);a.installBuiltinTask(dir,file);assert.deepEqual(a.readAutomations(dir),[]);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('a revisioned builtin upgrades only an unchanged historical definition',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wd-builtin-upgrade-'));try{
 const oldFile=path.join(dir,'old.json'),newFile=path.join(dir,'new.json');
 const oldTask={schemaVersion:1,id:'builtin',name:'Built in',description:'old',enabled:true,trigger:{type:'pageReady'},schedule:{type:'manual'},variables:{},steps:[{op:'logic.delay',ms:100}],onSuccess:[],onFailure:[]};
 fs.writeFileSync(oldFile,JSON.stringify(oldTask));
 a.installBuiltinTask(dir,oldFile);
 const installed=a.readAutomations(dir);installed[0].enabled=false;installed[0].schedule={type:'daily',time:'09:00'};installed[0].trigger={type:'panelOpened',oncePerNavigation:true};a.writeAutomations(dir,installed);
 const next={...oldTask,revision:2,upgradeFromContentHashes:['6fde9da397c1295d89f44c3f816919fb05e5b5fcb1ce7e140640d54f58119f7f'],description:'new',steps:[{op:'logic.delay',ms:200}]};
 fs.writeFileSync(newFile,JSON.stringify(next));
 const result=a.installBuiltinTask(dir,newFile);
 const upgraded=a.readAutomations(dir)[0];
 assert.equal(result.status,'upgraded');assert.equal(upgraded.revision,2);assert.equal(upgraded.steps[0].ms,200);
 assert.equal(upgraded.enabled,false);assert.deepEqual(upgraded.schedule,{type:'daily',time:'09:00'});assert.equal(upgraded.trigger.type,'panelOpened');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('a revisioned builtin never overwrites customized content or an unmarked matching ID',()=>{
 const makeDir=()=>fs.mkdtempSync(path.join(os.tmpdir(),'wd-builtin-custom-'));
 for(const marked of [true,false]){const dir=makeDir();try{
 const oldTask={schemaVersion:1,id:'builtin',name:'Built in',description:'old',enabled:true,trigger:{type:'manual'},schedule:{type:'manual'},variables:{},steps:[{op:'logic.delay',ms:999}],onSuccess:[],onFailure:[]};
 const file=path.join(dir,'new.json');
 a.writeAutomations(dir,[a.validateTask(oldTask)]);
 if(marked)fs.writeFileSync(path.join(dir,'automation-builtins.json'),JSON.stringify({builtin:true}));
 fs.writeFileSync(file,JSON.stringify({...oldTask,revision:2,upgradeFromContentHashes:['6fde9da397c1295d89f44c3f816919fb05e5b5fcb1ce7e140640d54f58119f7f'],steps:[{op:'logic.delay',ms:200}]}));
 const result=a.installBuiltinTask(dir,file);
 assert.equal(result.status,'skipped');assert.equal(a.readAutomations(dir)[0].steps[0].ms,999);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}}
});
