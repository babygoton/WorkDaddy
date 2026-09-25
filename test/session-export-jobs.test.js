'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createSessionExportJobs, readSessionTransfer } = require('../scripts/session-transfer');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-export-job-'));
  t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  const file = path.join(root,'source'); fs.writeFileSync(file,'fixture content');
  const sessions = [{record:{id:'fixture-session'},files:[{path:'tasks/fixture-session/file.bin',source:file,size:fs.statSync(file).size}]}];
  return {root, sessions, directory:path.join(root,'Downloads','WorkDaddy')};
}
test('background export returns before preparation, publishes an authenticated file and no password', async t => {
  const f=fixture(t); let release;
  const preparing=new Promise(resolve=>{release=resolve;});
  const jobs=createSessionExportJobs({directory:()=>f.directory,prepare:async()=>{await preparing;return f.sessions;}});
  const started=jobs.start(['fixture-session'],'secret password');
  assert.equal(started.running,true); assert.equal(started.status,'preparing');
  assert.equal(JSON.stringify(started).includes('secret password'),false);
  assert.throws(()=>jobs.start(['fixture-session'],'another password'),/正在导出/);
  release(); await jobs.wait();
  const done=jobs.get(started.id);
  assert.equal(done.status,'completed');assert.equal(done.running,false);assert.equal(done.percent,100);
  assert.equal(done.processedBytes,f.sessions[0].files[0].size);
  assert.equal(path.dirname(done.file),f.directory);
  assert.equal(fs.readdirSync(f.directory).length,1,'no temporary files remain');
  const restored=await readSessionTransfer(done.file,'secret password',path.join(f.root,'restored'));
  assert.equal(fs.readFileSync(restored.sessions[0].files[0].source,'utf8'),'fixture content');
  assert.equal(JSON.stringify(jobs.get()).includes('secret password'),false);
});
test('cancelling before preparation completes never creates a finished archive', async t=>{
  const f=fixture(t);let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const jobs=createSessionExportJobs({directory:()=>f.directory,prepare:async()=>{await gate;return f.sessions;}});
  const started=jobs.start(['fixture-session'],'password');jobs.cancel(started.id);release();await jobs.wait();
  assert.equal(jobs.get().status,'cancelled');assert.equal(jobs.get().file,'');
  assert.equal(fs.existsSync(f.directory),false);
});
test('stream cancellation and disk failures remove staged archives, preserving existing downloads', async t=>{
  for(const cancel of [true,false]){
    const f=fixture(t);fs.mkdirSync(f.directory,{recursive:true});fs.writeFileSync(path.join(f.directory,'keep.wds'),'existing');
    let jobs;
    jobs=createSessionExportJobs({directory:()=>f.directory,prepare:async()=>f.sessions,write:async(file,sessions,password,options)=>{
      fs.writeFileSync(file,'incomplete');
      if(cancel){jobs.cancel(jobs.get().id);options.signal.throwIfAborted();}
      const error=Error('disk full');error.code='ENOSPC';throw error;
    }});
    jobs.start(['fixture-session'],'password');await jobs.wait();
    assert.equal(jobs.get().status,cancel?'cancelled':'failed');
    assert.equal(jobs.get().file,'');assert.deepEqual(fs.readdirSync(f.directory),['keep.wds']);
  }
});
test('new export jobs never overwrite earlier completed downloads',async t=>{
  const f=fixture(t),jobs=createSessionExportJobs({directory:()=>f.directory,prepare:async()=>f.sessions});
  jobs.start(['fixture-session'],'password');await jobs.wait();const first=jobs.get();
  jobs.start(['fixture-session'],'password');await jobs.wait();const second=jobs.get();
  assert.notEqual(first.file,second.file);assert.equal(fs.existsSync(first.file),true);
  assert.equal(jobs.get(first.id).status,'completed');
  assert.equal(jobs.get('../../unknown'),null);
});
