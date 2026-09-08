'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const compat = require('../scripts/workbuddy-compat.js');
const inject = fs.readFileSync(path.join(__dirname, '../scripts/inject.js'), 'utf8');

// Run the real placement + visibility chain, including a conversation being removed.
function harness() {
  function element() {
    const classes = new Set();
    return {
      style: {}, children: [], isConnected: true, parentElement: null,
      classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) },
      getBoundingClientRect() { return this.hidden ? { width: 0, height: 0 } : { width: 200, height: 32, left: 400, top: 600, bottom: 632 }; },
      closest() { return this.scope || null; },
      querySelectorAll() { return []; },
      appendChild(child) { this.insertBefore(child, null); },
      insertBefore(child) {
        if (child.parentElement) child.parentElement.children = child.parentElement.children.filter(value => value !== child);
        child.parentElement = this;
        this.children.push(child);
      },
    };
  }
  const page = { toolbar: null, mic: null, editor: null, welcome: false };
  const document = {
    body: element(),
    querySelector(selector) {
      if (selector === '.voice-mic-wrap') return page.mic;
      if (selector === 'div.cr-input-toolbar__right') return page.toolbar;
      if (selector === '.wb-home-page') return page.welcome ? {} : null;
      return null;
    },
    querySelectorAll() { return []; },
  };
  const context = vm.createContext({
    document, window: { innerWidth: 1000, innerHeight: 800 }, WBS_COMPAT: compat,
    stashBtn: element(), exploreBtn: element(), alive: true,
    sessState: { phrase: true, stash: true },
    findComposer: () => page.editor,
    composerHasContent: editor => !!editor?.hasContent,
    getComputedStyle: el => ({ visibility: el.visibility || 'visible', display: 'block' }),
    clearTimeout() {}, setBuildTimeout(fn) { fn(); }, renderExploreOptions() {},
  });
  const start = inject.indexOf('    function insertStash()');
  const end = inject.indexOf('    // 监听发送按钮自身', start);
  vm.runInContext(inject.slice(start, end) + '\napplyThemeButtonColors = function () {};', context);
  return { page, document, context, element, sync: () => context.syncStash() };
}

for (const route of ['login', 'settings with an unrelated editable', 'welcome']) {
  test(`composer buttons stay hidden on ${route}`, () => {
    const h = harness();
    if (route.includes('editable')) h.page.editor = h.element();
    if (route === 'welcome') h.page.welcome = true;
    h.sync();
    assert.equal(h.context.exploreBtn.style.display, 'none');
    assert.equal(h.context.stashBtn.style.display, 'none');
  });
}

test('conversation → login → conversation hides and restores the same buttons', () => {
  const h = harness();
  h.page.toolbar = h.element();
  h.page.editor = h.element();
  h.sync();
  assert.equal(h.context.exploreBtn.style.display, 'flex');
  assert.equal(h.context.stashBtn.style.display, 'none');
  h.page.toolbar.isConnected = false;
  h.page.toolbar = h.page.editor = null;
  h.sync();
  assert.equal(h.context.exploreBtn.style.display, 'none');
  h.page.toolbar = h.element();
  h.page.editor = h.element();
  h.page.editor.hasContent = true;
  h.sync();
  assert.equal(h.context.exploreBtn.style.display, 'flex');
  assert.equal(h.context.stashBtn.style.display, 'flex');
  assert.equal(h.context.exploreBtn.parentElement, h.page.toolbar);
});

for (const visibility of ['zero size', 'hidden', 'detached']) {
  test(`a ${visibility} conversation composer cannot leave a floating button`, () => {
    const h = harness();
    h.page.editor = h.element();
    h.page.editor.scope = h.element();
    if (visibility === 'zero size') h.page.editor.hidden = true;
    if (visibility === 'hidden') h.page.editor.visibility = 'hidden';
    if (visibility === 'detached') h.page.editor.isConnected = false;
    h.sync();
    assert.equal(h.context.exploreBtn.style.display, 'none');
  });
}

test('a visible conversation composer retains fixed fallback and respects phrase switch', () => {
  const h = harness();
  h.page.editor = h.element();
  h.page.editor.scope = h.element();
  h.sync();
  assert.equal(h.context.exploreBtn.style.display, 'flex');
  assert.equal(h.context.exploreBtn.style.top, '599px');
  h.context.sessState.phrase = false;
  h.sync();
  assert.equal(h.context.exploreBtn.style.display, 'none');
});

for (const hidden of [false, true]) {
  test(`legacy microphone layout ${hidden ? 'hides with its anchor' : 'keeps fixed placement'}`, () => {
    const h = harness();
    const row = h.element();
    row.appendChild(h.element());
    h.page.mic = h.element();
    row.appendChild(h.page.mic);
    h.page.mic.hidden = hidden;
    h.sync();
    assert.equal(h.context.exploreBtn.style.display, hidden ? 'none' : 'flex');
    if (!hidden) assert.equal(h.context.exploreBtn.parentElement, h.document.body);
  });
}

test('switching from an inline toolbar to fixed layout reparents both buttons', () => {
  const h = harness();
  h.page.toolbar = h.element();
  h.sync();
  h.page.toolbar = null;
  h.page.editor = h.element();
  h.page.editor.scope = h.element();
  h.sync();
  for (const button of [h.context.stashBtn, h.context.exploreBtn]) {
    assert.equal(button.parentElement, h.document.body);
    assert.equal(button.classList.contains('wbs-stash-inline-inline'), false);
  }
});

test('visibility-hidden toolbar does not count as a conversation anchor', () => {
  const h = harness();
  h.page.toolbar = h.element();
  h.page.toolbar.visibility = 'hidden';
  h.sync();
  assert.equal(h.context.exploreBtn.style.display, 'none');
});
