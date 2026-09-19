'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {exportTasks,previewImport,importTasks}=require('../scripts/automation-transfer');
const {encodeZip,decodeZip}=require('../scripts/automation-zip');
const {readAutomations,writeAutomations}=require('../scripts/automation');
const runtime={version:'1.1.93',profileId:'workbuddy-cn',platform:'darwin'};
const task=(id='one')=>({schemaVersion:1,id,name:'测试任务',enabled:true,trigger:{type:'panelOpened'},schedule:{type:'daily',time:'09:00'},steps:[{op:'notify.toast',message:'Hello'}],'x-note':{keep:true}});
function input(result){return {content:result.content,encoding:result.encoding};}
test('single JSON and multi-task unencrypted ZIP round-trip definitions and stable IDs',()=>{
 const tasks=[task(),task('two')];
 const one=exportTasks(tasks,['one']);assert.match(one.filename,/\.json$/);assert.equal(one.encoding,'utf8');assert.deepEqual(JSON.parse(one.content),tasks[0]);
 const many=exportTasks(tasks,['one','two']);assert.match(many.filename,/\.zip$/);const zip=Buffer.from(many.content,'base64');assert.equal(zip.readUInt16LE(6)&1,0);
 const entries=decodeZip(zip);assert.equal(entries.length,2);
 for(const result of [one,many]){const p=previewImport(input(result),[],runtime);assert.equal(p.entries.length,result.count);for(const e of p.entries){assert.equal(e.compatible,true);assert.equal(e.task.enabled,false);assert.equal(e.task.schedule.time,'09:00');assert.deepEqual(e.task['x-note'],{keep:true});}}
});
test('duplicate IDs skip existing tasks without overwriting or re-enabling them, including races',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wd-transfer-'));
 try{
  const local={...task(),name:'用户改过',enabled:false};writeAutomations(dir,[local]);
  const payload=input(exportTasks([task(),task('two')],['one','two']));
  const p=previewImport(payload,readAutomations(dir),runtime);assert.equal(p.entries[0].existing,true);
  const result=importTasks(dir,{...payload,selected:['0','1']},runtime);assert.equal(result.imported,1);assert.equal(result.skipped,1);
  assert.equal(readAutomations(dir).find(t=>t.id==='one').name,'用户改过');assert.equal(readAutomations(dir).find(t=>t.id==='two').enabled,false);
  const before=fs.readFileSync(path.join(dir,'automations.json'));assert.equal(importTasks(dir,{...payload,selected:['1']},runtime).imported,0);assert.deepEqual(fs.readFileSync(path.join(dir,'automations.json')),before);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('package updates replace the matching imported task and keep its runtime ID', () => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wd-transfer-package-update-'));
 try{
  const packageFile=path.join(__dirname,'../examples/automation-packages/account-summary.workdaddy.json');
  const older=JSON.parse(fs.readFileSync(packageFile,'utf8'));
  const newer={...older,version:'1.1.0',name:'新版账号概况',task:{...older.task,name:'新版账号概况'}};
  const first=importTasks(dir,{content:JSON.stringify(older),selected:['0']},runtime);
  assert.equal(first.imported,1);
  const before=readAutomations(dir)[0];
  const result=importTasks(dir,{content:JSON.stringify(newer),selected:['0'],replaceExisting:true},runtime);
  assert.equal(result.replaced,1);
  assert.equal(result.imported,0);
  const updated=readAutomations(dir)[0];
  assert.equal(updated.id,before.id);
  assert.equal(updated.name,'新版账号概况');
  assert.equal(updated['x-workdaddy-import'].packageId,older.id);
  assert.equal(updated['x-workdaddy-import'].packageVersion,'1.1.0');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('invalid selected task and capacity failures do not partially save',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wd-transfer-'));
 try{
  writeAutomations(dir,[task('existing')]);const before=fs.readFileSync(path.join(dir,'automations.json'));
  const bytes=encodeZip([{name:'good.json',content:Buffer.from(JSON.stringify(task()))},{name:'bad.json',content:Buffer.from('{"id":"bad","steps":[{"op":"future.op"}]}')}]);
  const payload={content:bytes.toString('base64'),encoding:'base64',selected:['0','1']};
  assert.equal(previewImport(payload,[],runtime).entries[1].compatible,false);assert.throws(()=>importTasks(dir,payload,runtime));assert.deepEqual(fs.readFileSync(path.join(dir,'automations.json')),before);
  writeAutomations(dir,Array.from({length:200},(_,i)=>task('existing_'+i)));assert.throws(()=>importTasks(dir,{...input(exportTasks([task()],['one'])),selected:['0']},runtime),/上限/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('JSON imports reject unrelated documents and block future schema, dependencies and missing package inputs',()=>{
 for(const doc of [{hello:'world'},[],{kind:'workdaddy.automation-index',items:[]}]){const p=previewImport({content:JSON.stringify(doc)},[],runtime);assert.equal(p.entries[0].compatible,false);}
 assert.equal(previewImport({content:JSON.stringify({...task(),schemaVersion:2})},[],runtime).entries[0].compatible,true);
 for(const doc of [{...task(),schemaVersion:3},{...task(),requires:{minWorkDaddyVersion:'9.0.0',taskSchemaVersion:1,capabilities:[]}}])assert.equal(previewImport({content:JSON.stringify(doc)},[],runtime).entries[0].compatible,false);
 const pkg=JSON.parse(fs.readFileSync(path.join(__dirname,'../examples/automation-packages/account-summary.workdaddy.json')));
 const p=previewImport({content:JSON.stringify(pkg)},[],runtime);assert.equal(p.entries[0].compatible,true);assert.notEqual(p.entries[0].task.id,'package_preview');assert.equal(p.entries[0].task.enabled,false);
 pkg.inputs.requiredValue={type:'string',required:true};assert.equal(previewImport({content:JSON.stringify(pkg)},[],runtime).entries[0].compatible,false);
});
test('ZIP rejects traversal, encryption, corrupt CRC and zip bombs; accepts deflate and harmless Mac metadata',()=>{
 const good=encodeZip([{name:'one.json',content:Buffer.from(JSON.stringify(task()))}]);
 const corrupt=Buffer.from(good);corrupt[30+Buffer.byteLength('one.json')]^=1;assert.throws(()=>decodeZip(corrupt));
 const encrypted=Buffer.from(good);encrypted.writeUInt16LE(1,6);assert.throws(()=>decodeZip(encrypted));
 const central=good.indexOf(Buffer.from('504b0102','hex'));const bomb=Buffer.from(good);bomb.writeUInt32LE(0x7fffffff,central+24);assert.throws(()=>decodeZip(bomb));
 assert.throws(()=>encodeZip([{name:'../x.json',content:Buffer.from('{}')}]));
 const meta=encodeZip([{name:'__MACOSX/._one.json',content:Buffer.from('metadata')},{name:'one.json',content:Buffer.from(JSON.stringify(task()))}]);assert.equal(previewImport({content:meta.toString('base64'),encoding:'base64'},[],runtime).entries.length,1);
 assert.throws(()=>previewImport({content:'a'.repeat(12*1024*1024),encoding:'base64'},[],runtime));
 const zlib=require('node:zlib');const plain=Buffer.from(JSON.stringify(task()));const compressed=zlib.deflateRawSync(plain);const stored=encodeZip([{name:'one.json',content:plain}]);const offset=30+8,cd=offset+plain.length;
 const head=Buffer.from(stored.subarray(0,offset)),tail=Buffer.from(stored.subarray(cd));head.writeUInt16LE(8,8);head.writeUInt32LE(compressed.length,18);tail.writeUInt16LE(8,10);tail.writeUInt32LE(compressed.length,20);tail.writeUInt32LE(offset+compressed.length,tail.length-6);
 assert.deepEqual(decodeZip(Buffer.concat([head,compressed,tail]))[0].content,plain);
});
test('export requires exact selected IDs and excludes UI-only flags',()=>{
 assert.throws(()=>exportTasks([task()],[]));assert.throws(()=>exportTasks([task()],['missing']));
 const output=JSON.parse(exportTasks([{...task(),manualRunnable:true,compatible:true}],['one']).content);assert.equal(output.compatible,undefined);assert.equal(output.manualRunnable,undefined);
});
test('file request reader bounds payloads and rejects malformed JSON',async()=>{
 const {readTransferBody}=require('../scripts/automation-transfer'),{PassThrough}=require('node:stream');
 const valid=new PassThrough(),parsed=readTransferBody(valid);valid.end('{"content":"{}"}');assert.deepEqual(await parsed,{content:'{}'});
 const bad=new PassThrough(),invalid=readTransferBody(bad);bad.end('{');await assert.rejects(invalid,/编码/);
 const large=new PassThrough(),oversize=readTransferBody(large);large.end(Buffer.alloc(12*1024*1024+1));await assert.rejects(oversize,/8 MiB/);
});
test('transfer endpoint exports but cannot import local files',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../scripts/daemon.js'),'utf8');
 const begin=source.indexOf("  if (req.method === 'POST' && p === '/api/automations/export')");
 const end=source.indexOf("  if (req.method === 'POST' && p === '/api/automations/packages/preview')",begin);
 assert.ok(begin>=0&&end>begin);
 const route=new Function('req','p','res','readTransferBody','exportTasks','readAutomations','DATA_DIR','json',source.slice(begin,end));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wd-transfer-route-'));
 const call=(p,body)=>route({method:'POST'},p,{},async()=>body,exportTasks,readAutomations,dir,(_,status,data)=>({status,...data}));
 try{
  writeAutomations(dir,[task()]);
  const before=fs.readFileSync(path.join(dir,'automations.json'));
  const file=await call('/api/automations/export',{ids:['one']});assert.equal(file.status,200);
  assert.equal(await call('/api/automations/import/preview',input(file)),undefined);
  assert.equal(await call('/api/automations/import',{...input(file),selected:['0']}),undefined);
  assert.deepEqual(fs.readFileSync(path.join(dir,'automations.json')),before);
  const invalid=await call('/api/automations/export',{ids:['missing']});assert.equal(invalid.status,400);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('automation page offers only Gitee discovery for importing tasks',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../scripts/inject.js'),'utf8');
 assert.match(source, /\/api\/automations\/discovery\/import/);
 assert.match(source, /id="wbs-auto-discover"/);
 assert.doesNotMatch(source, /wbs-auto-import-file|\/api\/automations\/import\/preview|\/api\/automations\/import'/);
});
