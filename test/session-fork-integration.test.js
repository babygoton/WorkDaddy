'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const fork = require('../scripts/session-fork.js');
const compat = require('../scripts/workbuddy-compat.js');
const daemonSource = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');
const injectSource = fs.readFileSync(path.join(__dirname, '../scripts/inject.js'), 'utf8');

function fixture(t, insertCopiedSession) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-fork-integration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'projects', 'workspace-a');
  fs.mkdirSync(directory, { recursive: true });
  const row = { id: crypto.randomUUID(), user_id: 'account-a', cwd: '/workspace/a', title: '原会话', created_at: 1 };
  const source = path.join(directory, row.id + '.jsonl');
  const messages = ['user', 'assistant', 'user', 'assistant'].map((role, index) =>
    JSON.stringify({ type: 'message', role, timestamp: 10000 + index * 1000,
      content: [{ type: 'text', text: 'message ' + index }] })).join('\n') + '\n';
  fs.writeFileSync(source, messages);
  const context = {
    fs, path, crypto, Buffer, PROFILE: { dataRoot: root }, forkedTitle: fork.forkedTitle,
    planForkAtMessage: fork.planForkAtMessage,
    collectSessionArchiveFiles: () => [{ path: 'projects/workspace-a/' + row.id + '.jsonl', source, size: fs.statSync(source).size }],
    ensureArchiveParentNoFollow: () => {},
    insertCopiedSession,
  };
  const start = daemonSource.indexOf('async function createForkSession(');
  const end = daemonSource.indexOf('\nasync function exportSessions(', start);
  assert.ok(start > 0 && end > start, 'fork writer must be a dedicated function');
  vm.runInNewContext(daemonSource.slice(start, end), context);
  return { root, row, source, messages, createForkSession: context.createForkSession };
}

test('fork creates a new local session in the same workspace without changing the source', async (t) => {
  let copied;
  const { root, row, source, messages, createForkSession } = fixture(t, async (...args) => { copied = args; });
  const result = await createForkSession(row, { messageIndex: 1, roles: 'uaua', finishedAt: 11000 });
  assert.notEqual(result.id, row.id);
  assert.equal(result.id, copied[2]);
  assert.equal(copied[0].cwd, row.cwd);
  assert.equal(copied[1], row.user_id);
  assert.match(copied[0].title, /分支/);
  assert.equal(fs.readFileSync(source, 'utf8'), messages);
  const branch = path.join(root, 'projects', 'workspace-a', result.id + '.jsonl');
  assert.deepEqual(fs.readFileSync(branch, 'utf8').split('\n').filter(Boolean).length, 2);
});

test('failed session insert removes only the newly written fork file', async (t) => {
  const { root, row, source, messages, createForkSession } = fixture(t, async () => { throw new Error('insert failed'); });
  await assert.rejects(createForkSession(row, { messageIndex: 1, roles: 'uaua', finishedAt: 11000 }), /insert failed/);
  assert.equal(fs.readFileSync(source, 'utf8'), messages);
  assert.deepEqual(fs.readdirSync(path.join(root, 'projects', 'workspace-a')), [row.id + '.jsonl']);
});

test('footer selection uses the structured message position and completion time', () => {
  const messages = [
    { id: 'u1', messageType: 'user' },
    { id: 'a1', messageType: 'assistant', complete: true, finishTime: 11000 },
    { id: 'u2', messageType: 'user' },
    { id: 'a2', messageType: 'assistant', complete: true, finishTime: 13000 },
  ];
  const frame = { getAttribute: (name) => name === 'data-cr-frame-id' ? 'a1' : null };
  const selection = compat.findSessionForkSelection(frame, { getState: () => ({ messages }) });
  assert.deepEqual(selection, { messageIndex: 1, roles: 'uaua', finishedAt: 11000 });
  assert.equal(compat.findSessionForkSelection({ getAttribute: () => 'u1' }, { getState: () => ({ messages }) }), null);
  assert.equal(compat.findSessionForkSelection(frame, { getState: () => ({ messages: messages.slice(0, 2).map(
    (item) => item.id === 'a1' ? { ...item, complete: false } : item) }) }), null);
});

test('footer button is first, remains unique on rescan, and disappears when disabled', () => {
  const start = injectSource.indexOf('    function syncForkButtons()');
  const end = injectSource.indexOf('    function scheduleForkButtons()', start);
  assert.ok(start > 0 && end > start);
  const buttons = [];
  const feedback = {
    firstChild: { official: true },
    querySelector: () => buttons[0] || null,
    insertBefore(button, firstChild) { assert.equal(firstChild, this.firstChild); buttons.unshift(button); this.firstChild = button; },
  };
  const footer = { querySelector: () => feedback, closest: () => ({ getAttribute: () => 'assistant-1' }) };
  const context = {
    sessState: { fork: true },
    forkTooltip: { id: 'wbs-fork-tooltip' },
    hideForkTooltip() {},
    document: { querySelectorAll: (selector) => selector === '.wbs-fork-button' ? buttons.slice() : [footer] },
    el: (tag, cls) => ({ tag, className: cls, attributes: {}, setAttribute(key, value) { this.attributes[key] = value; }, getAttribute(key) { return this.attributes[key]; }, remove() { buttons.splice(buttons.indexOf(this), 1); } }),
    applyI18n() {},
  };
  vm.runInNewContext(injectSource.slice(start, end), context);
  context.syncForkButtons();
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].getAttribute('aria-label'), '从这里开始新会话');
  assert.equal(buttons[0].title, undefined);
  assert.equal(buttons[0].className, 'wbs-fork-button');
  context.syncForkButtons();
  assert.equal(buttons.length, 1);
  context.sessState.fork = false;
  context.syncForkButtons();
  assert.equal(buttons.length, 0);
});

test('fork switch defaults on and preserves explicit opt-out', () => {
  const start = injectSource.indexOf('    function readForkEnabled()');
  const end = injectSource.indexOf('    var sessState = {', start);
  assert.ok(start > 0 && end > start);
  const settings = new Map();
  const context = { FORK_ENABLED_KEY: 'workdaddy.session.forkEnabled', localStorage: {
    getItem: (key) => settings.get(key) ?? null,
    setItem: (key, value) => settings.set(key, value),
  } };
  vm.runInNewContext(injectSource.slice(start, end), context);
  assert.equal(context.readForkEnabled(), true);
  context.writeForkEnabled(false);
  assert.equal(context.readForkEnabled(), false);
  context.writeForkEnabled(true);
  assert.equal(context.readForkEnabled(), true);
});

test('enhancement switch and assistant footer control remain opt-out and accessible', () => {
  assert.match(injectSource, /workdaddy\.session\.forkEnabled/);
  assert.match(injectSource, /#wbs-sess-fork/);
  assert.match(injectSource, /分支到新会话/);
  assert.match(injectSource, /\.conversation-finished-footer/);
  assert.match(injectSource, /wbs-fork-button/);
  assert.match(injectSource, /wbs-telemetry-tooltip wbs-fork-tooltip/);
  assert.match(injectSource, /会复制这条回复及之前的聊天内容，在当前工作区新建会话；原会话不会改变。/);
  assert.match(injectSource, /复制到这条回复为止的聊天内容，在当前工作区继续聊；原会话不变。/);
  assert.match(injectSource, /conversation\.closest\('\.cr-message-list'\)/);
  assert.match(injectSource, /findMessageNavigationAdapter\(document, \{/);
  assert.match(daemonSource, /p === '\/api\/sessions\/fork'/);
});
