'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');
const start = source.indexOf('function createDirectoryNoFollow(directory)');
const end = source.indexOf('function sessionRangeMs(', start);
assert.ok(start >= 0 && end > start, 'session cwd repair helpers must be present');

// Execute the real repair helpers with Windows paths and an in-memory filesystem
// so missing drives and remounts can be exercised on every test host.
function harness({ isWin = true, kind = 'workbuddy' } = {}) {
  const state = {
    rows: [
      { id: 'fixture-a', cwd: 'G:\\fixture\\project-a' },
      { id: 'fixture-b', cwd: 'G:\\fixture\\project-b' },
    ],
    roots: new Set(), directories: new Set(), symlinks: new Set(),
    missingPayloads: new Set(), mkdir: [], logs: [], denied: false, queries: 0, now: 1000000,
  };
  const missing = () => Object.assign(new Error('fixture path missing'), { code: 'ENOENT' });
  const context = vm.createContext({
    Date: { now: () => state.now },
    path: path.win32,
    fs: {
      existsSync(target) {
        return state.roots.has(target) || state.directories.has(target) || state.symlinks.has(target);
      },
      lstatSync(target) {
        if (state.symlinks.has(target)) return { isSymbolicLink: () => true, isDirectory: () => true };
        if (state.directories.has(target)) return { isSymbolicLink: () => false, isDirectory: () => true };
        throw missing();
      },
      mkdirSync(target) {
        state.mkdir.push(target);
        if (!state.roots.has(path.win32.parse(target).root)) throw missing();
        if (state.denied) throw Object.assign(new Error('fixture access denied'), { code: 'EACCES' });
        state.directories.add(target);
      },
      statSync: target => ({ isDirectory: () => state.directories.has(target) }),
    },
    IS_WIN: isWin, PROFILE: { kind }, SESSIONS_DB: 'C:\\fixture\\sessions.db',
    sqliteQuery: async () => { state.queries++; return state.rows; },
    sessionPayloadExists: (_, id) => !state.missingPayloads.has(id),
    log: message => state.logs.push(message),
  });
  vm.runInContext(source.slice(start, end), context);
  return { state, tick: () => context.repairMissingSessionWorkspaces() };
}

test('missing volumes never trigger mkdir and log only once per root across repair ticks', async () => {
  const h = harness();
  h.state.rows.push({ id: 'fixture-c', cwd: 'H:\\fixture\\project-c' });
  for (let tick = 0; tick < 3; tick++) {
    const result = await h.tick();
    assert.equal(result.repaired.length, 0);
    assert.equal(result.skipped, 3);
  }
  assert.deepEqual(h.state.mkdir, []);
  assert.equal(h.state.logs.length, 2);
  for (const root of ['G:\\', 'H:\\']) {
    assert.equal(h.state.logs.filter(message => message.endsWith(root)).length, 1);
  }
  assert.ok(h.state.logs.every(message => !message.includes('fixture') && !message.includes('project')));
});

test('repair resumes when a missing drive returns without restarting the daemon', async () => {
  const h = harness();
  await h.tick();
  h.state.roots.add('G:\\');
  const result = await h.tick();
  assert.deepEqual(Array.from(result.repaired), h.state.rows.map(row => row.cwd));
  assert.equal(result.skipped, 0);
  assert.ok(h.state.rows.every(row => h.state.directories.has(row.cwd)));
  h.state.directories.clear();
  h.state.roots.clear();
  await h.tick();
  assert.equal(h.state.logs.filter(message => message.includes('所在卷不存在')).length, 1);
});

test('missing UNC shares are skipped and can recover on a later repair tick', async () => {
  const h = harness();
  const cwd = '\\\\fixture-host\\fixture-share\\workspace\\project';
  h.state.rows = [{ id: 'fixture-unc', cwd }];
  await h.tick();
  await h.tick();
  assert.deepEqual(h.state.mkdir, []);
  assert.equal(h.state.logs.length, 1);
  assert.ok(!h.state.logs[0].includes('workspace'));
  h.state.roots.add(path.win32.parse(cwd).root);
  assert.deepEqual(Array.from((await h.tick()).repaired), [cwd]);
});

