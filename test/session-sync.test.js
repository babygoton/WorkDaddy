'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readSnapshot, readSnapshotAsync, readSessionFingerprintAsync, readSessionQuickFingerprintAsync, compareSnapshots, applySnapshot, applySnapshotAsync } = require('../scripts/session-sync.js');

const message = (role, text) => ({ type: 'message', role, content: [{ type: 'text', text }] });
const base = [message('user', 'question'), message('assistant', 'answer')];
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-prefix-sync-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = id => path.join(root, 'projects', 'project', id + '.jsonl');
  const write = (id, records) => {
    fs.mkdirSync(path.dirname(file(id)), { recursive: true });
    fs.writeFileSync(file(id), records.map(value => JSON.stringify(value)).join('\n') + '\n');
  };
  return { root, file, write, read: id => readSnapshot(root, id, ['a', 'b', 'c']) };
}
test('session snapshots accept payloads larger than the former 64 MiB limit', t => {
  const f = fixture(t); f.write('a', base);
  const file = path.join(f.root, 'workspace', 'sessions', 'a', 'large.bin');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const size = 64 * 1024 * 1024 + 1;
  fs.writeFileSync(file, '');
  fs.truncateSync(file, size);
  const snapshot = f.read('a');
  assert.equal(snapshot.files.get('workspace/sessions/__session__/large.bin').bytes.length, size);
});

test('session snapshots accept more than 20,000 files', t => {
  const f = fixture(t); f.write('a', base);
  const directory = path.join(f.root, 'workspace', 'sessions', 'a');
  fs.mkdirSync(directory, { recursive: true });
  for (let i = 0; i <= 20000; i++) fs.writeFileSync(path.join(directory, 'file-' + i + '.bin'), '');
  const snapshot = f.read('a');
  assert.equal(snapshot.files.size, 20002);
});

test('same content skips; only a full prefix permits replacement, irrespective of mtime', t => {
  const f = fixture(t); f.write('a', base); f.write('b', base);
  assert.equal(compareSnapshots(f.read('a'), f.read('b')).kind, 'equal');
  f.write('b', [...base, message('user', 'next'), message('assistant', 'more')]);
  fs.utimesSync(f.file('b'), new Date(0), new Date(0));
  assert.equal(compareSnapshots(f.read('a'), f.read('b')).kind, 'right-extends');
  assert.equal(compareSnapshots(f.read('b'), f.read('a')).kind, 'left-extends');
  f.write('a', [...base, message('user', 'different')]);
  assert.equal(compareSnapshots(f.read('a'), f.read('b')).kind, 'conflict');
});

test('a transient target conflict is rechecked before it can become a branch', async t => {
  const f = fixture(t); f.write('a', base); f.write('b', base);
  const source = f.read('a');
  let reads = 0;
  const result = await require('../scripts/session-sync.js').selectTargetSnapshot(
    source,
    ['b'],
    async () => {
      reads++;
      if (reads === 1) {
        return {
          ...f.read('b'),
          records: [...source.records.slice(0, -1), 'transient-conflict'],
        };
      }
      return f.read('b');
    }
  );
  assert.equal(result.targetId, 'b');
  assert.equal(result.comparison.kind, 'equal');
  assert.ok(reads >= 2);
});

test('equal user messages cannot hide different replies, tools or attachments', t => {
  const f = fixture(t);
  for (const records of [
    [base[0], message('assistant', 'different answer')],
    [...base, { type: 'function_call_result', output: 'changed' }],
    [{ ...base[0], content: [{ type: 'image', url: 'different.png' }] }, base[1]],
  ]) {
    f.write('a', [...base, { type: 'function_call_result', output: 'original' }]); f.write('b', records);
    assert.equal(compareSnapshots(f.read('a'), f.read('b')).kind, 'conflict');
  }
});
test('only identity fields normalize; literal session IDs inside messages remain meaningful', t => {
  const f = fixture(t); f.write('a', base.map(v => ({ ...v, sessionId: 'a' })));
  f.write('b', base.map(v => ({ ...v, sessionId: 'b' })));
  assert.equal(compareSnapshots(f.read('a'), f.read('b')).kind, 'equal');
  f.write('a', [message('user', 'a')]); f.write('b', [message('user', 'b')]);
  assert.equal(compareSnapshots(f.read('a'), f.read('b')).kind, 'conflict');
});

