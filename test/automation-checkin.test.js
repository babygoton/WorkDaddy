'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const os = require('node:os');
const automation = require('../scripts/automation');
const source = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');
const presetPath = path.join(__dirname, '../scripts/builtin/automations/daily-account-checkin.json');

test('multiple event triggers survive validation and match independently', () => {
  const task = automation.validateTask({id:'multi', trigger:{type:'manual',types:['clientLoaded','panelOpened']}, schedule:{type:'interval',minutes:60},steps:[]});
  assert.deepEqual(task.trigger.types,['clientLoaded','panelOpened']);
  for(const event of ['pageReady','panelOpened']) assert.equal(automation.taskMatchesEvent(task,event,{source:"connect"}),true);
  assert.equal(automation.taskMatchesEvent(task,'accountSwitched'),false);
  assert.equal(automation.taskMatchesEvent({...task,enabled:false},'panelOpened'),false);
  assert.throws(()=>automation.validateTask({...task,schedule:{type:'interval',minutes:0}}));
});

test('interval scheduler handles edits, disabled tasks and overlapping runs without catch-up storms', () => {
  const tick = automation.createScheduleTicker(); const calls=[];
  const task=automation.normalizeTask({id:'hourly',schedule:{type:'interval',minutes:60},steps:[]});
  const run=t=>calls.push(t.id);
  tick([task],run,()=>false,0);tick([task],run,()=>false,3599999);assert.equal(calls.length,0);
  tick([task],run,()=>false,3600000);assert.equal(calls.length,1);
  tick([task],run,()=>true,7200000);assert.equal(calls.length,1);
  tick([task],run,()=>false,7200001);assert.equal(calls.length,1);
  tick([{...task,enabled:false}],run,()=>false,10800000);
  tick([task],run,()=>false,10800001);assert.equal(calls.length,1);
  tick([task],run,()=>false,14400001);assert.equal(calls.length,2);
  tick([{...task,schedule:{type:'interval',minutes:5}}],run,()=>false,14400002);
  tick([{...task,schedule:{type:'interval',minutes:5}}],run,()=>false,14700002);assert.equal(calls.length,3);
});

