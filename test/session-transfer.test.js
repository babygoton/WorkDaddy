'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { writeSessionTransfer, readSessionTransfer, receiveSessionUpload } = require('../scripts/session-transfer');
const { Readable } = require('node:stream');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-stream-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const id = '11111111-1111-4111-8111-111111111111';
function archive(file, size) { return [{ record: { id, user_id: 'fixture-owner', title: 'fixture' }, files: [{ path: `tasks/${id}/large.bin`, source: file, size }] }]; }
async function hash(file) {
  const digest = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
test('a single attachment above 256 MiB exports and imports with exact bytes', async t => {
  const dir = fixture(t), file = path.join(dir, 'large.bin'), out = path.join(dir, 'export.wds');
  const size = 257 * 1024 * 1024 + 17;
  const fd = fs.openSync(file, 'w');
  fs.ftruncateSync(fd, size);
  fs.writeSync(fd, crypto.randomBytes(65536), 0, 65536, size - 65536); fs.closeSync(fd);
  await writeSessionTransfer(out, archive(file, size), 'fixture password');
  const restored = await readSessionTransfer(out, 'fixture password', path.join(dir, 'staged'));
  assert.equal(restored.sessions.length, 1);
  const entry = restored.sessions[0].files[0];
  assert.equal(entry.size, size);
  assert.equal(fs.statSync(entry.source).size, size);
  assert.equal(await hash(entry.source), await hash(file));
});
test('wrong passwords, tampering and truncated archives publish no extracted files', async t => {
  const dir = fixture(t), file = path.join(dir, 'file'), out = path.join(dir, 'export.wds');
  fs.writeFileSync(file, 'private fixture');
  await writeSessionTransfer(out, archive(file, fs.statSync(file).size), 'password');
  await assert.rejects(readSessionTransfer(out, 'wrong', path.join(dir, 'wrong')), /密码|损坏/);
  const original = fs.readFileSync(out), modified = Buffer.from(original); modified[modified.length - 1] ^= 1;
  fs.writeFileSync(out, modified);
  await assert.rejects(readSessionTransfer(out, 'password', path.join(dir, 'tampered')), /密码|损坏/);
  fs.writeFileSync(out, original.subarray(0, original.length - 1));
  await assert.rejects(readSessionTransfer(out, 'password', path.join(dir, 'truncated')), /密码|损坏/);
  for (const name of ['wrong', 'tampered', 'truncated']) assert.equal(fs.existsSync(path.join(dir, name)), false);
});
test('stream transport accepts fragmented metadata and binary body without text decoding', async t => {
  const dir = fixture(t), meta = Buffer.from(JSON.stringify({ password: '中文密码', targetUid: 'owner' }));
  const prefix = Buffer.alloc(4); prefix.writeUInt32BE(meta.length);
  const bytes = Buffer.from([0, 255, 128, 1]), wire = Buffer.concat([prefix, meta, bytes]);
  const chunks = Array.from(wire, byte => Buffer.from([byte]));
  const received = await receiveSessionUpload(Readable.from(chunks), dir);
  assert.equal(received.password, '中文密码');
  assert.deepEqual(fs.readFileSync(received.file), bytes);
  await assert.rejects(receiveSessionUpload(Readable.from([Buffer.from([255,255,255,255])]), dir), /元数据/);
});
test('export detects files changed after collection and removes partial output', async t => {
  const dir = fixture(t), file = path.join(dir, 'file'), out = path.join(dir, 'export.wds');
  fs.writeFileSync(file, 'changed');
  await assert.rejects(writeSessionTransfer(out, archive(file, 1), 'password'), /变化/);
  assert.equal(fs.existsSync(out), false);
});

test('real session export/import routes round-trip binary archives and retain ownership', async t => {
  const vm = require('node:vm'), http = require('node:http');
  const dir = fixture(t), home = path.join(dir, 'home');
  const original = path.join(home, 'tasks', id, '测试附件.bin');
  fs.mkdirSync(path.dirname(original), { recursive: true });
  fs.writeFileSync(original, crypto.randomBytes(100001));
  const source = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');
  const stored = [], records = [{ id, user_id: 'original-owner', title: 'fixture' }];
  const ctx = { fs, path, os, crypto, Buffer, ...require('../scripts/secure-transfer'),
    writeSessionTransfer, readSessionTransfer, receiveSessionUpload,
    transferPipeline: require('node:stream/promises').pipeline,
    PROFILE: { dataRoot: home }, MAX_SESSION_ID_LENGTH: 200,
    normalizeSessionIdBatch: require('../scripts/session-db').normalizeSessionIdBatch,
    sqliteQuery: async () => records, sqliteRun: async (sql, values) => stored.push(values),
    currentAccount: () => ({ uid: 'current-owner' }), log: () => {},
    deleteSessionFiles: (root, sessionId) => fs.rmSync(path.join(root, 'tasks', sessionId), { recursive: true, force: true }),
    readBody: async req => { const parts = []; for await (const c of req) parts.push(c); return JSON.parse(Buffer.concat(parts)); },
    json: (res, code, value) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); },
  };
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('const MAX_SESSION_EXPORT_FILES'), source.indexOf('async function copySessionRecord(')), ctx);
  const validStart = source.indexOf('function isValidSessionId(');
  vm.runInContext(source.slice(validStart, source.indexOf('\n}\n', validStart) + 2), ctx);
  const routeStart = source.indexOf("if (req.method === 'POST' && p === '/api/sessions/export')");
  vm.runInContext('function serve(req, res) { const p = req.url; ' + source.slice(routeStart, source.indexOf('  // 复制会话：POST /api/sessions/copy', routeStart)) + '\n}', ctx);
  const server = http.createServer((req, res) => ctx.serve(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = 'http://127.0.0.1:' + server.address().port;
  const exported = await fetch(base + '/api/sessions/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [id], password: '密码' }) });
  assert.equal(exported.status, 200);
  assert.equal(exported.headers.get('X-WorkDaddy-Count'), '1');
  assert.match(exported.headers.get('content-type'), /octet-stream/);
  const bytes = new Uint8Array(await exported.arrayBuffer());
  async function upload(password, targetUid) {
    const meta = Buffer.from(JSON.stringify({ password, targetUid })), prefix = Buffer.alloc(4); prefix.writeUInt32BE(meta.length);
    const response = await fetch(base + '/api/sessions/import', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Blob([prefix, meta, bytes]) });
    return { status: response.status, result: await response.json() };
  }
  assert.equal((await upload('wrong')).status, 400);
  assert.equal(stored.length, 0);
  const imported = await upload('密码');
  assert.equal(imported.status, 200);
  assert.equal(imported.result.count, 1);
  const newId = imported.result.imported[0].id;
  assert.notEqual(newId, id);
  assert.equal(stored[0][2], 'original-owner');
  assert.deepEqual(fs.readFileSync(path.join(home, 'tasks', newId, '测试附件.bin')), fs.readFileSync(original));
  assert.equal((await upload('密码', 'override-owner')).status, 200);
  assert.equal(stored[1][2], 'override-owner');
});

