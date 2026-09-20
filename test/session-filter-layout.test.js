'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { isTargetForProfile } = require('../scripts/cdp-targets');

// Opt-in browser regression: runs production session UI/CSS in an isolated
// iframe with synthetic accounts and sessions. No application API is invoked.
test('All filters keep their height when the session list grows', { skip: !process.env.WORKDADDY_CDP_TEST_PORT, timeout: 30000 }, async () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/inject.js'), 'utf8');
  const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  const styles = { css: {} };
  vm.runInNewContext(section('  css.textContent = [', "  ].join('');") + "  ].join('');", styles);
  const functions = section('    var sessionsState =', '    // ===== 模型 pane') + section('    function sessionCopySizeText(', '    function showSessionCopyDetails(');
  const escape = source.split('\n').filter(line => /^  function esc(?:Attr)?\(/.test(line)).join('\n');
  const fixtures = Array.from({ length: 150 }, (_, i) => ({ id: 'fixture-' + i, user_id: 'fixture', title: 'Test session', cwd: '/fixture/project-' + Math.floor(i / 2), totalBytes: i ? 1024 : 200 * 1024 ** 2 }));
  const setup = `var sessionsPane=document.querySelector('.wbs-pane'),root=document.body,IMPORT_ICON='',EXPORT_ICON='',TRASH_SVG='';
    var setBuildTimeout=()=>0,registerDisposer=()=>{},toast=()=>{};
    var fixtures=${JSON.stringify(fixtures)};
    var api=async route=>route==='/api/accounts'?{accounts:[{uid:'fixture',nickname:'Test'}],current:{uid:'fixture'}}:
      route.startsWith('/api/sessions?')?{sessions:route.includes('range=today')?fixtures.slice(0,1):fixtures,totalBytes:1}:{};`;
  const targets = await (await fetch('http://127.0.0.1:' + process.env.WORKDADDY_CDP_TEST_PORT + '/json/list')).json();
  const target = targets.find(target => isTargetForProfile(target, { id: 'workbuddy-cn', kind: 'workbuddy' }));
  assert.ok(target, 'a verified WorkBuddy renderer is required');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const result = JSON.parse(event.data), waiter = pending.get(result.id);
    if (waiter) { pending.delete(result.id); clearTimeout(waiter.timer); result.error ? waiter.reject(Error(result.error.message)) : waiter.resolve(result.result); }
  };
  const evaluate = async expression => {
    const result = await new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(Error('UI evaluation timed out')); }, 8000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  try {
    await evaluate(`(async()=>{
      const frame=document.createElement('iframe');frame.id='workdaddy-filter-layout-test';
      frame.style.cssText='position:fixed;left:0;top:0;width:720px;height:630px;border:0;z-index:2147483647';document.body.appendChild(frame);
      const d=frame.contentDocument;d.open();d.write('<!doctype html><html><head></head><body style="margin:0"><div class="wbs-panel" style="display:flex;position:relative;width:100%;height:600px;max-height:600px;right:auto;bottom:auto"><div class="wbs-body"><div class="wbs-pane active" data-pane="sessions"></div></div></div></body></html>');d.close();
      const style=d.createElement('style');style.textContent=${JSON.stringify(styles.css.textContent)};d.head.appendChild(style);
      frame.contentWindow.eval(${JSON.stringify(setup + escape + functions + '\nbuildSessionsPane();')});
      await Promise.resolve();await Promise.resolve();return true;
    })()`);
    for (const width of [720, 360]) for (const height of [600, 350]) for (const theme of ['light', 'class', 'attribute', 'body']) {
      const result = await evaluate(`(async()=>{
        const frame=document.getElementById('workdaddy-filter-layout-test'),w=frame.contentWindow,d=frame.contentDocument;
        frame.style.width='${width}px';d.querySelector('.wbs-panel').style.height='${height}px';
        d.documentElement.className='${theme === 'class' ? 'cb-dark' : ''}';d.documentElement.dataset.theme='${theme === 'attribute' ? 'dark' : 'light'}';d.body.dataset.vscodeThemeName='${theme === 'body' ? 'dark' : ''}';
        const header=d.querySelector('.wbs-sess-filters'),list=d.querySelector('.wbs-sess-list');
        const measure=()=>({height:header.getBoundingClientRect().height,rows:d.querySelectorAll('.wbs-sess-row').length});
        d.querySelector('[data-min-bytes="104857600"]').click();const small=measure();
        d.querySelector('[data-min-bytes="0"]').click();const all=measure();
        d.querySelector('[data-range="today"]').click();await Promise.resolve();await Promise.resolve();const today=measure();
        d.querySelector('[data-range="all"]').click();await Promise.resolve();await Promise.resolve();const allTime=measure();
        const bounds=header.getBoundingClientRect();
        const unclipped=[...header.querySelectorAll('button,select')].every(el=>{const r=el.getBoundingClientRect();return r.top>=bounds.top-1&&r.bottom<=bounds.bottom+1;});
        list.scrollTop=100;return {small,all,today,allTime,unclipped,scrollable:list.scrollTop>0};
      })()`);
      const label = `${width}px / ${height}px / ${theme}: ${JSON.stringify(result)}`;
      assert.equal(result.small.rows, 1, label);
      assert.equal(result.all.rows, 150, label);
      assert.equal(result.today.rows, 1, label);
      assert.equal(result.allTime.rows, 150, label);
      assert.ok(Math.abs(result.small.height - result.all.height) < 1, label);
      assert.ok(Math.abs(result.today.height - result.allTime.height) < 1, label);
      assert.ok(result.unclipped && result.scrollable, label);
    }
  } finally {
    await evaluate("document.getElementById('workdaddy-filter-layout-test')?.remove()");
    socket.close();
  }
});