test('activation-only session-meta records do not conflict across account copies', t => {
  const f = fixture(t);
  const stable = { type: 'session-meta', meta: { 'codebuddy.ai/hostKind': 'unopted' } };
  f.write('a', [{ ...stable, id: 'event-a', sessionId: 'a', timestamp: 100 }, ...base]);
  f.write('b', [{ ...stable, id: 'event-b', sessionId: 'b', timestamp: 200 }, ...base]);
  assert.equal(compareSnapshots(f.read('a'), f.read('b')).kind, 'equal');
});

test('an activation-only session-meta append does not become an imported continuation', t => {
  const f = fixture(t);
  const stable = { type: 'session-meta', meta: { 'codebuddy.ai/hostKind': 'unopted' } };
  f.write('a', base);
  f.write('b', [...base, { ...stable, id: 'event-b', sessionId: 'b', timestamp: 200 }]);
  assert.equal(compareSnapshots(f.read('b'), f.read('a')).kind, 'equal');
});
test('missing payload is repairable and symlinked files are skipped without following them', async t => {
  const f = fixture(t); f.write('a', base);
  assert.equal(compareSnapshots(f.read('a'), f.read('b')).kind, 'left-extends');
  for (const text of ['', '{broken\n']) {
    fs.writeFileSync(f.file('b'), text); assert.throws(() => f.read('b'));
  }
  fs.unlinkSync(f.file('b')); fs.symlinkSync(f.file('a'), f.file('b'));
  assert.equal(f.read('b').files.size, 0);

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-sync-link-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.unlinkSync(f.file('b'));
  f.write('b', base);
  const sourceDir = path.join(f.root, 'workspace', 'sessions', 'a');
  const targetDir = path.join(f.root, 'workspace', 'sessions', 'b');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'keep.bin'), 'keep');
  fs.writeFileSync(path.join(outside, 'secret.bin'), 'secret');
  fs.symlinkSync(path.join(outside, 'secret.bin'), path.join(sourceDir, 'link.bin'));
  const source = await readSnapshotAsync(f.root, 'a', ['a', 'b']);
  assert.equal(source.files.has('workspace/sessions/__session__/keep.bin'), true);
  assert.equal(source.files.has('workspace/sessions/__session__/link.bin'), false);
  await applySnapshotAsync(source, await readSnapshotAsync(f.root, 'b', ['a', 'b']), { backupRoot: path.join(f.root, 'backups') });
  assert.equal(fs.readFileSync(path.join(targetDir, 'keep.bin'), 'utf8'), 'keep');
  assert.equal(fs.existsSync(path.join(targetDir, 'link.bin')), false);
});

