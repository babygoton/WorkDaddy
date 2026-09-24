'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { readSessionSizes } = require('../scripts/session-sync');

test('session size counts only its complete sync payload, using metadata even for huge or invalid journals', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-sizes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = ['projects/p/a.jsonl', 'projects/p/a/sub/data', 'workspace/sessions/a/file', 'tasks/a/file', 'file-history/a/file', 'artifact-index/a.json'];
  for (const relative of [...files, 'projects/p/b.jsonl', 'unrelated/a']) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'bad json');
  }
  const huge = 2 * 1024 ** 3 + 1;
  fs.truncateSync(path.join(root, files[2]), huge);
  const result = await readSessionSizes(root, ['a', 'b', 'missing', '../escape']);
  assert.equal(result.get('a'), huge + 5 * 8);
  assert.equal(result.get('b'), 8);
  assert.equal(result.get('missing'), 0);
  assert.equal(result.get('../escape'), null);
});

test('symlinked paths are skipped, never followed or counted as payload sizes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-sizes-links-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'projects/p'), { recursive: true });
  fs.writeFileSync(path.join(root, 'projects/p/good.jsonl'), 'ok');
  fs.symlinkSync('good.jsonl', path.join(root, 'projects/p/link.jsonl'));
  const sizes = await readSessionSizes(root, ['good', 'link']);
  assert.equal(sizes.get('good'), 2); assert.equal(sizes.get('link'), 0);
  fs.symlinkSync(path.join(root, 'projects'), path.join(root, 'tasks'), 'dir');
  assert.equal((await readSessionSizes(root, ['good'])).get('good'), 2);
});

test('session size excludes local modify backups from workspace sessions', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-sizes-modify-backup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessionRoot = path.join(root, 'workspace', 'sessions', 'a');
  fs.mkdirSync(path.join(sessionRoot, 'modify_backup'), { recursive: true });
  fs.mkdirSync(path.join(sessionRoot, '.modify_backup_meta'), { recursive: true });
  fs.writeFileSync(path.join(sessionRoot, 'keep.bin'), 'keep');
  fs.writeFileSync(path.join(sessionRoot, 'modify_backup', '12.m.a1b2c3.original'), 'ignored backup');
  fs.writeFileSync(path.join(sessionRoot, '.modify_backup_meta', 'meta.json'), 'ignored metadata');
  assert.equal((await readSessionSizes(root, ['a'])).get('a'), 4);
});
