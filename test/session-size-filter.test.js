'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../scripts/inject.js'), 'utf8');
const section = (start, end) => source.includes(start) ? source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))) : '';
function harness() {
  const controls = {};
  const control = id => controls[id] ||= { innerHTML: '', textContent: '', style: {}, disabled: false, addEventListener(type, callback) { this[type] = callback; }, querySelectorAll: () => [] };
  const ctx = vm.createContext({
    sessionsState: { list: [{ id: 'small', totalBytes: 10 * 1024 ** 2, title: 'small' }, { id: 'large', totalBytes: 100 * 1024 ** 2 + 1, title: '<unsafe>', is_playground: 1 }, { id: 'unknown', totalBytes: null }], selected: {}, wsExpanded: {}, totalBytes: 2 * 1024 ** 3, minBytes: 10 * 1024 ** 2 },
    sessionsPane: { querySelector: control, querySelectorAll: () => [] },
    esc: value => String(value).replace(/</g, '&lt;'), escAttr: String,
    updateAutoCopyAllButton() {}, isTaskSessionRecordUI: s => !!s.is_playground,
    fmtHumanTime: () => 'now', shortWs: String, SESS_WS_INIT: 5,
  });
  vm.runInContext([
    section('    function filteredSessions()', '    // 按空间分组渲染'),
    section('    function renderSessions()', '    function updateAutoCopyAllButton()'),
    section('    function bindSessEvents(', '    function updateSessCount()'),
    section('    function updateSessCount()', '    // 人性化时间'),
    section('    function wireSessionsPane()', '    function selectedSessIds()'),
    section('    function selectedSessIds()', '    function showSessModal('),
    section('    function sessionCopySizeText(', '    function showSessionCopyDetails('),
  ].join('\n'), ctx);
  return { ctx, control };
}
test('size filter excludes exact thresholds and unknown sizes; select-all operates only on matches', () => {
  const { ctx, control } = harness();
  assert.deepEqual(Array.from(ctx.filteredSessions(), s => s.id), ['large']);
  ctx.wireSessionsPane(); control('#wbs-sess-check-all').click();
  assert.deepEqual(Array.from(ctx.selectedSessIds()), ['large']);
  assert.match(control('#wbs-sess-count').innerHTML, /共 <strong>1<\/strong> 个会话/);
  assert.match(control('#wbs-sess-list').innerHTML, /wbs-sess-size.*100\.0 MB/);
  assert.doesNotMatch(control('#wbs-sess-list').innerHTML, /<unsafe>|small/);
  ctx.sessionsState.batchMode = false;
  const button = { getAttribute: () => '0' };
  control('#wbs-sess-size-seg').click({ target: { closest: () => button } });
  assert.match(control('#wbs-sess-count').innerHTML, /总大小 <strong>2\.0 GB<\/strong>/);
  assert.equal(ctx.filteredSessions().length, 3);
  assert.equal(ctx.selectedSessIds().length, 0);
  ctx.sessionsState.minBytes = 500 * 1024 ** 2; ctx.renderSessions();
  assert.match(control('#wbs-sess-list').innerHTML, /当前筛选下没有会话/);
});

test('session summary formats large counts and emphasizes numeric values', () => {
  const { ctx, control } = harness();
  ctx.sessionsState.list = Array.from({ length: 1111 }, (_, index) => ({ id: String(index), totalBytes: 0 }));
  ctx.sessionsState.minBytes = 0;
  ctx.updateSessionSummary(control('#wbs-sess-count'));
  assert.match(control('#wbs-sess-count').innerHTML, /共 <strong>1,111<\/strong> 个会话/);
  assert.match(control('#wbs-sess-count').innerHTML, /总大小 <strong>2\.0 GB<\/strong>/);
});

