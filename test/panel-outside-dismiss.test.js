'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../scripts/inject.js'), 'utf8');

function harness() {
  const handlers = new Map(), disposers = [], calls = [];
  const root = { contains: node => node === inside || node === fab };
  const inside = { nodeType: 1 }, fab = { nodeType: 1 };
  const portal = { closest: () => ({}) };
  const document = { addEventListener: (type, fn, capture) => { assert.equal(capture, true); handlers.set(type, fn); }, removeEventListener: type => handlers.delete(type) };
  const context = { root, document, state: { open: true }, registerDisposer: fn => disposers.push(fn), setOpen: open => { calls.push(open); context.state.open = open; } };
  const listenStart = source.indexOf('    function listen(target, type, handler, options)');
  vm.runInNewContext(source.slice(listenStart, source.indexOf('\n    }', listenStart) + 6), context);
  const start = source.indexOf('    function closePanelOnOutsidePointerDown(event)');
  assert.ok(start >= 0, 'outside-dismiss handler is wired into the shared panel');
  vm.runInNewContext(source.slice(start, source.indexOf('\n    // 供 daemon', start)), context);
  return { context, inside, fab, portal, calls, handlers, disposers, down: event => handlers.get('pointerdown')(event) };
}

test('a primary outside press closes the panel without blocking the client click', () => {
  const h = harness();
  h.down({ button: 0, target: {}, preventDefault() { assert.fail('must not eat the client click'); }, stopPropagation() { assert.fail('must not eat the client click'); } });
  assert.deepEqual(h.calls, [false]);
  h.down({ button: 0, target: {} });
  assert.deepEqual(h.calls, [false], 'closed panels do not repeat close side effects');
});

test('inside controls, robot, portaled overlays and shadow descendants keep the panel open', () => {
  const h = harness();
  for (const target of [h.inside, h.fab, h.portal]) h.down({ button: 0, target });
  h.down({ button: 0, target: {}, composedPath: () => [{}, h.inside] });
  h.down({ button: 2, target: {} });
  assert.deepEqual(h.calls, []);
});

test('reinjection removes the document listener', () => {
  const h = harness();
  h.disposers.forEach(dispose => dispose());
  assert.equal(h.handlers.size, 0);
});
