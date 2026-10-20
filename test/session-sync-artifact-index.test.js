'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readSnapshot, compareSnapshots } = require('../scripts/session-sync.js');

const message = (role, text) => ({ type: 'message', role, content: [{ type: 'text', text }] });
const base = [message('user', 'question'), message('assistant', 'answer')];

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-artifact-index-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (id, records) => {
    const file = path.join(root, 'projects', 'project', id + '.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, records.map(value => JSON.stringify(value)).join('\n') + '\n');
  };
  const writeIndex = (id, value) => {
    const file = path.join(root, 'artifact-index', id + '.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };
  const writeSupporting = (directory, id, name, content) => {
    const file = path.join(root, directory, id, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  return { root, write, writeIndex, writeSupporting, read: id => readSnapshot(root, id, ['a', 'b']) };
}

// A conversation's artifact index stores which artifacts it has presented, plus a
// lastUpdated stamp and an artifact count. Both drift per account purely as a
// consequence of that account's own local present/open activity. Before this fix
// the resulting semantic mismatch was reported as a content conflict, and the
// daemon answered every conflict by allocating a brand-new physical session copy
// (crypto.randomUUID) in the target account — producing endless duplicates that
// survive every account switch.
test('artifact-index lastUpdated and artifact-count drift is not a content conflict', t => {
  const f = fixture(t);
  f.write('a', base);
  f.write('b', base);
  f.writeIndex('a', { version: 1, lastUpdated: 1000, artifacts: [{ id: 'x', uri: '/x' }] });
  f.writeIndex('b', {
    version: 1, lastUpdated: 2000,
    artifacts: [{ id: 'x', uri: '/x' }, { id: 'y', uri: '/y' }],
  });
  assert.equal(compareSnapshots(f.read('a'), f.read('b')).kind, 'equal');
});

test('identical conversations with identical artifact indexes still compare equal', t => {
  const f = fixture(t);
  f.write('a', base);
  f.write('b', base);
  const index = { version: 1, lastUpdated: 1000, artifacts: [{ id: 'x', uri: '/x' }] };
  f.writeIndex('a', index);
  f.writeIndex('b', index);
  assert.equal(compareSnapshots(f.read('a'), f.read('b')).kind, 'equal');
});

// The carve-out must stay narrow: a real divergence in the conversation payload
// still has to be reported, otherwise the fix would silently stop syncing.
test('divergent message payloads still conflict', t => {
  const f = fixture(t);
  f.write('a', [message('user', 'same'), message('assistant', 'same')]);
  f.write('b', [message('user', 'same'), message('assistant', 'different')]);
  const index = { version: 1, lastUpdated: 1000, artifacts: [] };
  f.writeIndex('a', index);
  f.writeIndex('b', index);
  assert.equal(compareSnapshots(f.read('a'), f.read('b')).kind, 'conflict');
});

test('transcript length differences still report an extension', t => {
  const f = fixture(t);
  f.write('a', base);
  f.write('b', base.concat([message('user', 'more'), message('assistant', 'more')]));
  const index = { version: 1, lastUpdated: 1000, artifacts: [] };
  f.writeIndex('a', index);
  f.writeIndex('b', index);
  assert.equal(compareSnapshots(f.read('a'), f.read('b')).kind, 'right-extends');
});

// Supporting files other than the artifact index must keep their conflict semantics.
test('divergent supporting files still conflict', t => {
  const f = fixture(t);
  f.write('a', base);
  f.write('b', base);
  const index = { version: 1, lastUpdated: 1000, artifacts: [] };
  f.writeIndex('a', index);
  f.writeIndex('b', index);
  f.writeSupporting('file-history', 'a', 'entry', 'alpha');
  f.writeSupporting('file-history', 'b', 'entry', 'beta');
  assert.equal(compareSnapshots(f.read('a'), f.read('b')).kind, 'conflict');
});
