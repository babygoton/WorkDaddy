'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const lib = require('../scripts/lib.js');
const sessionSync = require('../scripts/session-sync.js');
const { createDirtyIndex } = require('../scripts/session-dirty.js');
const source = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');
const base = [{ type: 'message', role: 'user', content: [{ text: 'question' }] }, { type: 'message', role: 'assistant', content: [{ text: 'answer' }] }];
function harness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-pair-daemon-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rows = new Map();
  const file = id => path.join(root, 'projects', 'p', id + '.jsonl');
  const write = (id, messages) => { fs.mkdirSync(path.dirname(file(id)), { recursive: true }); fs.writeFileSync(file(id), messages.map(x => JSON.stringify(x)).join('\n') + '\n'); };
  const lineage = lib.ensureAutoCopySession(root, 'one', 'a');
  for (const [id, uid] of [['a', 'one'], ['b', 'two'], ['c', 'three']]) {
    rows.set(id, { id, user_id: uid, title: 'fixture', created_at: 1, updated_at: 1 });
    lib.addAutoCopySessionMember(root, lineage, uid, id); write(id, base);
  }
  const syncCacheMap = new Map();
  const dirtyIndex = createDirtyIndex(); dirtyIndex.markBaseline('one');
  const ctx = { ...lib, sessionSync, fs, path, crypto, DATA_DIR: root, PROFILE: { dataRoot: root, kind: 'workbuddy' }, createDirtyIndex,
    sessionCopyRowRevision: row => JSON.stringify([
      String(row && row.id || ''), String(row && row.user_id || ''),
      Number(row && row.updated_at || 0), Number(row && row.last_activity_at || 0),
      String(row && row.status || ''), String(row && row.title || ''), String(row && row.custom_title || ''),
    ]),
    accountSwitchInProgress: false, SESSION_COPY_COLUMNS: ['id', 'user_id'], sessionCopyLocks: new Map(), yieldAutoCopyToRenderer: async () => {}, assertSessionSyncIdle: async () => {},
    getSessionSyncCache: () => syncCacheMap, scheduleSessionSyncCacheSave: () => {},
    getSessionDirtyIndex: () => dirtyIndex,
    log: () => {}, sqliteQuery: async (_, params) => {
      const row = rows.get(params[0]); return row && (!params[1] || params[1] === row.user_id) ? [{ ...row }] : [];
    },
    sqliteRun: async (_, params) => { const row = rows.get(params[5]); assert.ok(row); Object.assign(row, { title: params[0], updated_at: params[3] }); },
    insertCopiedSession: async (src, uid, id) => {
      const row = { ...src, user_id: uid, id, updated_at: Date.now(), last_activity_at: Number(src.last_activity_at || src.updated_at || Date.now()) };
      rows.set(id, row);
      return row;
    },
  };
  vm.runInNewContext(source.slice(source.indexOf('function sessionCopyContentRevision('), source.indexOf('async function buildAutoCopyPlan(')), ctx);
  return { root, rows, file, write, ctx, lineage, copy: () => ctx.copySessionRecord(rows.get('a'), 'two', { auto: true, lineageId: lineage }) };
}
test('account two continuation updates account one and never account three', async t => {
  const h = harness(t); h.write('b', [...base, { type: 'message', role: 'user', content: [{ text: 'continued' }] }]);
  const third = fs.readFileSync(h.file('c'));
  const result = await h.copy();
  assert.equal(result.status, 'copied');
  assert.deepEqual(fs.readFileSync(h.file('a')), fs.readFileSync(h.file('b')));
  assert.deepEqual(fs.readFileSync(h.file('c')), third);
  assert.equal(result.warning, '');
  assert.equal(result.totalBytes, fs.statSync(h.file('a')).size);
  assert.equal(result.copiedBytes, fs.statSync(h.file('a')).size);
  assert.equal((await h.copy()).copiedBytes, 0);
});

