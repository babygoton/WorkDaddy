'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(require('node:path').join(__dirname, '../scripts/inject.js'), 'utf8');

function harness(enabled = true) {
  const start = source.indexOf('function createFabQuietMode(');
  assert.notEqual(start, -1);
  const end = source.indexOf('// Keep the decision logic', start);
  const timers = new Map(), listeners = [], classes = new Set();
  let timerId = 0, dragging = false;
  const win = { innerWidth: 1000, innerHeight: 700 };
  const doc = { activeElement: null };
  const button = {};
  const saved = new Map(enabled ? [['dock-test', '1']] : []);
  const storage = { getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value) };
  const fab = {
    offsetWidth: 108, offsetHeight: 56,
    style: { right: '22px', bottom: '22px', setProperty(k, v) { this[k] = v; } },
    classList: { contains: k => classes.has(k), add: k => classes.add(k), remove: k => classes.delete(k) },
    contains: el => el === button,
  };
  const context = {
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  const mode = context.createFabQuietMode({ fab, window: win, document: doc,
    storage, settingKey: 'dock-test',
    isDragging: () => dragging,
    listen: (target, type, fn) => listeners.push({ target, type, fn }),
  });
  return { mode, fab, doc, button, classes, timers, win, saved,
    drag(value) { dragging = value; },
    fire(target, type, event = {}) { listeners.filter(l => l.target === target && l.type === type).forEach(l => l.fn(event)); },
    tick() { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); },
  };
}

test('idle robot tucks to the edge and approaching pointer restores it without a click', () => {
  const h = harness();
  h.tick();
  assert(h.classes.has('is-quiet'));
  assert.equal(h.fab.style['--wbs-fab-quiet-shift'], '59px');
  h.fire(h.win, 'pointermove', { clientX: 940, clientY: 658 });
  assert(h.classes.has('is-quiet'), 'the old robot position must not wake the docked robot');
  h.fire(h.win, 'pointermove', { clientX: 990, clientY: 658 });
  assert(!h.classes.has('is-quiet'));
  h.tick();
  assert(!h.classes.has('is-quiet'), 'stationary pointer nearby keeps robot awake');
  h.fire(h.win, 'pointermove', { clientX: 200, clientY: 200 });
  h.tick();
  assert(h.classes.has('is-quiet'));
});

test('auto docking defaults off and a changed preference persists and cancels pending docking', () => {
  const h = harness(false);
  h.tick();
  assert(!h.classes.has('is-quiet'));
  assert.equal(h.timers.size, 0);
  h.mode.setEnabled(true);
  assert.equal(h.saved.get('dock-test'), '1');
  h.tick();
  assert(h.classes.has('is-quiet'));
  h.mode.setEnabled(false);
  assert.equal(h.saved.get('dock-test'), '0');
  assert(!h.classes.has('is-quiet'));
  assert.equal(h.timers.size, 0);
});

test('closing a panel opened from the robot starts a fresh idle period', () => {
  const h = harness();
  h.fire(h.fab, 'pointerenter', {pointerType:'mouse'});
  h.classes.add('hidden'); h.mode.wake();
  h.classes.delete('hidden'); h.mode.wake();
  h.tick();
  assert(h.classes.has('is-quiet'));
});

test('panel, dragging and keyboard focus prevent tucking; close rearms idle timer', () => {
  for (const reason of ['hidden', 'drag', 'focus']) {
    const h = harness();
    if (reason === 'hidden') h.classes.add('hidden');
    if (reason === 'drag') h.drag(true);
    if (reason === 'focus') h.doc.activeElement = h.button;
    h.tick();
    assert(!h.classes.has('is-quiet'), reason);
    h.classes.delete('hidden'); h.drag(false); h.doc.activeElement = null;
    h.mode.wake(); h.tick();
    assert(h.classes.has('is-quiet'), reason + ' ends');
  }
});

test('resize uses the new viewport and saved vertical position; disposal cancels timer', () => {
  const h = harness();
  h.tick();
  h.win.innerWidth = 600; h.fab.style.bottom = '200px';
  h.fire(h.win, 'resize');
  h.fire(h.win, 'pointermove', { clientX: 590, clientY: 480 });
  assert(!h.classes.has('is-quiet'));
  h.fire(h.win, 'pointerout', { relatedTarget: null });
  assert.equal(h.timers.size, 1);
  h.mode.destroy();
  assert.equal(h.timers.size, 0);
  h.tick();
  assert(!h.classes.has('is-quiet'));
});