test('panel uses Blob responses/uploads and release includes the streaming module', () => {
  const daemon = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');
  const inject = fs.readFileSync(path.join(__dirname, '../scripts/inject.js'), 'utf8');
  const build = fs.readFileSync(path.join(__dirname, '../scripts/build-mac-dmg.sh'), 'utf8');
  assert.doesNotMatch(daemon, /MAX_SESSION_EXPORT_BYTES|附件超过 256/);
  assert.match(inject, /opts\.responseType === 'blob'[\s\S]*r\.blob\(\)/);
  assert.match(inject, /new Blob\(\[prefix, metadata, file\]/);
  assert.match(build, /session-transfer\.js/);
  const publicPaths = daemon.match(/const PUBLIC_API_PATHS = new Set\(([\s\S]*?)\);/);
  assert.doesNotMatch(publicPaths[1], /sessions\/(export|import)/);
});

test('empty files and sessions retain framing across multiple sessions', async t => {
  const dir = fixture(t), empty = path.join(dir, 'empty'), out = path.join(dir, 'export.wds');
  fs.writeFileSync(empty, '');
  const secondId = '22222222-2222-4222-8222-222222222222';
  await writeSessionTransfer(out, [...archive(empty, 0), { record: { id: secondId }, files: [] }], 'password');
  const restored = await readSessionTransfer(out, 'password', path.join(dir, 'staged'));
  assert.equal(fs.statSync(restored.sessions[0].files[0].source).size, 0);
  assert.equal(restored.sessions[1].record.id, secondId);
  assert.deepEqual(restored.sessions[1].files, []);
});

test('authenticated archives still reject path traversal, duplicates and excess metadata', async t => {
  const dir = fixture(t), out = path.join(dir, 'export.wds');
  function frame(value) { const data = Buffer.from(JSON.stringify(value)), prefix = Buffer.alloc(4); prefix.writeUInt32BE(data.length); return Buffer.concat([prefix, data]); }
  function encode(plain) {
    const header = Buffer.alloc(52); Buffer.from('WDS4\r\n\x1a\n').copy(header); crypto.randomFillSync(header, 8, 28);
    const key = crypto.scryptSync('password', header.subarray(8, 24), 32);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, header.subarray(24, 36)); cipher.setAAD(header.subarray(0, 36));
    const data = Buffer.concat([cipher.update(require('node:zlib').gzipSync(plain)), cipher.final()]); cipher.getAuthTag().copy(header, 36);
    return Buffer.concat([header, data]);
  }
  const root = frame({ type: 'archive', version: 4, count: 1 });
  const session = count => frame({ type: 'session', record: { id }, count });
  const file = filePath => frame({ type: 'file', path: filePath, size: 0 });
  const relative = `tasks/${id}/valid.bin`;
  const cases = [
    Buffer.concat([root, session(1), file('../outside')]),
    Buffer.concat([root, session(2), file(relative), file(relative)]),
    Buffer.from([255,255,255,255]),
  ];
  for (let i = 0; i < cases.length; i++) {
    fs.writeFileSync(out, encode(cases[i]));
    const staging = path.join(dir, 'staged-' + i);
    await assert.rejects(readSessionTransfer(out, 'password', staging), /路径|重复|元数据/);
    assert.equal(fs.existsSync(staging), false);
  }
  assert.equal(fs.existsSync(path.join(dir, 'outside')), false);
});