test('automatic first copy to an account with no physical target uses the fast snapshot path', async t => {
  const h = harness(t);
  lib.removeAutoCopySessionMember(h.root, h.lineage, 'two', 'b');
  h.rows.delete('b');
  fs.rmSync(h.file('b'), { force: true });
  let syncReads = 0;
  let asyncReads = 0;
  const readSnapshot = h.ctx.sessionSync.readSnapshot;
  const readSnapshotAsync = h.ctx.sessionSync.readSnapshotAsync;
  h.ctx.sessionSync.readSnapshot = (...args) => { syncReads++; return readSnapshot(...args); };
  h.ctx.sessionSync.readSnapshotAsync = async (...args) => { asyncReads++; return readSnapshotAsync(...args); };
  try {
    const result = await h.copy();
    assert.equal(result.status, 'copied');
    assert.ok(syncReads > 0, 'first-time copies should use the synchronous snapshot path');
    assert.equal(asyncReads, 0, 'first-time copies should not pay the async snapshot path');
    const mapping = lib.getAutoCopyMapping(h.root, h.lineage, 'two');
    assert.equal(mapping.targetStateRevision, h.ctx.sessionCopyStableStateRevision(h.rows.get(result.targetId)),
      'new mappings must record the inserted target row revision');
  } finally {
    h.ctx.sessionSync.readSnapshot = readSnapshot;
    h.ctx.sessionSync.readSnapshotAsync = readSnapshotAsync;
  }
});

test('automatic repeat sync rechecks persisted content and reports no writes', async t => {
  const h = harness(t);
  assert.equal((await h.copy()).status, 'skipped');
  const originalSnapshot = h.ctx.sessionSync.readSnapshotAsync;
  const originalQuickFingerprint = h.ctx.sessionSync.readSessionQuickFingerprintAsync;
  let fullReads = 0;
  let quickReads = 0;
  h.ctx.sessionSync.readSnapshotAsync = async (...args) => { fullReads++; return originalSnapshot(...args); };
  h.ctx.sessionSync.readSessionQuickFingerprintAsync = async (...args) => { quickReads++; return originalQuickFingerprint(...args); };
  try {
    const result = await h.copy();
    assert.equal(result.status, 'skipped');
    assert.equal(result.copiedBytes, 0);
    assert.equal(fullReads, 0, 'unchanged mapped sessions should skip full snapshots');
    assert.equal(quickReads, 0, 'unchanged mapped sessions use DB revisions without filesystem scans');
  } finally {
    h.ctx.sessionSync.readSnapshotAsync = originalSnapshot;
    h.ctx.sessionSync.readSessionQuickFingerprintAsync = originalQuickFingerprint;
  }
});

test('automatic sync falls back to snapshots when a session row revision changes', async t => {
  const h = harness(t);
  assert.equal((await h.copy()).status, 'skipped');
  h.write('a', [...base, nextMessage('changed')]);
  h.rows.get('a').updated_at++;
  const originalSnapshot = h.ctx.sessionSync.readSnapshotAsync;
  let fullReads = 0;
  h.ctx.sessionSync.readSnapshotAsync = async (...args) => { fullReads++; return originalSnapshot(...args); };
  try {
    const result = await h.copy();
    assert.equal(result.status, 'copied');
    assert.ok(fullReads > 0, 'changed DB revisions should leave the fast path');
  } finally {
    h.ctx.sessionSync.readSnapshotAsync = originalSnapshot;
  }
});

test('automatic copy planning drops revision-stable mappings before workers', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-plan-daemon-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'session-dirty.json'), JSON.stringify({ version: 1, accounts: { one: { initialized: true, sessions: {} } } }));
  lib.setAutoCopyAllSessions(root, true);
  const lineage = lib.ensureAutoCopySession(root, 'one', 'a');
  lib.addAutoCopySessionMember(root, lineage, 'two', 'b');
  const sourceRow = { id: 'a', user_id: 'one', cwd: '/fixture', title: 'fixture', custom_title: '', status: 'completed', updated_at: 7, last_activity_at: 7 };
  const target = { ...sourceRow, id: 'b', user_id: 'two' };
  const revision = row => JSON.stringify([
    String(row.id), String(row.user_id), Number(row.updated_at || 0), Number(row.last_activity_at || 0),
    String(row.status || ''), String(row.title || ''), String(row.custom_title || ''),
  ]);
  lib.setAutoCopyMapping(root, lineage, 'two', {
    targetId: 'b', fingerprintVersion: 2, sourceRevision: revision(sourceRow), targetRevision: revision(target),
  });
  let targetQueries = 0;
  const ctx = { ...lib, fs, path, DATA_DIR: root, createDirtyIndex, SESSION_COPY_COLUMNS: ['id', 'user_id', 'cwd', 'title', 'custom_title', 'status', 'updated_at', 'last_activity_at'], sessionCopyRowRevision: revision,
    sqliteQuery: async (_, params) => { if (String(params[0]) === 'two') targetQueries++; return [String(params[0]) === 'one' ? { ...sourceRow } : { ...target }]; } };
  const start = source.indexOf('function sessionCopyContentRevision(');
  vm.runInNewContext(source.slice(start, source.indexOf('const autoCopyJobs', start)), ctx);
  assert.equal((await ctx.buildAutoCopyPlan('one', 'two')).length, 0, 'stable mapped sessions should not enter the copy worker pool');
  assert.equal(targetQueries, 0, 'clean plans should not query the target account');
  sourceRow.updated_at++;
  assert.equal((await ctx.buildAutoCopyPlan('one', 'two')).length, 1, 'a changed source revision should be planned');
  assert.equal(targetQueries, 1, 'dirty plans should query the target account once');
});

