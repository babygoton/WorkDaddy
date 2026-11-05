'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../scripts/inject.js'), 'utf8');
const renderStart = source.indexOf('    function renderQpList() {');
const helperStart = source.indexOf('    function createQuickPhraseSorter(');
const end = source.indexOf('    /** 发送按钮面板选项', renderStart);
const settle = () => new Promise(resolve => setImmediate(resolve));

function harness({ batch = false, reducedMotion = false, save } = {}) {
  let rows = [], html = '', nextFrame = 0;
  const calls = [], applied = [], errors = [], animations = [], frames = new Map();
  function element(attrs = {}, parent = null) {
    const listeners = new Map(), classes = new Set();
    return { attrs, parent, listeners,
      getAttribute: name => attrs[name] ?? null,
      setAttribute(name, value) { attrs[name] = value; },
      removeAttribute(name) { delete attrs[name]; },
      classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) },
      addEventListener(name, handler) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(handler); },
      removeEventListener(name, handler) { listeners.get(name)?.delete(handler); },
      closest(selector) {
        if (selector === '.wbs-qp-row' && attrs.class === 'wbs-qp-row') return this;
        if (selector === '[data-qp-drag]' && attrs['data-qp-drag']) return this;
        return parent?.closest(selector) || null;
      },
      contains(node) { for (; node; node = node.parent) if (node === this) return true; return false; },
      getBoundingClientRect() { return { top: 100 + (this.offsetTop || 0) - list.scrollTop, left: 0, height: 40, width: 300, bottom: 140 + (this.offsetTop || 0) - list.scrollTop }; },
      animate(keyframes, options) {
        const animation = { node: this, keyframes, options, cancelled: false, cancel() { this.cancelled = true; } };
        animations.push(animation); return animation;
      },
    };
  }
  const attrsOf = markup => Object.fromEntries([...markup.matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
  const list = Object.assign(element(), {
    scrollTop: 0, clientTop: 0, clientHeight: 120,
    querySelectorAll: selector => selector === '.wbs-qp-row' ? [...rows] : [],
    insertBefore(row, ref) { rows.splice(rows.indexOf(row), 1); const index = ref ? rows.indexOf(ref) : rows.length; rows.splice(index, 0, row); return row; },
    appendChild(row) { return this.insertBefore(row, null); },
    getBoundingClientRect: () => ({ top: 100, bottom: 220, left: 0, right: 300, height: 120, width: 300 }),
  });
  Object.defineProperties(list, {
    scrollHeight: { get: () => rows.length * 40 },
    innerHTML: { get: () => html, set(value) {
      html = value;
      rows = [...value.matchAll(/<div (class="wbs-qp-row"[^>]*)>([\s\S]*?)<\/div>/g)].map(m => {
        const row = element(attrsOf(m[1]), list);
        const handleMarkup = m[2].match(/<button ([^>]*data-qp-drag[^>]*)>/);
        row.handle = handleMarkup ? element(attrsOf(handleMarkup[1]), row) : null;
        row.edit = element({ class: 'wbs-qp-icon-btn' }, row);
        row.querySelector = selector => selector === '[data-qp-drag]' ? row.handle : null;
        Object.defineProperties(row, {
          offsetTop: { get: () => rows.indexOf(row) * 40 }, offsetHeight: { get: () => 40 },
          nextElementSibling: { get: () => rows[rows.indexOf(row) + 1] || null },
        });
        return row;
      });
    } },
  });
  const document = element(), window = Object.assign(element(), { matchMedia: () => ({ matches: reducedMotion }) });
  const context = {
    enhancePane: { querySelector: selector => selector === '#wbs-qp-list' ? list : null },
    sessState: { qpBatch: batch, qpSel: {}, phrases: ['a', 'b', 'c'].map(id => ({ id, text: id })) },
    sessLastQpSig: '', qpSortCleanup: null, escAttr: String, esc: String, MODEL_EDIT_SVG: '', TRASH_SVG: '',
    api: async (route, options) => { calls.push({ route, body: JSON.parse(options.body) }); return save ? save() : { ok: true }; },
    applySessionModule: data => applied.push(data), toast: message => errors.push(message), syncSessionModule() {}, root: {},
    document, window, requestAnimationFrame(fn) { const id = ++nextFrame; frames.set(id, fn); return id; }, cancelAnimationFrame: id => frames.delete(id),
  };
  vm.runInNewContext((helperStart < 0 ? '' : source.slice(helperStart, source.lastIndexOf('    /** 增强页快捷短语列表', renderStart))) + source.slice(renderStart, end), context);
  context.renderQpList();
  const data = new Map();
  const dataTransfer = { setData: (key, value) => data.set(key, value), getData: key => data.get(key) || '', setDragImage() {} };
  function event(target, clientY = 120) {
    return { target, dataTransfer, clientY, clientX: 12, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
  }
  function emit(target, name, ev = event(target)) {
    for (let node = target; node; node = node.parent) {
      for (const handler of node.listeners.get(name) || []) handler.call(node, ev);
      if (ev.stopped) break;
    }
    return ev;
  }
  function dragFrom(hitTarget) {
    let target = hitTarget;
    while (target && target.attrs.draggable !== 'true') target = target.parent;
    return target ? emit(target, 'dragstart') : null;
  }
  function over(index, after = true) {
    const row = rows[index];
    const y = row.getBoundingClientRect().top + (after ? 32 : 8);
    emit(row, 'dragover', event(row, y)); return y;
  }
  async function drop(index, after = true) {
    const y = over(index, after);
    // Moving the DOM row can change the browser's drop target. Use the current
    // row at the pointer, as Chromium does, not the pre-preview row reference.
    const hit = rows[Math.min(rows.length - 1, Math.floor((y - 100 + list.scrollTop) / 40))];
    emit(hit, 'drop', event(hit, y)); await settle();
  }
  return { get rows() { return rows; }, calls, applied, errors, animations, frames, list, document, window, context,
    order: () => rows.map(row => row.attrs['data-id']), dragFrom, over, drop, emit, event,
    destroy: () => context.qpSortCleanup?.(),
  };
}

test('handle drag previews and animates the new order before drop, without saving', () => {
  const h = harness();
  assert.equal(h.dragFrom(h.rows[0].handle)?.defaultPrevented, false);
  h.over(1);
  assert.deepEqual(h.order(), ['b', 'a', 'c']);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(Array.from(h.context.sessState.phrases, p => p.id), ['a', 'b', 'c']);
  assert.ok(h.animations.some(a => a.node.attrs['data-id'] === 'b' && a.options.duration > 0));
  h.over(1); h.over(1);
  assert.deepEqual(h.order(), ['b', 'a', 'c'], 'repeated dragover at the placeholder must not jitter');
});

test('a real handle drag persists the preview once, even if drop targets the moving row', async () => {
  const h = harness(); h.dragFrom(h.rows[0].handle); await h.drop(1);
  assert.deepEqual(h.calls, [{ route: '/api/quick-phrase-reorder', body: { ids: ['b', 'a', 'c'] } }]);
  assert.equal(h.applied.length, 1);
  h.emit(h.rows[1].handle, 'dragend');
  assert.deepEqual(h.order(), ['b', 'a', 'c'], 'dragend after drop must not undo saved order');
});

test('upward preview and drop keep every phrase once', async () => {
  const h = harness(); h.dragFrom(h.rows[2].handle); await h.drop(0, false);
  assert.deepEqual(h.order(), ['c', 'a', 'b']);
  assert.deepEqual(h.calls[0].body.ids, ['c', 'a', 'b']);
});

test('cancel or drop outside restores the original order without saving', () => {
  for (const cancel of ['dragend', 'Escape']) {
    const h = harness(), handle = h.rows[0].handle; h.dragFrom(handle); h.over(1);
    if (cancel === 'dragend') h.emit(handle, 'dragend');
    else h.emit(h.document, 'keydown', { ...h.event(h.document), key: 'Escape' });
    assert.deepEqual(h.order(), ['a', 'b', 'c']); assert.equal(h.calls.length, 0);
    assert.ok(h.rows.every(row => !row.classList.contains('wbs-qp-dragging')));
  }
});

test('failed save rolls the preview back and reports the failure', async () => {
  const h = harness({ save: () => ({ ok: false, error: 'test rejection' }) });
  h.dragFrom(h.rows[0].handle); await h.drop(1);
  assert.deepEqual(h.order(), ['a', 'b', 'c']); assert.equal(h.errors.length, 1); assert.equal(h.applied.length, 0);
  assert.equal(h.list.getAttribute('aria-busy'), null);
});

test('a pending save prevents a second drag', async () => {
  let resolve; const h = harness({ save: () => new Promise(r => { resolve = r; }) });
  h.dragFrom(h.rows[0].handle); await h.drop(1);
  assert.equal(h.dragFrom(h.rows[0].handle).defaultPrevented, true);
  resolve({ ok: true }); await settle();
  assert.equal(h.dragFrom(h.rows[0].handle).defaultPrevented, false);
});

test('reduced-motion still previews order but skips animation', () => {
  const h = harness({ reducedMotion: true }); h.dragFrom(h.rows[0].handle); h.over(1);
  assert.deepEqual(h.order(), ['b', 'a', 'c']); assert.equal(h.animations.length, 0);
});

test('destroy cancels animations and removes sorter listeners', () => {
  const h = harness(); h.dragFrom(h.rows[0].handle); h.over(1); h.destroy();
  assert.ok(h.animations.every(a => a.cancelled)); assert.equal(h.frames.size, 0);
  for (const node of [h.list, h.document, h.window, ...h.rows.map(row => row.handle)]) {
    for (const name of ['dragstart', 'dragend', 'dragover', 'drop', 'dragleave', 'keydown', 'blur']) assert.equal(node.listeners.get(name)?.size || 0, 0);
  }
});

test('edit controls, foreign drags, and batch-selection rows cannot reorder', () => {
  const h = harness(); assert.equal(h.dragFrom(h.rows[0].edit), null);
  h.over(1); assert.deepEqual(h.order(), ['a', 'b', 'c']); assert.equal(h.calls.length, 0);
  const batch = harness({ batch: true }); assert.ok(batch.rows.every(row => !row.handle)); assert.equal(batch.dragFrom(batch.rows[0]), null);
});

test('dropping back on the same row does not call the API', async () => {
  const h = harness(); h.dragFrom(h.rows[0].handle); await h.drop(0);
  assert.equal(h.calls.length, 0);
});

test('dragging at the edge scrolls the list and keeps previewing without saving', () => {
  const h = harness(), handle = h.rows[0].handle;
  h.list.clientHeight = 60;
  h.list.getBoundingClientRect = () => ({ top: 100, bottom: 160, height: 60 });
  h.dragFrom(handle); h.over(1, false);
  for (let i = 0; i < 12 && h.frames.size; i++) {
    const [id, fn] = h.frames.entries().next().value; h.frames.delete(id); fn();
  }
  assert.equal(h.list.scrollTop, 60);
  assert.deepEqual(h.order(), ['b', 'c', 'a']); assert.equal(h.calls.length, 0);
  h.emit(handle, 'dragend'); assert.equal(h.frames.size, 0);
  assert.deepEqual(h.order(), ['a', 'b', 'c']);
});

test('a list rebuild disposes the active drag and its animations', () => {
  const h = harness(), oldHandle = h.rows[0].handle;
  h.dragFrom(oldHandle); h.over(1);
  h.context.sessState.qpBatch = true; h.context.renderQpList();
  assert.ok(h.rows.every(row => !row.handle));
  assert.ok(h.animations.every(a => a.cancelled)); assert.equal(h.frames.size, 0);
  assert.equal(oldHandle.listeners.get('dragend')?.size, 0); assert.equal(h.calls.length, 0);
});
