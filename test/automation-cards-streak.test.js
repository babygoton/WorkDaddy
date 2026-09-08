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
      return {ok:true,status:200,text:async()=>JSON.stringify({code:0,data:{streak:{days,month_total_days:20},today:{score:99}}})};
    }});
    assert.deepEqual(r,{days});
  }
});

test('unknown streak responses never become a confirmed zero',async()=>{
  for(const payload of [{code:0,data:{}},{code:0,data:{streak:{days:null}}},{code:0,data:{streak:{days:-1}}},{code:0,data:{streak:{days:'5'}}},{code:401,data:{streak:{days:5}}}]){
    await assert.rejects(fetchGrowthStreak('sample-token',{fetchImpl:async()=>({ok:true,status:200,text:async()=>JSON.stringify(payload)})}));
  }
});

test('streak cache isolates accounts, coalesces requests, expires at midnight and backs off failures',async()=>{
  let at=new Date(2026,8,8,23,59,0).getTime();let count=0;let fail=false;
  const cache=createGrowthStreakCache(async uid=>{count++;if(fail)throw Error('offline');return {days:uid==='a'?5:0};},{now:()=>at});
  const both=await Promise.all([cache.get('a'),cache.get('a')]);assert.equal(count,1);assert.equal(both[0].days,5);
  assert.equal((await cache.get('b')).days,0);assert.equal(count,2);
  await cache.get('a');assert.equal(count,2);
  at+=61000;assert.equal(cache.peek('a'),null);await cache.get('a');assert.equal(count,3);
  fail=true;at+=300001;const failed=await cache.get('a');assert.equal(failed.days,null);assert.equal(failed.status,'unavailable');
  await cache.get('a');assert.equal(count,4);at+=30001;await cache.get('a');assert.equal(count,5);
});

test('activity badge distinguishes zero, positive, and unavailable data and escapes invalid values',()=>{
  const start=ui.indexOf('  function activityStreakHtml(');const end=ui.indexOf('  function el(tag',start);assert.ok(start>0);
  const ctx={WBS_PROFILE_IS_AI:false};vm.createContext(ctx);vm.runInContext(ui.slice(start,end),ctx);
  assert.match(ctx.activityStreakHtml({activityStreak:{days:0,status:'ready'}}),/pending[^>]*>活跃 0 天/);
  assert.match(ctx.activityStreakHtml({activityStreak:{days:5,status:'ready'}}),/ ok[^>]*>活跃 5 天/);
  assert.equal(ctx.activityStreakHtml({}), '');
  assert.match(ctx.activityStreakHtml({activityStreak:{days:null,status:'unavailable'}}),/活跃读取失败/);
  assert.doesNotMatch(ctx.activityStreakHtml({activityStreak:{days:'<img>',status:'ready'}}),/<img>/);
  ctx.WBS_PROFILE_IS_AI=true;assert.equal(ctx.activityStreakHtml({}), '');
});

test('task cards render triggers separately, show start only for manual tasks, and keep stop for active runs',()=>{
  const start=ui.indexOf('      function triggerBadgesHtml('),end=ui.indexOf('      function load()',start);
  const rows=[];const list={innerHTML:'',scrollTop:37,appendChild:r=>rows.push(r.innerHTML)};
  const ctx={automationState:{tasks:[
    {id:'manual',name:'Manual',enabled:true,manualRunnable:true,trigger:{type:'manual'}},
    {id:'event',name:'<img onerror=x>',description:'<script>bad</script>',enabled:true,manualRunnable:false,trigger:{types:['clientLoaded','panelOpened']},schedule:{type:'interval',minutes:60}},
    {id:'active',name:'Active',enabled:true,manualRunnable:false,trigger:{type:'pageReady'}},
  ],runs:[{id:'run-active',taskId:'active',status:'running'}],selected:{},stopping:{}},
  automationPane:{querySelector:s=>s==='#wbs-auto-list'?list:null},
  document:{createElement:()=>({setAttribute(){}})},
  esc:s=>String(s).replaceAll('<','&lt;').replaceAll('>','&gt;'),escAttr:s=>String(s).replaceAll('<','&lt;').replaceAll('"','&quot;'),
  applyI18n(){},AUTO_STOPPING_SVG:'',AUTO_STOP_SVG:'',MODEL_ENABLE_SVG:'',AUTO_LOG_SVG:'',MODEL_EDIT_SVG:'',MODEL_COPY_SVG:'',TRASH_SVG:''};
  ctx.WBS_I18N_EN = {};
  vm.createContext(ctx);
  vm.runInContext(ui.slice(ui.indexOf('  function wbsBuiltinAutomationText('), ui.indexOf('  // ===== 全局错误钩子')), ctx);
  vm.runInContext(ui.slice(start,end),ctx);ctx.render();
  assert.match(rows[0],/data-auto-run="manual"/);
  assert.doesNotMatch(rows[1],/data-auto-run|data-auto-stop|<img|<script>/);
  for(const label of ['客户端加载','打开面板','每 60 分钟','等待触发'])assert.ok(rows[1].includes(label));
  assert.match(rows[2],/data-auto-stop="run-active"/);assert.match(rows[2],/执行中/);
  assert.equal(list.scrollTop,37);
});

test('scrollable automation list never shrinks cards and clips their descriptions or footers',()=>{
  assert.match(ui,/\.wbs-auto-row\{[^}]*flex:0 0 auto/);
});
