'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {canManuallyRunTask,AGENT_EXAMPLES}=require('../scripts/automation');
const {fetchGrowthStreak,createGrowthStreakCache}=require('../scripts/growth-active');
const ui=fs.readFileSync(path.join(__dirname,'../scripts/inject.js'),'utf8');

test('only manual tasks expose a direct run action, including disabled automatic tasks',()=>{
  for(const task of [{},{trigger:{type:'manual'}},{trigger:{type:'pageReady',types:[]}}])assert.equal(canManuallyRunTask(task),true);
  for(const task of [{trigger:{type:'pageReady'}},{trigger:{type:'panelOpened'},enabled:false},{trigger:{types:['clientLoaded','panelOpened']}},{schedule:{type:'interval',minutes:60}}])assert.equal(canManuallyRunTask(task),false);
  assert.equal(AGENT_EXAMPLES.some(e=>e.id==='close-buddy-fuel'),false);
});

test('streak uses the official endpoint and exact continuous-day field, including zero',async()=>{
  for(const days of [0,5]){
    const r=await fetchGrowthStreak('sample-token',{fetchImpl:async(url,init)=>{
      assert.equal(url,'https://www.workbuddy.cn/activity/growth/streak');assert.equal(init.method,'GET');assert.equal(init.redirect,'error');
      assert.equal(init.headers.authorization,'Bearer sample-token');
      return {ok:true,status:200,text:async()=>JSON.stringify({code:0,data:{
        streak:{days,month_total_days:20,next_tier:'14d',next_tier_remaining:4},makeup_cards:{balance:1},
        redemption_status:{remaining_days:10,tier_7d_status:'claimed',tier_14d_status:'locked',tier_28d_status:'locked',tiers:[
          {tier:'7d',days:7,credit:0,energy:2,cards:1,chances:1},
          {tier:'14d',days:14,credit:50,energy:3,cards:1,chances:1},
          {tier:'28d',days:28,credit:150,energy:5,cards:1,chances:1},
        ]},today:{score:99}}})};
    }});
    assert.equal(r.days,days);
    assert.equal(r.progressDays,10);
    assert.equal(r.nextTier,'14d');
    assert.equal(r.nextTierRemaining,4);
    assert.equal(r.makeupCards,1);
    assert.deepEqual(r.tiers.map(t=>({key:t.key,days:t.days,status:t.status})),[
      {key:'7d',days:7,status:'claimed'},
      {key:'14d',days:14,status:'locked'},
      {key:'28d',days:28,status:'locked'},
    ]);
  }
});

test('unknown streak responses never become a confirmed zero',async()=>{
  for(const payload of [{code:0,data:{}},{code:0,data:{streak:{days:null}}},{code:0,data:{streak:{days:-1}}},{code:0,data:{streak:{days:'5'}}},{code:401,data:{streak:{days:5}}}]){
    await assert.rejects(fetchGrowthStreak('sample-token',{fetchImpl:async()=>({ok:true,status:200,text:async()=>JSON.stringify(payload)})}));
  }
});

test('streak cache isolates accounts, coalesces requests, expires at midnight and backs off failures',async()=>{
  let at=new Date(2026,8,8,23,59,0).getTime();let count=0;let fail=false;
  const cache=createGrowthStreakCache(async uid=>{count++;if(fail)throw Error('offline');return {days:uid==='a'?5:0,progressDays:2,tiers:[{key:'7d',days:7,status:'locked'}]};},{now:()=>at});
  const both=await Promise.all([cache.get('a'),cache.get('a')]);assert.equal(count,1);assert.equal(both[0].days,5);
  assert.equal(both[0].progressDays,2);assert.equal(both[0].tiers[0].days,7);
  assert.equal((await cache.get('b')).days,0);assert.equal(count,2);
  await cache.get('a');assert.equal(count,2);
  await cache.get('a',{force:true});assert.equal(count,3);
  at+=61000;assert.equal(cache.peek('a'),null);await cache.get('a');assert.equal(count,4);
  fail=true;at+=300001;const failed=await cache.get('a');assert.equal(failed.days,null);assert.equal(failed.status,'unavailable');
  await cache.get('a');assert.equal(count,5);at+=30001;await cache.get('a');assert.equal(count,6);
});

test('combined growth control labels consecutive login days and unavailable data',()=>{
  const start=ui.indexOf('  function activityStreakHtml(');const end=ui.indexOf('  function el(tag',start);assert.ok(start>0);
  const ctx={WBS_PROFILE_IS_AI:false};vm.createContext(ctx);vm.runInContext(ui.slice(start,end),ctx);
  assert.match(ctx.activityStreakHtml({activityStreak:{days:0,status:'ready'}}),/wbs-daily-streak-label[^>]*>连续登录 0 天/);
  assert.match(ctx.activityStreakHtml({activityStreak:{days:5,status:'ready'}}),/wbs-daily-streak-label[^>]*>连续登录 5 天/);
  assert.match(ctx.activityStreakHtml({}),/连续登录读取中/);
  assert.match(ctx.activityStreakHtml({activityStreak:{days:null,status:'unavailable'}}),/连续登录读取失败/);
  assert.doesNotMatch(ctx.activityStreakHtml({activityStreak:{days:'<img>',status:'ready'}}),/<img>/);
  ctx.WBS_PROFILE_IS_AI=true;assert.equal(ctx.activityStreakHtml({}), '');
});

