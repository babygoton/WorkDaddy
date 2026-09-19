'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');
function helpers(fsImpl = fs, log = () => {}) {
  const ctx = { fs: fsImpl, path, log, crypto: require('node:crypto'), Buffer };
  vm.runInNewContext(source.slice(source.indexOf('async function copySessionFiles('), source.indexOf('// Yield between session pairs')), ctx);
  return ctx;
}
test('copied delivered artifacts retain official ownership visibility and original timestamps', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-artifact-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'artifact-index'));
  const file = path.join(dir, 'artifact-index', 'source.json');
  const artifact = { id: 'file-1', kind: 'media', uri: '/outside/report.pdf', requestId: 'protocol-42', _meta: { sourceTool: 'PresentFiles', ownerConversationId: 'source' } };
  fs.writeFileSync(file, JSON.stringify({ version: 1, artifacts: [artifact, { ...artifact, id: 'foreign', _meta: { ...artifact._meta, ownerConversationId: 'foreign' } }] }));
  const old = new Date('2026-01-01'); fs.utimesSync(file, old, old);
  const { copySessionFiles, sessionContentMtime } = helpers();
  const result = await copySessionFiles(dir, 'source', 'target');
  assert.equal(result.failed, 0);
  const copied = JSON.parse(fs.readFileSync(path.join(dir, 'artifact-index', 'target.json'))).artifacts;
  // Official ConversationImpl.filterArtifactsOwnedByConversation requires this exact owner
  // for PresentFiles outside the workspace. Request IDs and file URIs must stay intact.
  assert.equal(copied[0]._meta.ownerConversationId, 'target');
  assert.equal(copied[0].requestId, artifact.requestId);
  assert.equal(copied[0].uri, artifact.uri);
  assert.equal(copied[1]._meta.ownerConversationId, 'foreign');
  assert.equal(JSON.parse(fs.readFileSync(file)).artifacts[0]._meta.ownerConversationId, 'source');
  assert.equal(sessionContentMtime(dir, 'target'), sessionContentMtime(dir, 'source'));
  await copySessionFiles(dir, 'target', 'source');
  assert.equal(JSON.parse(fs.readFileSync(file)).artifacts[0]._meta.ownerConversationId, 'source');
});

test('legacy copies repair owners from their known lineage, including the newest copy itself', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-artifact-legacy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'artifact-index'));
  const file = path.join(dir, 'artifact-index', 'copy-b.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, artifacts: [{ id: 'a', _meta: { ownerConversationId: 'original-a' } }, { id: 'foreign', _meta: { ownerConversationId: 'unrelated' } }] }));
  const helpers_ = helpers();
  assert.equal((await helpers_.copySessionFiles(dir, 'copy-b', 'copy-b', ['original-a', 'copy-b'])).failed, 0);
  assert.equal(JSON.parse(fs.readFileSync(file)).artifacts[0]._meta.ownerConversationId, 'copy-b');
  await helpers_.copySessionFiles(dir, 'copy-b', 'copy-c', ['original-a', 'copy-b']);
  const copied = JSON.parse(fs.readFileSync(path.join(dir, 'artifact-index', 'copy-c.json')));
  assert.equal(copied.artifacts[0]._meta.ownerConversationId, 'copy-c');
  assert.equal(copied.artifacts[1]._meta.ownerConversationId, 'unrelated');
});

test('malformed index preserves the target and reports a failed copy', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-artifact-invalid-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'artifact-index'));
  fs.writeFileSync(path.join(dir, 'artifact-index', 'source.json'), '{bad');
  const target = path.join(dir, 'artifact-index', 'target.json');
  fs.writeFileSync(target, '{"version":1,"artifacts":[]}');
  const result = await helpers().copySessionFiles(dir, 'source', 'target');
  assert.equal(result.failed, 1);
  assert.equal(fs.readFileSync(target, 'utf8'), '{"version":1,"artifacts":[]}');
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['source.json', 'target.json']);
});

test('copying messages retains source times so copying cannot become the freshest edit', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-copy-times-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'projects', 'project'), { recursive: true });
  const file = path.join(dir, 'projects', 'project', 'source.jsonl');
  fs.writeFileSync(file, '{"fixture":true}\n');
  const old = new Date('2026-01-01'); fs.utimesSync(file, old, old);
  const h = helpers(); await h.copySessionFiles(dir, 'source', 'target');
  assert.equal(h.sessionContentMtime(dir, 'source'), h.sessionContentMtime(dir, 'target'));
});

test('repairing a legacy source preserves a concurrent official artifact update', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-artifact-race-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'artifact-index'));
  const file = path.join(dir, 'artifact-index', 'copy.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, artifacts: [{ id: 'old', _meta: { ownerConversationId: 'source' } }] }));
  const updated = JSON.stringify({ version: 1, artifacts: [{ id: 'new', _meta: { ownerConversationId: 'copy' } }] });
  const fsImpl = { ...fs, promises: { ...fs.promises, async utimes(...args) {
    await fs.promises.utimes(...args); fs.writeFileSync(file, updated);
  } } };
  const result = await helpers(fsImpl).copySessionFiles(dir, 'copy', 'copy', ['source']);
  assert.equal(result.failed, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), updated);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['copy.json']);
});

test('unparseable artifact contents never appear in copy diagnostics', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-artifact-redacted-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'artifact-index'));
  fs.writeFileSync(path.join(dir, 'artifact-index', 'source.json'), 'private-fixture-do-not-log');
  const logs = [];
  await helpers(fs, value => logs.push(value)).copySessionFiles(dir, 'source', 'target');
  assert.doesNotMatch(logs.join('\n'), /private-fixture/);
  assert.match(logs.join('\n'), /格式不受支持/);
});
