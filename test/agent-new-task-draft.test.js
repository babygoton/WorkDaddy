'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../scripts/daemon.js'), 'utf8');
const functions = source.slice(source.indexOf('async function ensureAutomationNewTask('), source.indexOf('\nfunction currentAccount()'));
function harness(options = {}) {
  let sessionSent = false; let modelConversation = false; let clock = 0; let receiptProbes = 0; let clearReads = 0; let clearing = false;
  const calls = []; let draft = options.draft === false ? '' : 'existing draft'; let ready = !options.project;
  const context = { automationAgentSurfaceExpression: () => '({newTaskReady:true})', cdp: { connected: true }, sleep: async ms => { clock += ms; }, Date: { now: () => clock },
    readAutomationAgentSurface: async () => {
      if (clearing && options.clearAfterReads && clearReads++ >= options.clearAfterReads) draft = '';
      return { ready: true, newTaskReady: ready, hasComposer: true, composerText: draft, button: {x:1,y:1} };
    },
    cdpMouseClick: async () => { calls.push('navigate'); ready = true; },
    cdpSend: async (method, params) => {
      if (method === 'Runtime.evaluate' && params.expression.includes('probeSessionReceipt')) {
        receiptProbes++;
        const confirmed = sessionSent && receiptProbes >= (options.receiptAfterProbes || 1);
        const provisional = options.modelCreatesConversation && modelConversation
          ? { conversationId: 'c', userMessageId: '', requestId: '' }
          : null;
        const initial = options.initialConversation && !sessionSent
          ? { conversationId: 'old', userMessageId: '', requestId: '' }
          : null;
        return {result:{value:confirmed?{conversationId:'c',userMessageId:'u',requestId:'r'}:provisional || initial}};
      }
      calls.push(method);
      if (method === 'Runtime.evaluate') { if (options.draftChanges) draft = 'newly typed draft'; return { result: { value: { saved: !options.backupFails } } }; }
      if (params.key === 'Backspace' && params.type === 'keyDown') {
        clearing = true;
        if (!options.clearAfterReads) draft = '';
      }
      return {};
    },
    sendStashToComposer: async () => { calls.push('send'); return { sent: true }; },
  };
  vm.createContext(context);vm.runInContext(functions,context);
  const callback = source.slice(source.indexOf('  let lastReceipt = null;'), source.indexOf('  const completionReport =', source.indexOf('  let lastReceipt = null;')));
  Object.assign(context,require('../scripts/automation-runtime'),{
    withInput:async fn=>fn(),isCancelled:()=>false,currentAccount:()=>({uid:'a'}),cancellableWait:async ms=>{clock+=ms;},
    normalizeAutomationModelId:model=>model,
    selectAutomationModelById:async()=>{modelConversation=true;return {displayName:'Deepseek',changed:false};},
    confirmAutomationModel:async()=>true,
    appendRunLog:message=>calls.push(message),
  });
  context.acSendPhrase = async (message, sendOptions = {}) => {
    if (sendOptions.guard) await sendOptions.guard();
    if (sendOptions.beforeSubmit) await sendOptions.beforeSubmit();
    calls.push('session-send'); sessionSent=true;
    // The real sender runs the guard again while observing the composer after
    // the click, when a New Task controller may have just mounted.
    if (sendOptions.guard) await sendOptions.guard();
    return {sent:true};
  };
  vm.runInContext(callback + '\nthis.sessionSend = sessionSendCurrent; this.sessionAction = sessionAction;', context);
  return {
    run: () => context.openNewAutomationAgentTask('Agent requirement'),
    session: () => context.sessionSend('1+1='),
    sessionWithModel: () => context.sessionAction('session.create', { message: '1+1=', model: 'deepseek-v4.1-flash' }),
    calls,
  };
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
test('account corner and primary controls are absent',()=>{
 const ui=fs.readFileSync(require('node:path').join(__dirname,'../scripts/inject.js'),'utf8');
 assert.ok(!ui.includes('wbs-cur-marker'));assert.ok(!ui.includes('data-primary-uid'));
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

test('controlled New Task composer may clear after several renderer probes', async () => {
 const h=harness({clearAfterReads:3});await h.run();assert.equal(h.calls.at(-1),'send');
});

test('new-session receipt may mount after the former twelve-second window', async () => {
 const h=harness({draft:false,receiptAfterProbes:150});await h.session();assert.equal(h.calls.at(-1),'session-send');
});

test('new session accepts the first conversation mounted after the send', async () => {
 const h=harness({draft:false});
 await h.session();
 assert.ok(h.calls.includes('session-send'));
});

test('new session accepts the expected conversation transition after the send', async () => {
 const h=harness({draft:false,initialConversation:true});
 await h.session();
 assert.ok(h.calls.includes('session-send'));
});

test('model selection may mount the provisional new conversation before sending', async () => {
 const h=harness({draft:false,modelCreatesConversation:true});await h.sessionWithModel();assert.ok(h.calls.includes('session-send'));
});

test('model selection replaces a stale pre-navigation controller before sending', async () => {
 const h=harness({draft:false,initialConversation:true,modelCreatesConversation:true});
 await h.sessionWithModel();
 assert.ok(h.calls.includes('session-send'));
});