test('automatic copy planning reuses a stable cross-account mapping without a worker', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-plan-cross-account-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  lib.setAutoCopyAllSessions(root, true);
  const lineage = lib.ensureAutoCopySession(root, 'one', 'a');
  lib.addAutoCopySessionMember(root, lineage, 'three', 'c');
  lib.addAutoCopySessionMember(root, lineage, 'two', 'b');
  const sourceRow = { id: 'a', user_id: 'one', cwd: '/fixture', title: 'fixture', custom_title: '', status: 'completed', updated_at: 7, last_activity_at: 7 };
  const previousSource = { ...sourceRow, id: 'c', user_id: 'three' };
  const target = { ...sourceRow, id: 'b', user_id: 'two' };
  const revision = row => JSON.stringify([
    String(row.id), String(row.user_id), Number(row.updated_at || 0), Number(row.last_activity_at || 0),
    String(row.status || ''), String(row.title || ''), String(row.custom_title || ''),
  ]);
  lib.setAutoCopyMapping(root, lineage, 'two', {
    targetId: 'b', fingerprintVersion: 2, sourceRevision: revision(previousSource), targetRevision: revision(target),
  });
  const ctx = { ...lib, DATA_DIR: root, SESSION_COPY_COLUMNS: ['id', 'user_id', 'cwd', 'title', 'custom_title', 'status', 'updated_at', 'last_activity_at'], sessionCopyRowRevision: revision,
    sqliteQuery: async (_, params) => [String(params[0]) === 'one' ? { ...sourceRow } : { ...target }] };
  const start = source.indexOf('function sessionCopyContentRevision(');
  vm.runInNewContext(source.slice(start, source.indexOf('const autoCopyJobs', start)), ctx);
  assert.deepEqual(await ctx.buildAutoCopyPlan('one', 'two'), [], 'cross-account stable mappings should not enter the copy worker pool');
  sourceRow.updated_at++;
  assert.equal((await ctx.buildAutoCopyPlan('one', 'two')).length, 1, 'a changed cross-account source revision should be planned');
});

test('explicitly requested open session is planned without regular auto-copy rules', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-plan-requested-session-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRow = {
    id: 'open-session', user_id: 'one', cwd: '/fixture', title: 'Open conversation',
    custom_title: '', status: 'completed', created_at: 1, updated_at: 7, last_activity_at: 7,
  };
  const targetRow = { ...sourceRow, id: 'other-session', user_id: 'two' };
  const ctx = {
    ...lib, fs, path, DATA_DIR: root,
    SESSION_COPY_COLUMNS: ['id', 'user_id', 'cwd', 'title', 'custom_title', 'status', 'updated_at', 'last_activity_at'],
    sessionCopyRowRevision: row => JSON.stringify([
      String(row.id), String(row.user_id), Number(row.updated_at || 0), Number(row.last_activity_at || 0),
      String(row.status || ''), String(row.title || ''), String(row.custom_title || ''),
    ]),
    sqliteQuery: async (_, params) => String(params[0]) === 'one' ? [{ ...sourceRow }] : [{ ...targetRow }],
  };
  const start = source.indexOf('function sessionCopyContentRevision(');
  vm.runInNewContext(source.slice(start, source.indexOf('const autoCopyJobs', start)), ctx);

  const plan = await ctx.buildAutoCopyPlan('one', 'two', ['open-session']);
  assert.deepEqual(plan.map(row => row.id), ['open-session']);
  assert.equal(plan[0].lineageId, null, 'an explicitly requested session need not already have a copy lineage');
});

