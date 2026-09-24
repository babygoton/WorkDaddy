'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const source = fs.readFileSync(require('node:path').join(__dirname, '../scripts/daemon.js'), 'utf8');
function harness(windows = false, linux = false) {
  const children = [], timers = new Set(), signals = [];
  const ctx = { IS_WIN: windows, IS_LINUX: linux, log() {},
    process: { kill(pid, signal) { signals.push({ pid, signal }); } },
    spawn(command, args, options) {
      const child = new EventEmitter();
      Object.assign(child, { pid: 1000 + children.length, options, spawnargs: [command, ...args], killed: false,
        kill() { this.killed = true; this.emit('exit'); },
      });
      children.push(child);
      return child;
    },
    setInterval(fn) { const timer = { fn, unref() {} }; timers.add(timer); return timer; },
    clearInterval(timer) { timers.delete(timer); },
  };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('let sleepCaffeinate ='), source.indexOf('function restoreSleepMode()')), ctx);
  const statusBlock = source.slice(source.indexOf("  if (req.method === 'GET' && p === '/api/sleep-mode')"), source.indexOf("  if (req.method === 'POST' && p === '/api/sleep-mode')"));
  Object.assign(ctx, {
    req: { method: 'GET' }, p: '/api/sleep-mode', res: {}, DATA_DIR: '',
    fs: { readFileSync: () => '{"mode":"keep"}' }, path: { join: () => '' },
    json: (_res, _status, body) => body,
  });
  const status = () => vm.runInContext('(function(){' + statusBlock + '})()', ctx);
  return { ctx, children, timers, signals, status };
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
  const h = harness(true);
  h.ctx.applySleepMode('keep', false);
  assert.equal(h.status().active, true);
});

test('Linux keep/until-done uses an inhibitor and allow releases its entire process group', () => {
  const h = harness(false, true);
  assert(h.ctx.applySleepMode('keep', false));
  const first = h.children[0];
  assert.equal(first.spawnargs[0], 'systemd-inhibit');
  assert(first.spawnargs.includes('--what=sleep:idle'));
  assert.equal(first.options.detached, true);
  assert.equal(h.children.length, 1, 'Linux must not start caffeinate for screen locking');
  assert.equal(h.timers.size, 0);
  assert.equal(h.status().active, true);
  assert.equal(h.status().antiLock, false);
  h.ctx.applySleepMode('until-done', true);
  const second = h.children[1];
  assert(second.spawnargs.includes('--what=sleep'));
  assert.deepEqual(h.signals, [{ pid: -first.pid, signal: 'SIGTERM' }]);
  first.emit('exit', 0);
  assert.equal(h.status().active, true, 'old exit must not clear the replacement inhibitor');
  h.ctx.applySleepMode('allow', true);
  assert.deepEqual(h.signals[1], { pid: -second.pid, signal: 'SIGTERM' });
  assert.equal(h.status().active, false);
});

test('Linux inhibitor startup failure and exit clear active state without macOS fallback', () => {
  const h = harness(false, true);
  h.ctx.applySleepMode('keep', false);
  h.children[0].emit('error', Object.assign(new Error('missing command'), { code: 'ENOENT' }));
  assert.equal(h.status().active, false);
  h.ctx.applySleepMode('keep', true);
  h.children[1].emit('exit', 1);
  assert.equal(h.status().active, false);
  assert(h.children.every(child => child.spawnargs[0] === 'systemd-inhibit'));
});

test('immediate sleep selects the native command on each platform', () => {
  for (const [win, linux, command] of [[false, true, 'systemctl'], [false, false, 'pmset'], [true, false, 'rundll32.exe']]) {
    const h = harness(win, linux);
    assert.equal(h.ctx.sleepNow(), true);
    assert.equal(h.children[0].spawnargs[0], command);
    if (linux) assert.deepEqual(h.children[0].spawnargs, ['systemctl', 'suspend']);
    h.children[0].emit('error', new Error('unavailable'));
  }
});

test('until-done waits for every discovered session, including blocked and recently hidden sessions', async () => {
  const ui = fs.readFileSync(require('node:path').join(__dirname, '../scripts/inject.js'), 'utf8');
  let now = 100000, poll, controllers = [
    {conversationId:'a', busy:true}, {conversationId:'b', blocked:true},
  ];
  const posts = [];
  const disposers = [];
  const ctx = {
    window: {}, registerDisposer: fn => disposers.push(fn),
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
  assert.equal(ctx.window.__wbsAnySessionBusy(), true);
  assert.equal(ctx.window.__wbsSessionsBusy(['a']), true);
  assert.equal(ctx.window.__wbsSessionsBusy(['unrelated']), false);
  ctx.startUntilDoneCheck();
  poll(); assert.equal(posts.length, 0);
  controllers[0].busy = false;
  poll(); assert.equal(posts.length, 0, 'blocked background session still needs awake system');
  controllers = [controllers[0]];
  now += 10000; poll(); assert.equal(posts.length, 0, 'brief virtualization gap is not completion');
  controllers.push({conversationId:'b', busy:false});
  poll(); await Promise.resolve();
  assert.deepEqual(posts, [{mode:'allow', displaySleep:false}]);
  assert.equal(ctx.window.__wbsAnySessionBusy(), false);
  ctx.alive = false;
  assert.equal(ctx.window.__wbsAnySessionBusy(), null);
  disposers.forEach(fn => fn());
  assert.equal(ctx.window.__wbsAnySessionBusy, undefined);
});
