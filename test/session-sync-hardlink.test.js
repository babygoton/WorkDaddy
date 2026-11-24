'use strict';
// Hard-linked publication for immutable session payloads (file-history).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { readSnapshot, readSnapshotAsync, applySnapshot, applySnapshotAsync } = require('../scripts/session-sync');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-link-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const transcript = id => path.join(root, 'projects', 'p', id + '.jsonl');
  const history = (id, name) => path.join(root, 'file-history', id, name);
  const writeTranscript = (id, text) => {
    fs.mkdirSync(path.dirname(transcript(id)), { recursive: true });
    fs.writeFileSync(transcript(id), JSON.stringify({ type: 'message', role: 'user', content: [{ text }] }) + '\n');
  };
  const writeHistory = (id, name, bytes) => {
    fs.mkdirSync(path.dirname(history(id, name)), { recursive: true });
    fs.writeFileSync(history(id, name), bytes);
  };
  return { root, transcript, history, writeTranscript, writeHistory, backups: path.join(root, 'backups') };
}

const payload = Buffer.alloc(64 * 1024, 7);

test('file-history snapshots are published as a hard link, not copied', async t => {
  const f = fixture(t);
  f.writeTranscript('a', 'hello');
  f.writeTranscript('b', 'hello');
  f.writeHistory('a', 'snap.bin', payload);

  const result = await applySnapshot(readSnapshot(f.root, 'a'), readSnapshot(f.root, 'b'), { backupRoot: f.backups });

  assert.equal(result.linkedBytes, payload.length);
  assert.equal(result.copiedBytes, 0, 'a linked file must not be reported as copied bytes');
  const source = fs.statSync(f.history('a', 'snap.bin'));
  const target = fs.statSync(f.history('b', 'snap.bin'));
  assert.equal(target.ino, source.ino, 'both accounts must share one inode');
  assert.equal(target.nlink, 2);
  assert.deepEqual(fs.readFileSync(f.history('b', 'snap.bin')), payload);
});

test('async publication links the same inode and reports it apart from copied bytes', async t => {
  const f = fixture(t);
  f.writeTranscript('a', 'hello');
  f.writeTranscript('b', 'hello');
  f.writeHistory('a', 'snap.bin', payload);
  const linked = [];
  const copied = [];

  const result = await applySnapshotAsync(await readSnapshotAsync(f.root, 'a'), await readSnapshotAsync(f.root, 'b'), {
    backupRoot: f.backups,
    onLink: event => linked.push(event.bytes),
    onProgress: event => copied.push(event.bytes),
  });

  assert.equal(result.linkedBytes, payload.length);
  assert.equal(result.copiedBytes, 0);
  assert.deepEqual(linked, [payload.length]);
  assert.deepEqual(copied, []);
  assert.equal(fs.statSync(f.history('b', 'snap.bin')).ino, fs.statSync(f.history('a', 'snap.bin')).ino);
});

test('WORKDADDY_SYNC_NO_LINK=1 keeps the byte copy path', async t => {
  const f = fixture(t);
  f.writeTranscript('a', 'hello');
  f.writeTranscript('b', 'hello');
  f.writeHistory('a', 'snap.bin', payload);
  process.env.WORKDADDY_SYNC_NO_LINK = '1';
  t.after(() => { delete process.env.WORKDADDY_SYNC_NO_LINK; });

  const result = await applySnapshot(readSnapshot(f.root, 'a'), readSnapshot(f.root, 'b'), { backupRoot: f.backups });

  assert.equal(result.copiedBytes, payload.length);
  assert.equal(result.linkedBytes, 0);
  assert.notEqual(fs.statSync(f.history('b', 'snap.bin')).ino, fs.statSync(f.history('a', 'snap.bin')).ino);
  assert.deepEqual(fs.readFileSync(f.history('b', 'snap.bin')), payload);
});

test('a volume that rejects hard links silently falls back to a byte copy', async t => {
  const f = fixture(t);
  f.writeTranscript('a', 'hello');
  f.writeTranscript('b', 'hello');
  f.writeHistory('a', 'snap.bin', payload);
  const original = fs.linkSync;
  fs.linkSync = () => { const error = new Error('EPERM: operation not permitted'); error.code = 'EPERM'; throw error; };
  t.after(() => { fs.linkSync = original; });

  const result = await applySnapshot(readSnapshot(f.root, 'a'), readSnapshot(f.root, 'b'), { backupRoot: f.backups });

  assert.equal(result.copiedBytes, payload.length);
  assert.equal(result.linkedBytes, 0);
  assert.deepEqual(fs.readFileSync(f.history('b', 'snap.bin')), payload, 'the fallback still publishes the exact bytes');
});

test('a target that was replaced independently is republished instead of conflicting', async t => {
  const f = fixture(t);
  f.writeTranscript('a', 'hello');
  f.writeTranscript('b', 'hello');
  f.writeHistory('a', 'snap.bin', payload);
  const options = { backupRoot: f.backups };
  await applySnapshot(readSnapshot(f.root, 'a'), readSnapshot(f.root, 'b'), options);
  // Official-side replacement: a new inode with different bytes.
  fs.unlinkSync(f.history('b', 'snap.bin'));
  fs.writeFileSync(f.history('b', 'snap.bin'), Buffer.from('diverged'));

  const result = await applySnapshot(readSnapshot(f.root, 'a'), readSnapshot(f.root, 'b'), options);

  assert.equal(result.copied, 1);
  assert.deepEqual(fs.readFileSync(f.history('b', 'snap.bin')), payload);
  assert.equal(fs.statSync(f.history('b', 'snap.bin')).ino, fs.statSync(f.history('a', 'snap.bin')).ino);
});

test('rollback restores the previous bytes when publication fails', async t => {
  const f = fixture(t);
  f.writeTranscript('a', 'hello');
  f.writeTranscript('b', 'hello');
  f.writeHistory('a', 'snap.bin', payload);
  const previous = Buffer.from('previous snapshot');
  f.writeHistory('b', 'snap.bin', previous);

  await assert.rejects(
    applySnapshot(readSnapshot(f.root, 'a'), readSnapshot(f.root, 'b'), {
      backupRoot: f.backups,
      commit: async () => { throw Error('publication rejected'); },
    }),
    /publication rejected/
  );
  assert.deepEqual(fs.readFileSync(f.history('b', 'snap.bin')), previous);
});