test('sessions over 100 MiB copy completely and report only an advisory, including on repeat sync', async t => {
  const h = harness(t);
  const file = path.join(h.root, 'workspace/sessions/a/large.bin');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'large session fixture');
  const size = 100 * 1024 * 1024 + 1;
  fs.truncateSync(file, size);
  const result = await h.copy();
  assert.equal(result.status, 'copied');
  assert.equal(result.failedFiles, 0);
  assert.equal(result.warning, '会话超过 100 MB，同步可能较慢');
  const target = path.join(h.root, 'workspace/sessions/b/large.bin');
  assert.equal(fs.statSync(target).size, size);
  assert.equal(result.totalBytes, size + fs.statSync(h.file('b')).size);
  const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  assert.equal(hash(target), hash(file));
  const repeat = await h.copy();
  assert.equal(repeat.status, 'skipped');
  assert.equal(repeat.warning, result.warning);
});
test('divergent copies survive repeated switches and stale mappings cannot force overwrite', async t => {
  const h = harness(t);
  h.write('a', [...base, { type: 'message', role: 'user', content: [{ text: 'branch one' }] }]);
  h.write('b', [...base, { type: 'message', role: 'user', content: [{ text: 'branch two' }] }]);
  const a = fs.readFileSync(h.file('a')), b = fs.readFileSync(h.file('b'));
  for (let i = 0; i < 2; i++) {
    const result = await h.copy();
    assert.equal(result.status, i === 0 ? 'copied' : 'skipped');
    if (i === 0) { assert.equal(result.branched, true); assert.deepEqual(fs.readFileSync(h.file(result.targetId)), a); }
    assert.equal([...h.rows.values()].filter(row => row.user_id === 'two').length, 2);
    assert.deepEqual(fs.readFileSync(h.file('a')), a); assert.deepEqual(fs.readFileSync(h.file('b')), b);
  }
});
test('missing target rows and missing target payloads are filled without consulting third-account conflicts', async t => {
  const h = harness(t); h.write('c', [{ type: 'message', role: 'user', content: [{ text: 'third branch' }] }]);
  fs.unlinkSync(h.file('b'));
  assert.equal((await h.copy()).status, 'copied');
  assert.deepEqual(fs.readFileSync(h.file('b')), fs.readFileSync(h.file('a')));
  h.rows.delete('b'); fs.unlinkSync(h.file('b'));
  lib.setAutoCopyMapping(h.root, h.lineage, 'two', { targetId: 'b', updatedAt: 1 });
  const result = await h.copy();
  assert.equal(result.status, 'copied'); assert.notEqual(result.targetId, 'b');
  assert.equal((await h.copy()).status, 'skipped');
  assert.equal([...h.rows.values()].filter(row => row.user_id === 'two').length, 1);
});
test('manual and automatic switching bypass session activity while retaining operation locks', async () => {
  const start = source.indexOf('async function assertSessionSyncIdle(');
  const end = source.indexOf('let automationAccountSwitchTail', start);
  assert.ok(start >= 0 && end > start);
  const ctx = { accountSwitchInProgress: false, cdp: { connected: true }, PROFILE: { kind: 'workbuddy' }, autoCopyWorkerRunning: false, autoCopyQueue: [], sessionCopyLocks: new Map(),
    cdpSend: async () => ({ result: { value: true } }) };
  vm.runInNewContext(source.slice(start, end), ctx);
  await assert.rejects(ctx.assertSessionSyncIdle(['source', 'target']), /会话仍在运行/);
  ctx.cdpSend = async () => ({ result: { value: null } });
  await assert.rejects(ctx.assertSessionSyncIdle(), /无法确认/);
  ctx.cdpSend = async () => ({ result: { value: false } }); await ctx.assertSessionSyncIdle();
  ctx.cdp.connected = false;
  ctx.cdpSend = async () => { throw Error('Switching must not query session activity'); };
  const release = await ctx.assertAccountSwitchIdle();
  await assert.rejects(ctx.assertAccountSwitchIdle(), /账号正在切换/);
  release();
  ctx.cdp.connected = true;
  ctx.cdpSend = async () => ({ result: { value: true } });
  (await ctx.assertAccountSwitchIdle())();
  for (const key of ['autoCopyWorkerRunning', 'autoCopyQueue', 'sessionCopyLocks']) {
    const previous = ctx[key];
    ctx[key] = key === 'autoCopyWorkerRunning' ? true : key === 'autoCopyQueue' ? [{}] : new Map([['fixture', true]]);
    await assert.rejects(ctx.assertAccountSwitchIdle(), /会话同步尚未完成/);
    ctx[key] = previous;
    (await ctx.assertAccountSwitchIdle())();
  }
  for (const block of [source.slice(source.indexOf('function automationSwitchAccount('), source.indexOf('function startAutomationRun(')), source.slice(source.indexOf("if (req.method === 'POST' && p === '/api/switch')"))]) {
    assert.ok(/await (assertAccountSwitchIdle|acquireAutomationAccountSwitch)\(/.test(block) && block.search(/await (assertAccountSwitchIdle|acquireAutomationAccountSwitch)\(/) < block.indexOf('switchTo(DATA_DIR, uid, log)'));
  }
});
test('mixed sync jobs continue after divergence and report every result', async () => {
  const results = ['conflict', 'copied', 'skipped', 'error'];
  let sizeReads = 0;
  const ctx = { crypto, PROFILE: { dataRoot: 'fixture-root' }, autoCopyJobs: new Map(), autoCopyQueue: [], Date,
    yieldAutoCopyToRenderer: async () => {}, buildAutoCopyPlan: async () => results.map((_, i) => ({ id: String(i) })),
    copySessionRecord: async row => { const status = results[Number(row.id)]; if (status === 'error') throw Error('fixture failure'); return { status, branched: status === 'copied', copiedBytes: status === 'copied' ? 123456 : 0, totalBytes: 123456, warning: status === 'copied' ? 'large session advisory' : '' }; },
    sessionSync: { readSessionSizes: async () => { sizeReads++; return new Map(); } },
    log() {}, runAutoCopyQueue() {}, pruneAutoCopyJobs() {}, setTimeout: () => ({ unref() {} }),
  };
  const start = source.indexOf('function startAutoCopyJob(');
  vm.runInNewContext(source.slice(start, source.indexOf('function activeAutoCopyJob(', start)), ctx);
  const job = ctx.startAutoCopyJob('one', 'two', []);
  await ctx.autoCopyQueue[0].run();
  assert.equal(job.processed, 4);
  assert.equal(sizeReads, 0);
  assert.equal(job.copiedBytes, 123456);
  assert.equal(job.conflicts, 1); assert.equal(job.copied, 1); assert.equal(job.skipped, 1); assert.equal(job.failedItems, 1);
  assert.equal(job.details[1].branched, true);
  assert.equal(job.details[1].warning, 'large session advisory');
  assert.equal(job.warning, 'large session advisory');
  assert.deepEqual(Array.from(job.details, item => item.status), ['conflict', 'copied', 'skipped', 'failed']);
  results.splice(0, results.length, 'copied', 'skipped');
  const advisoryOnly = ctx.startAutoCopyJob('one', 'two', []);
  await ctx.autoCopyQueue[1].run();
  const published = ctx.publicAutoCopyJob(advisoryOnly);
  assert.equal(published.status, 'done');
  assert.equal(published.failed, 0);
  assert.equal(published.failedItems, 0);
  assert.equal(published.warning, 'large session advisory');
  assert.equal(published.details[0].warning, 'large session advisory');
  assert.equal(published.details[0].totalBytes, 123456);
});

test('an empty automatic copy plan does not wait for renderer injection', async () => {
  const planningYields = [];
  let rendererWaits = 0;
  const ctx = { crypto, PROFILE: { dataRoot: 'fixture-root' }, autoCopyJobs: new Map(), autoCopyQueue: [], Date,
    yieldAutoCopyToRenderer: async options => {
      planningYields.push(options);
      if (!options || options.waitForInjection !== false) rendererWaits++;
    },
    buildAutoCopyPlan: async () => [], sessionSync: { readSessionSizes: async () => new Map() },
    log() {}, runAutoCopyQueue() {}, pruneAutoCopyJobs() {}, setTimeout: () => ({ unref() {} }),
  };
  const start = source.indexOf('function startAutoCopyJob(');
  vm.runInNewContext(source.slice(start, source.indexOf('function activeAutoCopyJob(', start)), ctx);
  const job = ctx.startAutoCopyJob('one', 'two', []);
  await ctx.autoCopyQueue[0].run();
  assert.equal(job.status, 'done');
  assert.equal(planningYields.length, 1);
  assert.equal(planningYields[0].waitForInjection, false);
  assert.equal(rendererWaits, 0);
});

test('automatic session sync uses a bounded worker pool', async () => {
  let running = 0;
  let peak = 0;
  const ctx = { crypto, PROFILE: { dataRoot: 'fixture-root' }, autoCopyJobs: new Map(), autoCopyQueue: [], Date,
    yieldAutoCopyToRenderer: async () => {}, buildAutoCopyPlan: async () => Array.from({ length: 8 }, (_, id) => ({ id: String(id) })),
    copySessionRecord: async row => {
      running++;
      peak = Math.max(peak, running);
      await new Promise(resolve => setTimeout(resolve, 5));
      running--;
      return { status: 'skipped', sourceBytes: 1, copiedBytes: 0, totalBytes: 1 };
    },
    log() {}, runAutoCopyQueue() {}, pruneAutoCopyJobs() {}, setTimeout,
  };
  const start = source.indexOf('function startAutoCopyJob(');
  vm.runInNewContext(source.slice(start, source.indexOf('function activeAutoCopyJob(', start)), ctx);
  const job = ctx.startAutoCopyJob('one', 'two', []);
  await ctx.autoCopyQueue[0].run();
  assert.equal(peak, 4);
  assert.equal(job.processed, 8);
  assert.equal(job.skipped, 8);
  assert.deepEqual(Array.from(job.details, item => item.id), Array.from({ length: 8 }, (_, id) => String(id)));
});

test('automatic session sync aggregates copied bytes independently across workers', async () => {
  const ctx = { crypto, PROFILE: { dataRoot: 'fixture-root' }, autoCopyJobs: new Map(), autoCopyQueue: [], Date,
    yieldAutoCopyToRenderer: async () => {}, buildAutoCopyPlan: async () => Array.from({ length: 8 }, (_, id) => ({ id: String(id) })),
    copySessionRecord: async () => {
      await new Promise(resolve => setTimeout(resolve, 2));
      return { status: 'copied', sourceBytes: 100, copiedBytes: 100, totalBytes: 100 };
    },
    log() {}, runAutoCopyQueue() {}, pruneAutoCopyJobs() {}, setTimeout,
  };
  const start = source.indexOf('function startAutoCopyJob(');
  vm.runInNewContext(source.slice(start, source.indexOf('function activeAutoCopyJob(', start)), ctx);
  const job = ctx.startAutoCopyJob('one', 'two', []);
  await ctx.autoCopyQueue[0].run();
  assert.equal(job.copiedBytes, 800);
});

test('macOS packaging includes the required sync module', () => {
  const script = fs.readFileSync(path.join(__dirname, '../scripts/build-mac-dmg.sh'), 'utf8');
  assert.match(script, /for f in [^\n]*session-sync\.js/);
});

test('account switching copies valid messages alongside non-JSON workspace files without changing their bytes', async t => {
  const h = harness(t);
  const file = path.join(h.root, 'workspace/sessions/a/editor-settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = Buffer.from('// JSONC workspace fixture\n{"editor":true,}\n');
  fs.writeFileSync(file, bytes);
  const result = await h.copy();
  assert.equal(result.status, 'copied');
  assert.deepEqual(fs.readFileSync(path.join(h.root, 'workspace/sessions/b/editor-settings.json')), bytes);
  assert.deepEqual(fs.readFileSync(h.file('a')), fs.readFileSync(h.file('b')));
  assert.equal((await h.copy()).status, 'skipped');
  assert.equal(fs.existsSync(path.join(h.root, 'workspace/sessions/c/editor-settings.json')), false);
});

function addTarget(h, id, records = base) {
  h.rows.set(id, { ...h.rows.get('b'), id });
  lib.addAutoCopySessionMember(h.root, h.lineage, 'two', id);
  h.write(id, records);
}
const nextMessage = text => ({ type: 'message', role: 'user', content: [{ text }] });

test('multiple identical target copies skip without creating or rewriting sessions', async t => {
  const h = harness(t); addTarget(h, 'b2'); addTarget(h, 'b3');
  lib.setAutoCopyMapping(h.root, h.lineage, 'two', { targetId: 'b2' });
  const before = [...h.rows.keys()].map(id => [id, fs.readFileSync(h.file(id))]);
  for (let i = 0; i < 2; i++) {
    const result = await h.copy();
    assert.equal(result.status, 'skipped'); assert.equal(result.targetId, 'b2');
  }
  assert.equal(h.rows.size, before.length);
  for (const [id, bytes] of before) assert.deepEqual(fs.readFileSync(h.file(id)), bytes);
  assert.equal(fs.existsSync(path.join(h.root, 'session-sync-backups')), false);
});

test('an exact copy is found even when the preferred duplicate is divergent or unreadable', async t => {
  const h = harness(t); addTarget(h, 'b2');
  lib.setAutoCopyMapping(h.root, h.lineage, 'two', { targetId: 'b' });
  for (const content of ['{broken', JSON.stringify(nextMessage('other branch'))]) {
    fs.writeFileSync(h.file('b'), content);
    const result = await h.copy();
    assert.equal(result.status, 'skipped'); assert.equal(result.targetId, 'b2');
    assert.equal(fs.readFileSync(h.file('b'), 'utf8'), content);
  }
});

test('source continuation updates the closest proven base while preserving other copies and third accounts', async t => {
  const h = harness(t); const continued = [...base, nextMessage('next')];
  addTarget(h, 'b2', continued); addTarget(h, 'branch', [...base, nextMessage('different')]);
  h.write('a', [...continued, nextMessage('latest')]);
  lib.setAutoCopyMapping(h.root, h.lineage, 'two', { targetId: 'branch' });
  const untouched = ['b', 'branch', 'c'].map(id => [id, fs.readFileSync(h.file(id))]);
  const result = await h.copy();
  assert.equal(result.status, 'copied'); assert.equal(result.targetId, 'b2');
  assert.deepEqual(fs.readFileSync(h.file('b2')), fs.readFileSync(h.file('a')));
  for (const [id, bytes] of untouched) assert.deepEqual(fs.readFileSync(h.file(id)), bytes);
  assert.equal((await h.copy()).status, 'skipped');
  assert.equal(h.rows.size, 5);
});

test('multiple target continuations only update the source when they form one chain', async t => {
  const h = harness(t); const continued = [...base, nextMessage('next')];
  h.write('b', continued); addTarget(h, 'b2', [...continued, nextMessage('latest')]);
  const oldTarget = fs.readFileSync(h.file('b')), third = fs.readFileSync(h.file('c'));
  assert.equal((await h.copy()).status, 'copied');
  assert.deepEqual(fs.readFileSync(h.file('a')), fs.readFileSync(h.file('b2')));
  assert.deepEqual(fs.readFileSync(h.file('b')), oldTarget);
  assert.deepEqual(fs.readFileSync(h.file('c')), third);
});

test('divergent target continuations are reported as branches and never arbitrarily replace the source', async t => {
  const h = harness(t); h.write('b', [...base, nextMessage('branch one')]);
  addTarget(h, 'b2', [...base, nextMessage('branch two')]);
  lib.setAutoCopyMapping(h.root, h.lineage, 'two', { targetId: 'b' });
  const before = [...h.rows.keys()].map(id => [id, fs.readFileSync(h.file(id))]);
  const result = await h.copy();
  assert.equal(result.status, 'copied'); assert.equal(result.branched, true);
  assert.deepEqual(fs.readFileSync(h.file(result.targetId)), fs.readFileSync(h.file('a')));
  for (const [id, bytes] of before) assert.deepEqual(fs.readFileSync(h.file(id)), bytes);
});

test('duplicates with only unreadable messages remain real failures and preserve every file', async t => {
  const h = harness(t); addTarget(h, 'b2');
  fs.writeFileSync(h.file('b'), '{broken'); fs.writeFileSync(h.file('b2'), '{also broken');
  await assert.rejects(h.copy(), /会话消息文件未写完或已损坏/);
  assert.equal(fs.readFileSync(h.file('b'), 'utf8'), '{broken');
  assert.equal(fs.readFileSync(h.file('b2'), 'utf8'), '{also broken');
});

test('a complete duplicate takes priority over repairing an incomplete copy', async t => {
  const h = harness(t); addTarget(h, 'b2');
  for (const id of ['a', 'b2']) {
    const file = path.join(h.root, 'tasks', id, 'output.txt');
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'fixture output');
  }
  lib.setAutoCopyMapping(h.root, h.lineage, 'two', { targetId: 'b' });
  const result = await h.copy();
  assert.equal(result.status, 'skipped'); assert.equal(result.targetId, 'b2');
  assert.equal(fs.existsSync(path.join(h.root, 'tasks/b/output.txt')), false);
  assert.equal(fs.existsSync(path.join(h.root, 'session-sync-backups')), false);
});

test('no matching branch among multiple target copies preserves all versions without a copy failure', async t => {
  const h = harness(t);
  h.write('a', [...base, nextMessage('source branch')]);
  h.write('b', [...base, nextMessage('target branch one')]);
  addTarget(h, 'b2', [...base, nextMessage('target branch two')]);
  const before = [...h.rows.keys()].map(id => [id, fs.readFileSync(h.file(id))]);
  const result = await h.copy();
  assert.equal(result.status, 'copied'); assert.equal(result.branched, true); assert.equal(result.failedFiles, 0);
  for (const [id, bytes] of before) assert.deepEqual(fs.readFileSync(h.file(id)), bytes);
  assert.deepEqual(fs.readFileSync(h.file(result.targetId)), fs.readFileSync(h.file('a')));
  assert.equal(h.rows.size, before.length + 1);
  assert.equal((await h.copy()).status, 'skipped');
});


test('a copied branch remains visible beside the original and later updates only its own continuation', async t => {
  const h = harness(t);
  h.write('a', [...base, nextMessage('source branch')]); h.write('b', [...base, nextMessage('target branch')]);
  const original = fs.readFileSync(h.file('b'));
  const result = await h.copy(); assert.equal(result.branched, true);
  const rules = lib.getAutoCopyRules(h.root, 'two');
  const targetRows = [...h.rows.values()].filter(row => row.user_id === 'two');
  const visible = lib.dedupeAutoCopySessionRows(targetRows, { two: rules.allLineages }, { two: new Set(rules.branchSessionIds) });
  assert.equal(visible.length, 2);
  h.write('a', [...base, nextMessage('source branch'), nextMessage('continued source branch')]);
  h.rows.get('a').updated_at++;
  const updated = await h.copy();
  assert.equal(updated.status, 'copied'); assert.equal(updated.targetId, result.targetId);
  assert.deepEqual(fs.readFileSync(h.file(updated.targetId)), fs.readFileSync(h.file('a')));
  assert.deepEqual(fs.readFileSync(h.file('b')), original);
  assert.equal([...h.rows.values()].filter(row => row.user_id === 'two').length, 2);
  assert.equal((await h.copy()).status, 'skipped');
});

test('failed branch insertion leaves no visible row or copied files and a retry copies exactly once', async t => {
  const h = harness(t);
  h.write('a', [...base, nextMessage('source branch')]); h.write('b', [...base, nextMessage('target branch')]);
  const original = fs.readFileSync(h.file('b')), insert = h.ctx.insertCopiedSession;
  h.ctx.insertCopiedSession = async () => { throw Error('fixture insert failure'); };
  await assert.rejects(h.copy(), /fixture insert failure/);
  assert.equal(h.rows.size, 3);
  assert.equal(fs.readdirSync(path.dirname(h.file('a'))).filter(name => name.endsWith('.jsonl')).length, 3);
  assert.deepEqual(fs.readFileSync(h.file('b')), original);
  h.ctx.insertCopiedSession = insert;
  assert.equal((await h.copy()).status, 'copied');
  assert.equal((await h.copy()).status, 'skipped');
  assert.equal(h.rows.size, 4);
});
