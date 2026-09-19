'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readSnapshot, compareSnapshots, applySnapshot } = require('../scripts/session-sync.js');

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
test('missing payload is repairable but empty, corrupt and symlinked files fail closed', t => {
  const f = fixture(t); f.write('a', base);
  assert.equal(compareSnapshots(f.read('a'), f.read('b')).kind, 'left-extends');
  for (const text of ['', '{broken\n']) {
    fs.writeFileSync(f.file('b'), text); assert.throws(() => f.read('b'));
  }
  fs.unlinkSync(f.file('b')); fs.symlinkSync(f.file('a'), f.file('b'));
  assert.throws(() => f.read('b'), /符号链接/);
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
