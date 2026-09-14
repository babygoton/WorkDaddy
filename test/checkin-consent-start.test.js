'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const automation = require('../scripts/automation');
const consent = require('../scripts/checkin-consent');
const daemon = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');
function harness(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wd-checkin-start-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  automation.installBuiltinTask(dir,path.join(__dirname,'../scripts/builtin/automations/daily-account-checkin.json'));
  consent.initializeCheckinConsent(dir);
  const runs=new Map(),started=[];
  const ctx={...consent,DATA_DIR:dir,readAutomations:automation.readAutomations,automationRuns:runs,
    startAutomationRun: task=>{const run={id:'run-1',taskId:task.id,status:'running'};started.push(task);runs.set(run.id,run);return run;},
    automationPublicRun:run=>({id:run.id,status:run.status})};
  const start=daemon.indexOf('function applyCheckinConsent('),end=daemon.indexOf('function handleApi(',start);
  assert.ok(start>=0&&end>start);vm.createContext(ctx);vm.runInContext(daemon.slice(start,end),ctx);
  return {dir,runs,started,apply:ctx.applyCheckinConsent};
}
test('first opt-in starts the configured check-in immediately without another panel event',t=>{
 const h=harness(t);const result=h.apply(true);assert.equal(result.enabled,true);assert.equal(h.started.length,1);
 assert.equal(h.started[0].id,'daily-account-checkin');assert.equal(result.run.id,'run-1');
 h.apply(true);h.apply(false);assert.equal(h.started.length,1);
});
test('cancellation never starts check-in; an overlapping scheduled run is reused',t=>{
 const cancelled=harness(t);cancelled.apply(false);cancelled.apply(true);assert.equal(cancelled.started.length,0);
 const running=harness(t);running.runs.set('active',{id:'active',taskId:'daily-account-checkin',status:'running'});
 assert.equal(running.apply(true).run.id,'active');assert.equal(running.started.length,0);
});
test('check-in UI notifications include cached daily successes and task completion',async()=>{
 const a=daemon.indexOf('accountCheckin: async (account) => {'),b=daemon.indexOf('}, httpRequest:',a);
 const events=[];const ctx={claimDailyForUid:async()=>({ok:true,skipped:true}),appendRunLog:()=>{},cdp:{connected:true},cdpSend:async(...args)=>events.push(args)};
 vm.createContext(ctx);vm.runInContext('var checkin = async (account) => {'+daemon.slice(a+'accountCheckin: async (account) => {'.length,b)+'};',ctx);
 await ctx.checkin({uid:'sample'});assert.equal(events.length,1);
 const run=daemon.slice(daemon.indexOf('function startAutomationRun('),daemon.indexOf('function resumeAutomationAfterNavigation('));
 assert.match(run,/finally\(async \(\) => \{[\s\S]*daily-account-checkin[\s\S]*workdaddy:accounts-updated/);
});
