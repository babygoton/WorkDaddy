'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const source = fs.readFileSync(require('node:path').join(__dirname, '../scripts/daemon.js'), 'utf8');
function harness(windows = false) {
  const children = [], timers = new Set();
  const ctx = { IS_WIN: windows, log() {},
    spawn(command, args) {
      const child = new EventEmitter();
      Object.assign(child, { spawnargs: [command, ...args], killed: false,
        kill() { this.killed = true; this.emit('exit'); },
      });
      children.push(child);
      return child;
    },
    setInterval(fn) { const timer = { fn, unref() {} }; timers.add(timer); return timer; },
    clearInterval(timer) { timers.delete(timer); },
  };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('let sleepCaffeinate ='), source.indexOf('function sleepNow()')), ctx);
  return { ctx, children, timers };
}
test('Windows allow releases the exact keep-awake process', () => {
  const h = harness(true);
  assert(h.ctx.applySleepMode('keep', false));
  assert.equal(h.children.length, 1);
  h.ctx.applySleepMode('allow', false);
  assert(h.children[0].killed, 'switching to allow must release the Windows power request');
});
test('macOS unchanged mode reuses assertions; display sleep removes display and user-active assertions', () => {
  const h = harness();
  h.ctx.applySleepMode('keep', false);
  const first = h.children[0];
  assert.deepEqual(first.spawnargs, ['caffeinate', '-d', '-i', '-s', '-m']);
  assert.equal(h.timers.size, 1);
  h.ctx.applySleepMode('keep', false);
  assert.equal(h.children[0].killed, false, 'same settings should keep existing assertion');
  assert.equal(h.children.length, 2);
  h.ctx.applySleepMode('keep', true);
  assert(first.killed);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.children.at(-1).spawnargs, ['caffeinate', '-i', '-s', '-m']);
  h.ctx.applySleepMode('allow', false);
  assert(h.children.every(c => c.killed));
});

test('sleep status reports the Windows power process as active', () => {
  const block = source.slice(source.indexOf("  if (req.method === 'GET' && p === '/api/sleep-mode')"), source.indexOf("  if (req.method === 'POST' && p === '/api/sleep-mode')"));
  const readStatus = new Function('req', 'p', 'fs', 'path', 'DATA_DIR', 'res', 'json', 'IS_WIN', 'sleepPowershell', 'sleepCaffeinate', 'sleepUserActivityTimer', block);
  const result = readStatus({method:'GET'}, '/api/sleep-mode', {readFileSync:()=>'{"mode":"keep"}'}, {join:()=>''}, '', {}, (res, code, body)=>body, true, {}, null, null);
  assert.equal(result.active, true);
});

test('until-done waits for every discovered session, including blocked and recently hidden sessions', async () => {
  const ui = fs.readFileSync(require('node:path').join(__dirname, '../scripts/inject.js'), 'utf8');
  let now = 100000, poll, controllers = [
    {conversationId:'a', busy:true}, {conversationId:'b', blocked:true},
  ];
  const posts = [];
  const ctx = {
    Date: {now:()=>now}, document:{}, alive:true, sleepMode:'until-done',
    acMulti:{sessions:{}}, sleepSessionCache:Object.create(null), sleepUntilDoneCheck:null,
    WBS_COMPAT:{findConversationControllers:()=>controllers},
    acControllerSnapshot:c=>c, isSessionBusy:()=>({busy:false}),
    setBuildInterval:fn=>{poll=fn;return 1;}, clearInterval(){},
    api:(route, options)=>{posts.push(JSON.parse(options.body));return Promise.resolve();},
    toast(){}, syncSleepState(){}, root:{},
  };
  vm.createContext(ctx);
  vm.runInContext(ui.slice(ui.indexOf('    function discoverSleepSessionBusy()'), ui.indexOf('    // 同步防休眠状态：三模式')), ctx);
  ctx.startUntilDoneCheck();
  poll(); assert.equal(posts.length, 0);
  controllers[0].busy = false;
  poll(); assert.equal(posts.length, 0, 'blocked background session still needs awake system');
  controllers = [controllers[0]];
  now += 10000; poll(); assert.equal(posts.length, 0, 'brief virtualization gap is not completion');
  controllers.push({conversationId:'b', busy:false});
  poll(); await Promise.resolve();
  assert.deepEqual(posts, [{mode:'allow', displaySleep:false}]);
});