test('configured data root may be a directory junction while child links are skipped', async t => {
  const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-sync-real-'));
  const linkedRoot = path.join(os.tmpdir(), 'wd-sync-root-' + require('node:crypto').randomUUID());
  t.after(() => {
    fs.rmSync(linkedRoot, { recursive: true, force: true });
    fs.rmSync(realRoot, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(realRoot, 'projects', 'project'), { recursive: true });
  fs.writeFileSync(path.join(realRoot, 'projects', 'project', 'a.jsonl'), JSON.stringify(base[0]) + '\n');
  fs.symlinkSync(realRoot, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(readSnapshot(linkedRoot, 'a', ['a']).records.length, 1);
  assert.equal((await readSnapshotAsync(linkedRoot, 'a', ['a'])).records.length, 1);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-sync-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(path.join(realRoot, 'tasks'), { recursive: true });
  fs.symlinkSync(outside, path.join(realRoot, 'tasks', 'a'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(readSnapshot(linkedRoot, 'a', ['a']).records.length, 1);
  assert.equal((await readSnapshotAsync(linkedRoot, 'a', ['a'])).records.length, 1);
  await readSessionFingerprintAsync(linkedRoot, 'a');
  await readSessionQuickFingerprintAsync(linkedRoot, 'a');
});

test('snapshots exclude local modify backups from workspace sessions', async t => {
  const f = fixture(t); f.write('a', base);
  const sessionRoot = path.join(f.root, 'workspace', 'sessions', 'a');
  fs.mkdirSync(path.join(sessionRoot, 'modify_backup'), { recursive: true });
  fs.mkdirSync(path.join(sessionRoot, '.modify_backup_meta'), { recursive: true });
  fs.writeFileSync(path.join(sessionRoot, 'keep.bin'), 'keep');
  fs.writeFileSync(path.join(sessionRoot, 'modify_backup', '12.m.a1b2c3.original'), 'ignored backup');
  fs.writeFileSync(path.join(sessionRoot, '.modify_backup_meta', 'meta.json'), 'ignored metadata');
  for (const read of [
    id => readSnapshot(f.root, id, ['a']),
    id => readSnapshotAsync(f.root, id, ['a']),
  ]) {
    const snapshot = await read('a');
    assert.equal(snapshot.totalBytes, 4 + Buffer.byteLength(JSON.stringify(base[0]) + '\n' + JSON.stringify(base[1]) + '\n'));
    assert.ok(snapshot.files.has('workspace/sessions/__session__/keep.bin'));
    assert.equal([...snapshot.files.keys()].some(key => key.includes('modify_backup')), false);
  }
});

test('session fingerprints ignore local modify backups but change for managed entries', async t => {
  const f = fixture(t); f.write('a', base);
  const sessionRoot = path.join(f.root, 'workspace', 'sessions', 'a');
  fs.mkdirSync(path.join(sessionRoot, 'modify_backup'), { recursive: true });
  const before = await readSessionFingerprintAsync(f.root, 'a');
  fs.writeFileSync(path.join(sessionRoot, 'modify_backup', '1.m.hash.original'), 'local backup');
  assert.equal(await readSessionFingerprintAsync(f.root, 'a'), before);
  fs.writeFileSync(path.join(sessionRoot, 'keep.bin'), 'managed');
  assert.notEqual(await readSessionFingerprintAsync(f.root, 'a'), before);
});

test('async snapshots stream large transcripts and publication keeps the event loop responsive', async t => {
  const f = fixture(t);
  const payload = 'x'.repeat(64 * 1024);
  const records = Array.from({ length: 256 }, (_, index) => message(index % 2 ? 'assistant' : 'user', payload + index));
  f.write('a', records);
  f.write('b', records.slice(0, 128));
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 0);
  try {
    const source = await readSnapshotAsync(f.root, 'a', ['a', 'b', 'c']);
    const target = await readSnapshotAsync(f.root, 'b', ['a', 'b', 'c']);
    const synchronous = readSnapshot(f.root, 'a', ['a', 'b', 'c']);
    assert.deepEqual(source.records, synchronous.records);
    assert.equal(source.files.get(source.transcriptKey).semantic, synchronous.files.get(synchronous.transcriptKey).semantic);
    assert.equal(compareSnapshots(source, target).kind, 'left-extends');
    await applySnapshotAsync(source, target, { backupRoot: path.join(f.root, 'backups') });
    assert.equal(compareSnapshots(
      await readSnapshotAsync(f.root, 'a', ['a', 'b', 'c']),
      await readSnapshotAsync(f.root, 'b', ['a', 'b', 'c'])
    ).kind, 'equal');
  } finally {
    clearInterval(timer);
  }
  assert.ok(ticks > 0, 'large sync must yield to daemon HTTP and renderer work');
});

test('async publication rolls back commit failures without overwriting concurrent official writes', async t => {
  const f = fixture(t);
  f.write('a', [...base, message('user', 'continued')]);
  f.write('b', base);
  const original = fs.readFileSync(f.file('b'));
  await assert.rejects(applySnapshotAsync(
    await readSnapshotAsync(f.root, 'a', ['a', 'b', 'c']),
    await readSnapshotAsync(f.root, 'b', ['a', 'b', 'c']),
    { backupRoot: path.join(f.root, 'backups'), commit: async () => { throw Error('DB failure'); } }
  ), /DB failure/);
  assert.deepEqual(fs.readFileSync(f.file('b')), original);

  await assert.rejects(applySnapshotAsync(
    await readSnapshotAsync(f.root, 'a', ['a', 'b', 'c']),
    await readSnapshotAsync(f.root, 'b', ['a', 'b', 'c']),
    { backupRoot: path.join(f.root, 'backups'), commit: async verifyPublished => {
      f.write('b', [...base, message('user', 'official write')]);
      await verifyPublished();
    } }
  ), /目标会话正在变化/);
  assert.match(fs.readFileSync(f.file('b'), 'utf8'), /official write/);
});
test('equal messages repair missing supporting files but conflicting supporting files are preserved', t => {
  const f = fixture(t); f.write('a', base); f.write('b', base);
  const aux = id => path.join(f.root, 'tasks', id, 'file.txt');
  fs.mkdirSync(path.dirname(aux('a')), { recursive: true }); fs.writeFileSync(aux('a'), 'original');
  assert.equal(compareSnapshots(f.read('a'), f.read('b')).kind, 'repair');
  fs.mkdirSync(path.dirname(aux('b')), { recursive: true }); fs.writeFileSync(aux('b'), 'different');
  assert.equal(compareSnapshots(f.read('a'), f.read('b')).kind, 'conflict');
});
test('update retains a backup, validates bytes, and never changes a third copy', async t => {
  const f = fixture(t); f.write('a', base); f.write('b', [...base, message('user', 'next')]); f.write('c', base);
  const original = fs.readFileSync(f.file('a')); let committed = false;
  const result = await applySnapshot(f.read('b'), f.read('a'), {
    backupRoot: path.join(f.root, 'backups'), metadata: { id: 'a', title: 'old' },
    commit: async () => { committed = true; },
  });
  assert.equal(committed, true);
  assert.deepEqual(fs.readFileSync(f.file('a')), fs.readFileSync(f.file('b')));
  assert.deepEqual(fs.readFileSync(f.file('c')), original);
  assert.deepEqual(fs.readFileSync(path.join(result.backup, 'files', 'projects', 'project', '__session__.jsonl')), original);
});
test('failed commit restores target bytes; source changes abort before publication', async t => {
  const f = fixture(t); f.write('a', base); f.write('b', [...base, message('user', 'next')]);
  const original = fs.readFileSync(f.file('a'));
  await assert.rejects(applySnapshot(f.read('b'), f.read('a'), {
    backupRoot: path.join(f.root, 'backups'), commit: async () => { throw Error('DB failure'); },
  }), /DB failure/);
  assert.deepEqual(fs.readFileSync(f.file('a')), original);
  const source = f.read('b'); f.write('b', [...base, message('user', 'changed while copying')]);
  await assert.rejects(applySnapshot(source, f.read('a'), { backupRoot: path.join(f.root, 'backups') }), /变化/);
  assert.deepEqual(fs.readFileSync(f.file('a')), original);
});
test('rollback preserves concurrent official writes instead of replacing them with old bytes', async t => {
  const f = fixture(t); f.write('a', base); f.write('b', [...base, message('user', 'next')]);
  await assert.rejects(applySnapshot(f.read('b'), f.read('a'), {
    backupRoot: path.join(f.root, 'backups'), commit: async () => {
      f.write('a', [...base, message('user', 'official new content')]); throw Error('concurrent update');
    },
  }), /concurrent update/);
  assert.match(fs.readFileSync(f.file('a'), 'utf8'), /official new content/);
});
test('a change to any target file during the final async check prevents metadata commit', async t => {
  const f = fixture(t); f.write('a', base); f.write('b', [...base, message('user', 'next')]);
  let committed = false;
  await assert.rejects(applySnapshot(f.read('b'), f.read('a'), {
    backupRoot: path.join(f.root, 'backups'), commit: async verifyPublished => {
      const extra = path.join(f.root, 'tasks', 'a', 'new.txt');
      fs.mkdirSync(path.dirname(extra), { recursive: true }); fs.writeFileSync(extra, 'official write');
      verifyPublished(); committed = true;
    },
  }), /目标会话正在变化/);
  assert.equal(committed, false);
  assert.match(fs.readFileSync(path.join(f.root, 'tasks', 'a', 'new.txt'), 'utf8'), /official write/);
  assert.equal(f.read('a').records.length, base.length);
});
test('failure to finalize a committed backup journal must never roll back committed files', async t => {
  const f = fixture(t); f.write('a', base); f.write('b', [...base, message('user', 'next')]);
  const backupRoot = path.join(f.root, 'backups');
  await applySnapshot(f.read('b'), f.read('a'), {
    backupRoot, commit: async () => {
      const journal = path.join(backupRoot, fs.readdirSync(backupRoot)[0], 'journal.json');
      fs.unlinkSync(journal); fs.mkdirSync(journal);
    },
  });
  assert.deepEqual(fs.readFileSync(f.file('a')), fs.readFileSync(f.file('b')));
});
test('sync remaps artifact ownership and preserves foreign owners and request IDs', async t => {
  const f = fixture(t); f.write('a', base);
  fs.mkdirSync(path.join(f.root, 'artifact-index'));
  fs.writeFileSync(path.join(f.root, 'artifact-index', 'a.json'), JSON.stringify({ artifacts: [
    { requestId: 'request-42', _meta: { ownerConversationId: 'a' } },
    { requestId: 'foreign-42', _meta: { ownerConversationId: 'foreign' } },
  ] }));
  await applySnapshot(f.read('a'), f.read('b'), { backupRoot: path.join(f.root, 'backups') });
  const artifacts = JSON.parse(fs.readFileSync(path.join(f.root, 'artifact-index', 'b.json'))).artifacts;
  assert.deepEqual(artifacts, [
    { requestId: 'request-42', _meta: { ownerConversationId: 'b' } },
    { requestId: 'foreign-42', _meta: { ownerConversationId: 'foreign' } },
  ]);
  assert.equal(compareSnapshots(f.read('a'), f.read('b')).kind, 'equal');
});

test('workspace and history JSON files are opaque work products, not conversation metadata', async t => {
  const f = fixture(t); f.write('a', base);
  const files = [
    ['workspace/sessions', 'settings.json', Buffer.from('// editor settings may use comments\n{"enabled":true,}\n')],
    ['workspace/sessions', 'unfinished.json', Buffer.from('{"draft":')],
    ['workspace/sessions', 'empty.json', Buffer.alloc(0)],
    ['file-history', 'snapshot.json', Buffer.from([0, 255, 254, 1])],
    ['projects/project', 'notes.json', Buffer.from('This is a work product, not a message record')],
  ];
  for (const [prefix, name, bytes] of files) {
    const file = path.join(f.root, prefix, 'a', name);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
  }
  const source = f.read('a');
  assert.equal(compareSnapshots(source, f.read('b')).kind, 'left-extends');
  await applySnapshot(source, f.read('b'), { backupRoot: path.join(f.root, 'backups') });
  for (const [prefix, name, bytes] of files) assert.deepEqual(fs.readFileSync(path.join(f.root, prefix, 'b', name)), bytes);
  assert.equal(compareSnapshots(f.read('a'), f.read('b')).kind, 'equal');
  fs.writeFileSync(path.join(f.root, 'workspace/sessions/b/unfinished.json'), '{"different":');
  assert.equal(compareSnapshots(f.read('a'), f.read('b')).kind, 'conflict');
});

test('JSON work product fields must not be normalized as session identity', t => {
  const f = fixture(t); f.write('a', base); f.write('b', base);
  for (const id of ['a', 'b']) {
    const file = path.join(f.root, 'workspace/sessions', id, 'data.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ sessionId: id, conversationId: id }));
  }
  assert.equal(compareSnapshots(f.read('a'), f.read('b')).kind, 'conflict');
});

test('malformed official artifact index still blocks sync and names the failing index', t => {
  const f = fixture(t); f.write('a', base);
  fs.mkdirSync(path.join(f.root, 'artifact-index'));
  fs.writeFileSync(path.join(f.root, 'artifact-index/a.json'), '{broken');
  assert.throws(() => f.read('a'), /会话产物索引损坏，未同步/);
});

test('fingerprint cache reuses hashes for unchanged files and reloads changed ones', async t => {
  const f = fixture(t); f.write('a', base); f.write('b', [...base, message('user', 'continued')]);
  const cache = new Map();
  const first = readSnapshot(f.root, 'a', ['a', 'b', 'c'], cache);
  assert.ok(cache.size > 0);
  // A cache hit defers payload reads: bytes arrive through a lazy getter.
  const second = readSnapshot(f.root, 'a', ['a', 'b', 'c'], cache);
  const transcript = second.files.get('projects/project/__session__.jsonl');
  assert.equal(typeof Object.getOwnPropertyDescriptor(transcript, 'bytes').get, 'function');
  assert.deepEqual(second.records, first.records);
  assert.equal(compareSnapshots(second, readSnapshot(f.root, 'b', ['a', 'b', 'c'], cache)).kind, 'right-extends');
  // Alias-dependent semantics are recomputed when the alias set changes.
  const otherAliases = readSnapshot(f.root, 'a', ['a', 'b', 'c', 'd'], cache);
  assert.notEqual(otherAliases.files.get('projects/project/__session__.jsonl').semanticAliases.length, 0);
  // Changed content invalidates the fingerprint and is re-read.
  f.write('a', [...base, message('assistant', 'updated')]);
  const changed = readSnapshot(f.root, 'a', ['a', 'b', 'c'], cache);
  assert.equal(changed.records.length, first.records.length + 1);
  assert.notEqual(changed.files.get('projects/project/__session__.jsonl').hash, first.files.get('projects/project/__session__.jsonl').hash);
});

test('cached snapshots still drive copy, race checks and rollback', async t => {
  const f = fixture(t); f.write('a', [...base, message('user', 'continued')]); f.write('b', base);
  const cache = new Map();
  readSnapshot(f.root, 'a', ['a', 'b', 'c'], cache);
  readSnapshot(f.root, 'b', ['a', 'b', 'c'], cache);
  const source = readSnapshot(f.root, 'a', ['a', 'b', 'c'], cache);
  const target = readSnapshot(f.root, 'b', ['a', 'b', 'c'], cache);
  assert.equal(compareSnapshots(source, target).kind, 'left-extends');
  await applySnapshot(source, target, { backupRoot: path.join(f.root, 'backups') });
  assert.deepEqual(fs.readFileSync(f.file('b')), fs.readFileSync(f.file('a')));
  assert.equal(compareSnapshots(readSnapshot(f.root, 'a', ['a', 'b', 'c'], cache), readSnapshot(f.root, 'b', ['a', 'b', 'c'], cache)).kind, 'equal');
});