test('expanded session groups can collapse back to the default row count', () => {
  const { ctx, control } = harness();
  ctx.SESS_WS_INIT = 2;
  ctx.sessionsState.minBytes = 0;
  ctx.sessionsState.list = Array.from({ length: 5 }, (_, index) => ({ id: String(index), cwd: '/repo', title: 'session ' + index, totalBytes: 1 }));
  ctx.renderSessions();
  const list = control('#wbs-sess-list');
  assert.match(list.innerHTML, />展开<\/button>/);
  assert.doesNotMatch(list.innerHTML, /展开 .*条/);
  assert.equal((list.innerHTML.match(/class="wbs-sess-row"/g) || []).length, 2);
  const button = action => ({ getAttribute: name => name === 'data-ws' ? '::/repo' : name === 'data-action' ? action : null });
  list.onclick({ target: { closest: selector => selector === '.wbs-sess-more' ? button('expand') : null } });
  assert.equal((list.innerHTML.match(/class="wbs-sess-row"/g) || []).length, 5);
  assert.match(list.innerHTML, /收起/);
  assert.doesNotMatch(list.innerHTML, />展开<\/button>/);
  list.onclick({ target: { closest: selector => selector === '.wbs-sess-more' ? button('collapse') : null } });
  assert.match(list.innerHTML, />展开<\/button>/);
  assert.doesNotMatch(list.innerHTML, /收起/);
  assert.equal((list.innerHTML.match(/class="wbs-sess-row"/g) || []).length, 2);
});

test('task session group expands all rows before showing collapse', () => {
  const { ctx, control } = harness();
  ctx.SESS_WS_INIT = 2;
  ctx.sessionsState.minBytes = 0;
  ctx.sessionsState.list = Array.from({ length: 4 }, (_, index) => ({ id: String(index), title: 'task ' + index, totalBytes: 1, is_playground: 1 }));
  ctx.renderSessions();
  const list = control('#wbs-sess-list');
  const button = action => ({ getAttribute: name => name === 'data-ws' ? '__TASKS__' : name === 'data-action' ? action : null });
  assert.match(list.innerHTML, />展开<\/button>/);
  assert.doesNotMatch(list.innerHTML, /收起/);
  list.onclick({ target: { closest: selector => selector === '.wbs-sess-more' ? button('expand') : null } });
  assert.equal((list.innerHTML.match(/class="wbs-sess-row"/g) || []).length, 4);
  assert.match(list.innerHTML, /收起/);
  assert.doesNotMatch(list.innerHTML, />展开<\/button>/);
});

test('session account selector follows the fixed account order', () => {
  const start = source.indexOf('    function sortSessionAccounts(');
  const end = source.indexOf('    function loadSessionAccounts()', start);
  assert.ok(start >= 0 && end > start, 'missing session account ordering helper');
  const ctx = vm.createContext({});
  vm.runInContext(source.slice(start, end), ctx);
  const ordered = ctx.sortSessionAccounts([
    { uid: 'late', sort: 2 }, { uid: 'first', sort: 1 }, { uid: 'new', sort: 0 },
  ], { mode: 'fixed' });
  assert.deepEqual(Array.from(ordered, account => account.uid), ['first', 'late', 'new']);
});

test('session account selector follows the account page credit-expiry order', () => {
  const start = source.indexOf('    function sortSessionAccounts(');
  const end = source.indexOf('    function loadSessionAccounts()', start);
  assert.ok(start >= 0 && end > start, 'missing session account ordering helper');
  const ctx = vm.createContext({ isFinite });
  vm.runInContext(source.slice(start, end), ctx);
  const ordered = ctx.sortSessionAccounts([
    { uid: 'later', creditSegments: [{ remaining: 2, expiresAt: 300 }] },
    { uid: 'first', creditSegments: [{ remaining: 1, expiresAt: 100 }] },
    { uid: 'spent', creditSegments: [{ remaining: 0, expiresAt: 50 }] },
    { uid: 'middle', creditSegments: [{ remaining: 3, expiresAt: 200 }] },
  ], { mode: 'expiry' });
  assert.deepEqual(Array.from(ordered, account => account.uid), ['first', 'middle', 'later', 'spent']);
});
