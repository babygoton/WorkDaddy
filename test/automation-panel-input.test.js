'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const daemon=fs.readFileSync(path.join(__dirname,'../scripts/daemon.js'),'utf8');
const ui=fs.readFileSync(path.join(__dirname,'../scripts/inject.js'),'utf8');

test('panel opening is blocked only during input; waiting for a reply still allows access',()=>{
 const calls=[];const noop=()=>{};
 const ctx={window:{__wbsAutomationInputActive:true},state:{open:false},root:{},panel:{classList:{toggle:noop}},fab:{classList:{toggle:noop}},CAPS:{accounts:false},fabQuietMode:{wake:noop},toast:()=>calls.push('blocked'),refresh:()=>calls.push('refresh'),checkForUpdate:noop,acCheckPromptOnOpen:noop,syncSessionModule:noop,api:()=>Promise.resolve()};
 const start=ui.indexOf('    function setOpen(open, options)');
 vm.runInNewContext(ui.slice(start,ui.indexOf('    function setupFabDrag()',start)),ctx);
 ctx.setOpen(true);assert.equal(ctx.state.open,false);assert.deepEqual(calls,['blocked']);
 ctx.window.__wbsAutomationInputActive=false;ctx.setOpen(true);assert.equal(ctx.state.open,true);assert.deepEqual(calls,['blocked','refresh']);
});

for(const fails of [false,true])test('input lease closes an opened panel and releases protection on '+(fails?'failure':'success'),async()=>{
 const calls=[];
 const ctx={requiresLease:true,run:{wasPanelOpen:false},isCancelled:()=>false,acquireAutomationInput:async()=>()=>calls.push('release'),automationPanelIsOpen:async()=>true,automationPanelSetInputActive:async active=>calls.push(active?'lock':'unlock')};
 const start=daemon.indexOf('  const withInput = async');
 vm.runInNewContext(daemon.slice(start,daemon.indexOf('  let lastReceipt',start))+'this.withInput=withInput;',ctx);
 const fn=async()=>{calls.push('input');if(fails)throw Error('input failure');return 42};
 if(fails)await assert.rejects(ctx.withInput(fn),/input failure/);else assert.equal(await ctx.withInput(fn),42);
 assert.deepEqual(calls,['lock','input','unlock','release']);assert.equal(ctx.run.wasPanelOpen,true);
});

test('reinjection synchronizes input protection and an interrupted run can unlock the same renderer',async()=>{
 const events=[];const renderer={window:{__wbsAutomationInputActive:true,dispatchEvent:e=>events.push(e)},CustomEvent:function(type,options){this.type=type;this.detail=options.detail}};
 const ctx={cdp:{connected:true},automationInputActive:false,cdpSend:async(_,params)=>{vm.runInNewContext(params.expression,renderer);return {}}};
 const start=daemon.indexOf('function automationPanelSetInputActive(');
 vm.runInNewContext(daemon.slice(start,daemon.indexOf('function automationPanelSetOpen(',start)),ctx);
 await ctx.automationPanelSetInputActive(false);assert.equal(renderer.window.__wbsAutomationInputActive,false);
 await ctx.automationPanelSetInputActive(true);assert.equal(renderer.window.__wbsAutomationInputActive,true);assert.equal(events.at(-1).detail.open,false);
 await ctx.automationPanelSetInputActive(false);assert.equal(renderer.window.__wbsAutomationInputActive,false);
 assert.match(daemon,/await automationPanelSetInputActive\(automationInputActive\)/);
});
