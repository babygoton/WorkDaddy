'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createAgentRequest}=require('../scripts/automation');
test('custom agent requirement retains exact text and guarded bridge instructions',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wd-agent-prompt-'));
 try {
  const prompt='每小时检查一次\n完成后显示通知，不切换账号。';
  const result=createAgentRequest(dir,{prompt,profileId:'workbuddy-cn'});
  assert.ok(result.prompt.startsWith(prompt+'\n\n'));
  assert.ok(result.prompt.includes(result.protocolPath));assert.ok(result.prompt.includes(result.inboxFile));assert.ok(result.prompt.includes(result.resultFile));
  assert.equal(result.exampleId,'');
  for(const invalid of ['', '  ', {}, 'x'.repeat(6001)])assert.throws(()=>createAgentRequest(dir,{prompt:invalid}),/需求/);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('agent dialog offers an editable requirement, example fill and one submit action',()=>{
 const s=fs.readFileSync(path.join(__dirname,'../scripts/inject.js'),'utf8');
 assert.ok(s.includes('id="wbs-auto-agent-prompt"'));assert.ok(s.includes('data-auto-example-fill'));
 assert.ok(!s.includes('data-auto-example-generate'));assert.ok(!s.includes('data-auto-example-preview'));
 assert.ok(s.includes('让 WorkBuddy 帮我创建'));
 const toolbar=s.slice(s.indexOf('id="wbs-auto-normal-actions"'),s.indexOf('id="wbs-auto-batch-actions"'));
 assert.ok(toolbar.indexOf('id="wbs-auto-pick"')<toolbar.indexOf('id="wbs-auto-create"'));
 const daemon=fs.readFileSync(path.join(__dirname,'../scripts/daemon.js'),'utf8');
 assert.ok(!daemon.includes("installBuiltinTask(DATA_DIR, path.join(__dirname, 'builtin/automations/report-to-primary.json'))"));
});