test('task cards render triggers separately, show start only for manual tasks, and keep stop for active runs',()=>{
  const start=ui.indexOf('      function triggerBadgesHtml('),end=ui.indexOf('      function load()',start);
  const rows=[];const list={innerHTML:'',scrollTop:37,appendChild:r=>rows.push(r.innerHTML)};
  const ctx={automationState:{tasks:[
    {id:'manual',name:'Manual',enabled:true,manualRunnable:true,trigger:{type:'manual'}},
    {id:'imported-checkin',name:'循环账号静默签到',enabled:true,manualRunnable:false,trigger:{types:['clientLoaded','panelOpened']}},
    {id:'event',name:'<img onerror=x>',description:'<script>bad</script>',enabled:true,manualRunnable:false,trigger:{types:['clientLoaded','panelOpened']},schedule:{type:'interval',minutes:60}},
    {id:'active',name:'Active',enabled:true,manualRunnable:false,trigger:{type:'pageReady'}},
  ],runs:[{id:'run-active',taskId:'active',status:'running'}],selected:{},stopping:{}},
  automationPane:{querySelector:s=>s==='#wbs-auto-list'?list:null},
  document:{createElement:()=>({setAttribute(){}})},
  esc:s=>String(s).replaceAll('<','&lt;').replaceAll('>','&gt;'),escAttr:s=>String(s).replaceAll('<','&lt;').replaceAll('"','&quot;'),
  applyI18n(){},AUTO_STOPPING_SVG:'',AUTO_STOP_SVG:'',MODEL_ENABLE_SVG:'',AUTO_LOG_SVG:'',MODEL_EDIT_SVG:'',MODEL_COPY_SVG:'',TRASH_SVG:''};
  ctx.WBS_I18N_EN = {};
  vm.createContext(ctx);
  vm.runInContext(ui.slice(ui.indexOf('  function wbsIsBuiltinAutomation('), ui.indexOf('  // ===== 全局错误钩子')), ctx);
  vm.runInContext(ui.slice(start,end),ctx);ctx.render();
  assert.match(rows[0],/data-auto-run="manual"/);
  assert.doesNotMatch(rows[0],/wbs-auto-builtin-badge/);
  assert.doesNotMatch(rows[1],/wbs-auto-builtin-badge/);
  assert.match(rows[1],/data-auto-edit="imported-checkin"/);
  assert.doesNotMatch(rows[2],/data-auto-run|data-auto-stop|<img|<script>|wbs-auto-builtin-badge/);
  for(const label of ['客户端加载','打开面板','每 60 分钟','等待触发'])assert.ok(rows[2].includes(label));
  assert.match(rows[3],/data-auto-stop="run-active"/);assert.match(rows[3],/执行中/);
  assert.equal(list.scrollTop,37);
});

test('only the two bundled automation ids render a built-in badge and omit the editor save action',()=>{
  const helperStart=ui.indexOf('  function wbsIsBuiltinAutomation(');
  const helperEnd=ui.indexOf('  function wbsBuiltinAutomationText(',helperStart);
  assert.ok(helperStart>0&&helperEnd>helperStart);
  const ctx={};vm.createContext(ctx);vm.runInContext(ui.slice(helperStart,helperEnd),ctx);
  for(const id of ['buddy-fuel-station-close-on-account-switch','keep-accounts-active-1-plus-1']){
    assert.equal(ctx.wbsIsBuiltinAutomation({id}),true);
  }
  assert.equal(ctx.wbsIsBuiltinAutomation({id:'daily-account-checkin'}),false);
  assert.equal(ctx.wbsIsBuiltinAutomation({id:'user-created'}),false);
  assert.equal(ctx.wbsIsBuiltinAutomation({id:'user-created',name:'循环账号静默签到'}),false);

  const paneStart=ui.indexOf('    function buildAutomationPane()');
  const paneEnd=ui.indexOf('    // ===== 会话 pane',paneStart);
  const pane=ui.slice(paneStart,paneEnd);
  assert.match(pane,/wbs-auto-builtin-badge[^<]*>内置<\/span>/);
  assert.match(pane,/check \+ builtinBadge \+ '<div class="wbs-auto-name"/);
  assert.match(pane,/wbsIsBuiltinAutomation\(task\) \? '' : '<button class="wbs-modal-btn wbs-modal-ok" type="button" id="wbs-auto-save">保存<\/button>'/);
  assert.match(pane,/if \(saveButton\) saveButton\.addEventListener\('click', saveEditor\)/);
  assert.match(ui,/'内置': 'Built-in'/);
  assert.match(ui,/\.wbs-auto-builtin-badge\{[^}]*border-radius:999px[^}]*var\(--wb-/);
});

test('scrollable automation list never shrinks cards and clips their descriptions or footers',()=>{
  assert.match(ui,/\.wbs-auto-row\{[^}]*flex:0 0 auto/);
});