test('built-in task is installed once and respects edits, disabling and deletion', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wd-checkin-'));
  try {
    automation.installBuiltinTask(dir,presetPath);
    const tasks=automation.readAutomations(dir);assert.equal(tasks.length,1);
    tasks[0].enabled=false;automation.writeAutomations(dir,tasks);
    automation.installBuiltinTask(dir,presetPath);assert.equal(automation.readAutomations(dir)[0].enabled,false);
    automation.writeAutomations(dir,[]);automation.installBuiltinTask(dir,presetPath);assert.equal(automation.readAutomations(dir).length,0);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('preset silently iterates accounts, continues after failures and leaves the panel open', async () => {
  const preset=JSON.parse(fs.readFileSync(presetPath));
  assert.equal(automation.taskNeedsPanelClosed(preset),false);
  assert.equal(automation.taskNeedsPanelClosed({...preset,onFailure:[{op:'session.sendCurrent',message:'test'}]}),true);
  const calls=[];
  await automation.executeTask(preset,{
    listAccounts:async()=>[{uid:'a'},{uid:'b'},{uid:'c'}],
    accountCheckin:async a=>{calls.push(a.uid);if(a.uid==='b')throw Error('offline');return {ok:true,skipped:true};},
    accountSwitch:()=>assert.fail('must not switch accounts'),
  });
  assert.deepEqual(calls,['a','b','c']);
});

function claimHarness({stored=null,cached=null}={}) {
  const start=source.indexOf('const checkinClaims = new Map()');
  const end=source.indexOf('/** 通过 CDP 把右下角组件',start);
  assert.ok(start>0 && end>start);
  let requests=0,refreshes=0;const records={};
  const ctx={Map,Promise,Date,PROFILE:{capabilities:{accounts:true,checkin:true}},todayStr:()=> '2026-09-08',
    CREDIT_USAGE_STORE:{getDailyCheckin:async()=>stored,saveDailyCheckin:async()=>{}},
    loadCheckinCache:()=>cached?{a:cached}:records,saveCheckinCache:()=>{},
    classifyCheckinResult:require('../scripts/checkin-result').classifyCheckinResult,
    refreshAccountBackupToken:async()=>{refreshes++;return {root:{auth:{accessToken:'test-token'}}};},
    dailyCheckin:async()=>{requests++;await Promise.resolve();return {ok:true,code:0,message:'ok'};},log:()=>{},
  };
  vm.createContext(ctx);vm.runInContext(source.slice(start,end),ctx);
  return {claim:ctx.claimDailyForUid,counts:()=>({requests,refreshes})};
}
test('confirmed daily check-in skips even token refresh; concurrent claims share one request',async()=>{
  for(const record of [{date:'2026-09-08',ok:true,verified:true},null]){
    const h=claimHarness({stored:record,cached:record?null:{date:'2026-09-08',ok:true,code:0,message:'ok'}});
    assert.equal((await h.claim('a')).skipped,true);assert.deepEqual(h.counts(),{requests:0,refreshes:0});
  }
  const h=claimHarness();await Promise.all([h.claim('a'),h.claim('a')]);assert.deepEqual(h.counts(),{requests:1,refreshes:1});
  await h.claim('a');assert.deepEqual(h.counts(),{requests:1,refreshes:1});
});

test('legacy implicit triggers and pending UI are removed; panel event is explicit',()=>{
  assert.doesNotMatch(source,/claimDailyForAll|CHECKIN_STARTUP_DELAY_MS|CHECKIN_INTERVAL_MS|checkinSnapshot/);
  const route=source.slice(source.indexOf("if (req.method === 'GET' && p === '/api/accounts')"),source.indexOf('// 查询指定账号的剩余积分'));
  assert.doesNotMatch(route,/claimDailyForUid|refreshAccountBackupToken/);
  const ui=fs.readFileSync(path.join(__dirname,'../scripts/inject.js'),'utf8');
  assert.doesNotMatch(ui,/签到中|watchCheckin|stopCheckinPolling/);
  assert.match(ui,/\/api\/automations\/events/);
  const html=ui.slice(ui.indexOf('function checkinHtml'),ui.indexOf('function el(tag'));
  const ctx={WBS_PROFILE_IS_AI:false};vm.createContext(ctx);vm.runInContext(html,ctx);
  assert.match(ctx.checkinHtml({}),/pending.*今日签到/);
  assert.match(ctx.checkinHtml({checkin:{ok:true}}),/tag ok.*今日签到/);
  assert.doesNotMatch(ctx.checkinHtml({checkin:{ok:false,message:'bad'}}),/bad/);
});

test('failed or stale cache records never suppress today\'s check-in request', async () => {
  for (const cached of [
    {date:'2026-09-08',ok:false,verified:false,code:0,message:'HTTP 500'},
    {date:'2026-09-07',ok:true,verified:true,code:0,message:'ok'},
    {date:'2026-09-08',ok:true,code:10001,message:'活动未开启'},
  ]) {
    const h=claimHarness({cached}); await h.claim('a');
    assert.deepEqual(h.counts(),{requests:1,refreshes:1});
  }
});

test('panel-open emits once per user opening and excludes automation restoration', () => {
  const ui=fs.readFileSync(path.join(__dirname,'../scripts/inject.js'),'utf8');
  const start=ui.indexOf('    function setOpen(open, options)');
  const end=ui.indexOf('    function setupFabDrag()',start);
  const calls=[];const noop=()=>{};
  const ctx={window:{},state:{open:false,creditRunId:0},panel:{classList:{toggle:noop}},fab:{classList:{toggle:noop}},
    api:(route,options)=>{calls.push([route,JSON.parse(options.body).type]);return Promise.resolve();},
    CAPS:{accounts:false},refresh:noop,checkForUpdate:noop,acCheckPromptOnOpen:noop,syncSessionModule:noop,fabQuietMode:{wake:noop}};
  vm.createContext(ctx);vm.runInContext(ui.slice(start,end),ctx);
  ctx.setOpen(true);ctx.setOpen(true);assert.equal(calls.length,1);
  ctx.setOpen(false);ctx.setOpen(true,{automation:true});assert.equal(calls.length,1);
  ctx.setOpen(false);ctx.setOpen(true);assert.deepEqual(calls,[['/api/automations/events','panelOpened'],['/api/automations/events','panelOpened']]);
});

test('automation editor assigns remaining height to the code field without an outer scroll area', () => {
  const ui=fs.readFileSync(path.join(__dirname,'../scripts/inject.js'),'utf8');
  const rules=ui.slice(ui.indexOf("'.wbs-modal.wbs-auto-editor-modal"),ui.indexOf("'.wbs-modal.wbs-auto-log-modal"));
  assert.match(rules,/\.wbs-auto-editor-body\{[^}]*display:flex[^}]*min-height:0[^}]*overflow:hidden/);
  assert.match(rules,/\.wbs-auto-steps-field\{[^}]*flex:1 1 0;min-height:0/);
  assert.match(rules,/textarea\[data-auto-field="steps"\]\{[^}]*height:0;min-height:0;resize:none;overflow:auto/);
  assert.doesNotMatch(rules,/height:calc\(100% - 164px\)|min-height:190px/);
});

test('fresh CN and AI profiles receive all three presets without reinstalling deleted tasks', () => {
  const init = source.slice(source.indexOf("for (const preset of ['close-buddy-popups.json'"), source.indexOf('\nrestoreSleepMode();'));
  const { PROFILES } = require('../scripts/profiles');
  for (const id of ['workbuddy-cn', 'workbuddy-ai']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-presets-'));
    try {
      const context = { PROFILE: PROFILES[id], DATA_DIR: dir, path, __dirname: path.join(__dirname, '../scripts'), installBuiltinTask: automation.installBuiltinTask, log() {} };
      vm.runInNewContext(init, context);
      assert.deepEqual(automation.readAutomations(dir).map(t => t.id).sort(), ['buddy-fuel-station-close-on-account-switch', 'daily-account-checkin', 'keep-accounts-active-1-plus-1']);
      automation.writeAutomations(dir, []);
      vm.runInNewContext(init, context);
      assert.equal(automation.readAutomations(dir).length, 0);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});
