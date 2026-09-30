'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../scripts/inject.js'),'utf8');
function fixture(){
 const nodes=new Map(),node=key=>{if(!nodes.has(key))nodes.set(key,{hidden:false,disabled:false,textContent:'',focus(){},removeAttribute(name){delete this[name];},querySelector:node});return nodes.get(key);};
 const calls=[],requests=[],timers=[];
 const ctx={sessionsPane:{querySelector:node},sessionsState:{},alive:true,clearTimeout(){},setBuildTimeout(fn){timers.push(fn);return timers.length;},
   sessionCopySizeText:bytes=>String(bytes),wbsTranslateString:value=>String(value),WBS_LANGUAGE:'zh',api:url=>{calls.push(url);return new Promise((resolve,reject)=>requests.push({resolve,reject}));}};
 const start=source.indexOf('    function renderSessionExport(');
 vm.runInNewContext(source.slice(start,source.indexOf('    function sortSessionAccounts(',start)),ctx);
 return{ctx,node,calls,requests,timers};
}
test('export progress uses byte counts above 2 GiB and safe text for paths and errors',()=>{
 const f=fixture(),job={id:'one',status:'writing',running:true,totalBytes:3*1024**3,processedBytes:2.4*1024**3,percent:80};
 f.ctx.renderSessionExport(job);
 assert.equal(f.node('#wbs-sess-export').disabled,true);
 assert.equal(f.node('[data-export-progress]').value,80);
 assert.equal(f.node('[data-export-open]').hidden,true);
 f.ctx.renderSessionExport({...job,status:'completed',running:false,file:'/Downloads/<not-html>.wds'});
 assert.equal(f.node('[data-export-detail]').textContent,'/Downloads/<not-html>.wds');
 assert.equal(f.node('[data-export-open]').hidden,false);assert.equal(f.node('[data-export-cancel]').hidden,true);
 assert.equal(f.node('[data-export-progress]').hidden,true);
 f.ctx.renderSessionExport(null);assert.equal(f.node('#wbs-sess-export-progress').hidden,true);
});
test('reload resumes daemon progress; stale responses cannot replace a newer job',async()=>{
 const f=fixture();const first=f.ctx.pollSessionExport();
 assert.equal(f.calls[0],'/api/sessions/export');
 const second=f.ctx.pollSessionExport('new');
 f.requests[1].resolve({job:{id:'new',running:false,status:'completed',file:'new.wds'}});await second;
 f.requests[0].resolve({job:{id:'old',running:true,status:'writing'}});await first;
 assert.equal(f.ctx.sessionsState.exportJob.id,'new');assert.equal(f.timers.length,0);
});
test('a daemon restart discards the missing job id instead of polling it forever',async()=>{
 const f=fixture();const poll=f.ctx.pollSessionExport('old');
 f.requests[0].reject({payload:{code:'EXPORT_JOB_NOT_FOUND'}});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.calls[1],'/api/sessions/export');
 f.requests[1].resolve({job:null});await poll;
 assert.equal(f.node('#wbs-sess-export-progress').hidden,true);
});

test('export dialog stays dismissed during polling and opens for completion or a new job',()=>{
 const f=fixture(),job={id:'one',running:true,status:'writing'};
 f.ctx.renderSessionExport(job);
 f.ctx.dismissSessionExport();
 f.ctx.renderSessionExport({...job,percent:80});
 assert.equal(f.node('#wbs-sess-export-progress').hidden,true);
 f.ctx.renderSessionExport({...job,running:false,status:'completed',file:'done.wds'});
 assert.equal(f.node('#wbs-sess-export-progress').hidden,false);
 f.ctx.dismissSessionExport();
 f.ctx.renderSessionExport({...job,running:false,status:'completed',file:'done.wds'});
 assert.equal(f.node('#wbs-sess-export-progress').hidden,true);
 f.ctx.renderSessionExport({...job,id:'two'});
 assert.equal(f.node('#wbs-sess-export-progress').hidden,false);
});

test('export dialog is a WorkDaddy panel overlay rather than a body overlay',()=>{
 const markup=source.slice(source.indexOf("'<div class=\"wbs-modal-mask wbs-modal-mask-panel wbs-sess-export-progress\""),source.indexOf("'<div class=\"wbs-sess-copy-progress\""));
 assert.match(markup,/wbs-modal-mask-panel/);
 const wireStart=source.indexOf('    function wireSessionsPane()');
 const wireEnd=source.indexOf('    function renderSessionExport(',wireStart);
 const wire=source.slice(wireStart,wireEnd);
 assert.match(wire,/var panel = root && root\.querySelector\('\.wbs-panel'\);/);
 assert.match(wire,/panel\.appendChild\(exportCard\)/);
 assert.doesNotMatch(wire,/mountPersistentOverlay\(exportCard\)/);
});
