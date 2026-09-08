'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../scripts/daemon.js'), 'utf8');
const functions = source.slice(source.indexOf('async function ensureAutomationNewTask('), source.indexOf('\nfunction currentAccount()'));
function harness(options = {}) {
  let sessionSent = false; let clock = 0;
  const calls = []; let draft = options.draft === false ? '' : 'existing draft'; let ready = !options.project;
  const context = { automationAgentSurfaceExpression: () => '({newTaskReady:true})', cdp: { connected: true }, sleep: async ms => { clock += ms; }, Date: { now: () => clock },
    readAutomationAgentSurface: async () => ({ ready: true, newTaskReady: ready, hasComposer: true, composerText: draft, button: {x:1,y:1} }),
    cdpMouseClick: async () => { calls.push('navigate'); ready = true; },
    cdpSend: async (method, params) => {
      if (method === 'Runtime.evaluate' && params.expression.includes('probeSessionReceipt')) return {result:{value:sessionSent?{conversationId:'c',userMessageId:'u',requestId:'r'}:null}};
      calls.push(method);
      if (method === 'Runtime.evaluate') { if (options.draftChanges) draft = 'newly typed draft'; return { result: { value: { saved: !options.backupFails } } }; }
      if (params.key === 'Backspace' && params.type === 'keyDown') draft = '';
      return {};
    },
    sendStashToComposer: async () => { calls.push('send'); return { sent: true }; },
  };
  vm.createContext(context);vm.runInContext(functions,context);
  const callback = source.slice(source.indexOf('  let lastReceipt = null;'), source.indexOf('  const completionReport =', source.indexOf('  let lastReceipt = null;')));
  Object.assign(context,require('../scripts/automation-runtime'),{withInput:async fn=>fn(),isCancelled:()=>false,currentAccount:()=>({uid:'a'})});
  context.acSendPhrase = async () => { calls.push('session-send'); sessionSent=true; return {sent:true}; };
  vm.runInContext(callback + '\nthis.sessionSend = sessionSendCurrent; this.sessionAction = sessionAction;', context);
  return { run: () => context.openNewAutomationAgentTask('Agent requirement'), session: () => context.sessionSend('1+1='), calls };
}
test('Agent creation saves a new-task draft before clearing and sending', async () => {
  const h=harness();await h.run();assert.ok(h.calls.indexOf('Runtime.evaluate')<h.calls.indexOf('Input.dispatchKeyEvent'));assert.equal(h.calls.at(-1),'send');
});
test('failed draft backup prevents clearing and sending', async () => {
  const h=harness({backupFails:true});await assert.rejects(h.run());assert.ok(!h.calls.includes('Input.dispatchKeyEvent'));assert.ok(!h.calls.includes('send'));
});
test('a project composer cannot bypass navigation to New Task', async () => {
  const h=harness({project:true,draft:false});await h.run();assert.equal(h.calls[0],'navigate');assert.equal(h.calls.at(-1),'send');
});
test('current-account corner mark is removed and selecting primary explains its automation use',()=>{
 const ui=fs.readFileSync(require('node:path').join(__dirname,'../scripts/inject.js'),'utf8');
 assert.ok(!ui.includes('wbs-cur-marker'));assert.ok(ui.includes("toast('已设为主账号，自动化任务可据此识别主账号'"));
});

test('typing during draft backup cancels without clearing the new text', async () => {
 const h=harness({draftChanges:true});await assert.rejects(h.run(),/草稿已变化/);assert.ok(!h.calls.includes('Input.dispatchKeyEvent'));assert.ok(!h.calls.includes('send'));
});

test('automation session.sendCurrent preserves occupied New Task draft before baseline and send',async()=>{
 const h=harness();await h.session();
 assert.ok(h.calls.indexOf('Runtime.evaluate')<h.calls.indexOf('Input.dispatchKeyEvent'));
 assert.equal(h.calls.at(-1),'session-send');
});
test('automation session.sendCurrent refuses to send if saving fails or the draft changes',async()=>{
 for(const options of [{backupFails:true},{draftChanges:true}]){
 const h=harness(options);await assert.rejects(h.session());assert.ok(!h.calls.includes('session-send'));assert.ok(!h.calls.includes('Input.dispatchKeyEvent'));
 }
});
