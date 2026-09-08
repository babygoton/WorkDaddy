'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateTask, executeTask } = require('../scripts/automation');
const { normalizeToastOptions } = require('../scripts/toast-options');
const source = name => fs.readFileSync(path.join(__dirname, '../', name), 'utf8');
const task = steps => ({schemaVersion:1,id:'toast-test',name:'Toast test',steps});
test('toast validates levels, duration and id before execution', () => {
  assert.deepEqual(normalizeToastOptions({level:'loading',id:'progress',duration:5000}),{level:'loading',id:'progress',duration:5000});
  for(const step of [{op:'notify.toast',duration:-1},{op:'notify.toast',duration:60001},{op:'notify.toast',level:'bad'},{op:'notify.dismiss'},{op:'notify.dismiss',id:'<bad>'}]) assert.throws(()=>validateTask(task([step])));
});
test('automation waits for toast delivery and passes id, duration, level and dismissal', async () => {
  const calls=[];
  await executeTask(task([{op:'notify.toast',level:'loading',message:'处理 {{vars.item}}',id:'progress',duration:9000,saveAs:'notice'},{op:'notify.toast',level:'success',message:'完成',id:'{{vars.notice.id}}'},{op:'notify.dismiss',id:'{{vars.notice.id}}'}]),{
    notifyToast:async (level,message,options)=>{await new Promise(r=>setTimeout(r,5));calls.push({level,message,...options});return {ok:true,id:options.id};},
    dismissToast:async id=>{calls.push({dismiss:id});return {ok:true};},
  });
  assert.equal(calls[0].duration,9000);assert.equal(calls[1].id,'progress');assert.equal(calls[1].level,'success');assert.equal(calls[2].dismiss,'progress');
});
test('toast delivery errors fail automation instead of silently succeeding', async () => {
  await assert.rejects(executeTask(task([{op:'notify.toast',message:'hello'}]),{notifyToast:async()=>{throw Error('disconnected');}}),/disconnected/);
  await assert.rejects(executeTask(task([{op:'notify.toast',message:'hello'}]),{}),/通知/);
});
test('local official library, shadow styles and viewport host are included in injection and packaging', () => {
  assert.match(source('scripts/toast-runtime.js'),/react-hot-toast.*2\.6\.0/);
  assert.match(source('tools/toast-runtime/entry.jsx'),/position="bottom-center"/);
  assert.match(source('tools/toast-runtime/entry.jsx'),/attachShadow/);
  assert.match(source('tools/toast-runtime/goober-scoped.js'),/target: styleTarget/);
  assert.match(source('scripts/daemon.js'),/'toast-runtime.js'/);
  assert.match(source('scripts/build-mac-dmg.sh'),/toast-runtime.js/);
  assert.doesNotMatch(source('scripts/inject.js'),/var t = el\('div', 'wbs-toast'/);
  assert.match(source('scripts/inject.js'),/toastRuntime\.destroy\(\)/);
});
test('run notification ids are isolated and cleanup dismisses only unfinished loading toasts', async () => {
  const { createAutomationNotifier } = require('../scripts/toast-options');
  const calls=[];const send=async detail=>{calls.push(detail);return {ok:true};};
  const a=createAutomationNotifier(send,'run-a'),b=createAutomationNotifier(send,'run-b');
  await a.show('loading','work',{id:'progress'});
  await a.show('success','done',{id:'progress'});
  await b.show('loading','work',{id:'progress'});
  await a.cleanup();assert.equal(calls.length,3);
  await b.cleanup();assert.deepEqual(calls[3],{action:'dismiss',id:'run-b:progress'});
  await a.dismiss('progress');assert.equal(calls[4].id,'run-a:progress');
});
test('cleanup immediately dismisses a loading toast whose delivery finishes after cancellation', async () => {
  const { createAutomationNotifier } = require('../scripts/toast-options');
  let release;const pending=new Promise(resolve=>{release=resolve;});const calls=[];
  const notifier=createAutomationNotifier(async detail=>{calls.push(detail);if(detail.action!=='dismiss')await pending;},'cancelled');
  const showing=notifier.show('loading','waiting',{id:'pending'});
  await notifier.cleanup();release();await showing;
  assert.equal(calls[1].action,'dismiss');assert.equal(calls[1].id,'cancelled:pending');
  await assert.rejects(notifier.show('loading','late'),/结束/);
});