test('mounted-drive permission failures back off and recover without flooding logs or exposing paths', async () => {
  const h = harness();
  h.state.roots.add('G:\\');
  h.state.denied = true;
  for (let tick = 0; tick < 2; tick++) assert.equal((await h.tick()).skipped, 2);
  assert.equal(h.state.mkdir.length, 2);
  assert.equal(h.state.logs.length, 2);
  assert.ok(h.state.logs.every(message => !message.includes('fixture') && !message.includes('project')));
  assert.ok(h.state.logs.every(message => !message.includes('所在卷不存在')));
  h.state.now += 30000;
  await h.tick();
  assert.equal(h.state.mkdir.length, 4);
  assert.equal(h.state.logs.length, 2);
  h.state.denied = false;
  h.state.now += 60000;
  assert.equal((await h.tick()).repaired.length, 2);
  h.state.directories.clear();
  h.state.denied = true;
  await h.tick();
  assert.equal(h.state.logs.filter(message => message.includes('EACCES')).length, 4, 'a recovered path starts a fresh failure episode');
});

test('existing directories and sessions without stored payloads are never recreated', async () => {
  const h = harness();
  h.state.roots.add('G:\\');
  h.state.directories.add(h.state.rows[0].cwd);
  h.state.missingPayloads.add(h.state.rows[1].id);
  assert.equal((await h.tick()).skipped, 2);
  assert.deepEqual(h.state.mkdir, []);
  assert.deepEqual(h.state.logs, []);
});

test('repair backoff is capped and deleting a session clears its failure episode', async () => {
  const h = harness();
  h.state.rows = [h.state.rows[0]];
  const rows = h.state.rows;
  h.state.roots.add('G:\\'); h.state.denied = true;
  await h.tick();
  let attempts = 1;
  for (const delay of [30000, 60000, 120000, 240000, 300000, 300000]) {
    h.state.now += delay - 1; await h.tick();
    assert.equal(h.state.mkdir.length, attempts);
    h.state.now++; await h.tick();
    assert.equal(h.state.mkdir.length, ++attempts);
  }
  assert.equal(h.state.logs.length, 1);
  h.state.rows = []; await h.tick();
  h.state.rows = rows; await h.tick();
  assert.equal(h.state.mkdir.length, attempts + 1);
  assert.equal(h.state.logs.length, 2);
});

test('a payload-less session sharing a failed workspace cannot reset its backoff', async () => {
  const h = harness();
  h.state.rows[1].cwd = h.state.rows[0].cwd;
  h.state.missingPayloads.add(h.state.rows[1].id);
  h.state.roots.add('G:\\'); h.state.denied = true;
  await h.tick(); await h.tick();
  assert.equal(h.state.mkdir.length, 1);
  assert.equal(h.state.logs.length, 1);
  h.state.missingPayloads.add(h.state.rows[0].id);
  await h.tick();
  h.state.missingPayloads.clear(); await h.tick();
  assert.equal(h.state.mkdir.length, 2);
  assert.equal(h.state.logs.length, 2);
});

test('cwd repair still rejects symbolic-link ancestors on a mounted drive', async () => {
  const h = harness();
  h.state.roots.add('G:\\');
  h.state.symlinks.add('G:\\fixture');
  for (let tick = 0; tick < 3; tick++) assert.equal((await h.tick()).skipped, 2);
  assert.deepEqual(h.state.mkdir, []);
  assert.equal(h.state.logs.length, 2);
  assert.ok(h.state.logs.every(message => message.includes('符号链接')));
});

test('non-Windows and CodeBuddy profiles never query or repair session cwd', async () => {
  for (const options of [{ isWin: false }, { kind: 'codebuddy' }]) {
    const h = harness(options);
    const result = await h.tick();
    assert.equal(result.skipped, 0);
    assert.equal(result.repaired.length, 0);
    assert.equal(h.state.queries, 0);
    assert.deepEqual(h.state.mkdir, []);
    assert.deepEqual(h.state.logs, []);
  }
});
