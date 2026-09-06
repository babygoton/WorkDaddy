const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  EXPORT_COMPRESSION,
  EXPORT_VERSION,
  createEncryptedExport,
  encryptExport,
  openEncryptedExport,
  remapSessionArchivePath,
  resolveArchiveTarget,
} = require('../scripts/secure-transfer.js');

test('encrypted transfers require a password, randomize ciphertext, and bind the payload type', () => {
  const payload = {
    exportType: 'WorkDaddy-quick-phrases',
    version: 1,
    phrases: [{ text: '继续执行' }],
  };
  const first = createEncryptedExport('quick-phrases', payload, 'correct horse', '2026-08-28T00:00:00.000Z');
  const second = createEncryptedExport('quick-phrases', payload, 'correct horse', '2026-08-28T00:00:00.000Z');

  assert.notEqual(first, second, 'salt and IV must make repeated exports distinct');
  const envelope = JSON.parse(first);
  assert.equal(envelope.version, EXPORT_VERSION);
  assert.equal(envelope.compression, EXPORT_COMPRESSION);
  assert.doesNotMatch(first, /继续执行|correct horse/);
  assert.deepEqual(openEncryptedExport(first, 'quick-phrases', 'correct horse'), payload);
  assert.throws(() => createEncryptedExport('quick-phrases', payload, '   '), /密码不能为空/);
  assert.throws(() => openEncryptedExport(first, 'quick-phrases', ''), /密码不能为空/);
  assert.throws(() => openEncryptedExport(first, 'sessions', 'correct horse'), /类型不匹配/);
  assert.throws(() => openEncryptedExport(first, 'quick-phrases', 'wrong password'), /密码错误|损坏/);
});

test('new imports remain compatible with the previous v2 encrypted export format', () => {
  const payload = {
    exportType: 'WorkDaddy-quick-phrases',
    version: 1,
    phrases: [{ text: '旧版短语' }],
  };
  const encrypted = encryptExport(JSON.stringify(payload), 'legacy password');
  const legacy = JSON.stringify({
    wbsExport: 'WorkDaddy',
    version: 2,
    exportType: 'quick-phrases',
    createdAt: '2026-08-28T00:00:00.000Z',
    kdf: 'aes-256-gcm+scrypt',
    salt: encrypted.salt,
    data: encrypted.data,
  });
  assert.deepEqual(openEncryptedExport(legacy, 'quick-phrases', 'legacy password'), payload);
});

test('session archive paths remap only managed session payload locations', () => {
  const oldId = '11111111-1111-4111-8111-111111111111';
  const newId = '22222222-2222-4222-8222-222222222222';
  assert.equal(remapSessionArchivePath(`projects/hash/${oldId}.jsonl`, oldId, newId), `projects/hash/${newId}.jsonl`);
  assert.equal(remapSessionArchivePath(`projects/hash/${oldId}/nested/data.json`, oldId, newId), `projects/hash/${newId}/nested/data.json`);
  assert.equal(remapSessionArchivePath(`workspace/sessions/${oldId}/state.json`, oldId, newId), `workspace/sessions/${newId}/state.json`);
  assert.equal(remapSessionArchivePath(`tasks/${oldId}/task.json`, oldId, newId), `tasks/${newId}/task.json`);
  assert.equal(remapSessionArchivePath(`file-history/${oldId}/1.json`, oldId, newId), `file-history/${newId}/1.json`);
  assert.equal(remapSessionArchivePath(`artifact-index/${oldId}.json`, oldId, newId), `artifact-index/${newId}.json`);
  assert.throws(() => remapSessionArchivePath('../settings.json', oldId, newId), /无效|不受支持/);
  assert.throws(() => remapSessionArchivePath(`projects/hash/other.jsonl`, oldId, newId), /不受支持/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-transfer-'));
  try {
    assert.equal(resolveArchiveTarget(root, `tasks/${newId}/task.json`), path.join(root, 'tasks', newId, 'task.json'));
    assert.throws(() => resolveArchiveTarget(root, '../outside.json'), /数据目录/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('daemon and injected panel expose password-protected account, session, and quick-phrase transfers', () => {
  const repoRoot = path.join(__dirname, '..');
  const daemon = fs.readFileSync(path.join(repoRoot, 'scripts', 'daemon.js'), 'utf8');
  const inject = fs.readFileSync(path.join(repoRoot, 'scripts', 'inject.js'), 'utf8');
  const macBuild = fs.readFileSync(path.join(repoRoot, 'scripts', 'build-mac-dmg.sh'), 'utf8');

  assert.match(daemon, /body\s*&&\s*body\.uids/);
  assert.match(daemon, /\/api\/sessions\/export/);
  assert.match(daemon, /\/api\/sessions\/import/);
  assert.match(daemon, /\/api\/quick-phrases\/export/);
  assert.match(daemon, /\/api\/quick-phrases\/import/);
  assert.match(macBuild, /secure-transfer\.js/);

  const sessionToolbar = inject.slice(inject.indexOf('<div class="wbs-sess-toolbar">'), inject.indexOf('<div class="wbs-sess-list"'));
  assert.ok(sessionToolbar.indexOf('id="wbs-sess-batch"') < sessionToolbar.indexOf('id="wbs-sess-import"'));
  assert.ok(sessionToolbar.indexOf('id="wbs-sess-copy"') < sessionToolbar.indexOf('id="wbs-sess-export"'));
  assert.ok(sessionToolbar.indexOf('id="wbs-sess-export"') < sessionToolbar.indexOf('id="wbs-sess-delete"'));

  const phraseToolbar = inject.slice(inject.indexOf('<div class="wbs-qp-toolbar">'), inject.indexOf('<div class="wbs-qp-list"'));
  assert.ok(phraseToolbar.indexOf('id="wbs-qp-batch"') < phraseToolbar.indexOf('id="wbs-qp-import"'));
  assert.ok(phraseToolbar.indexOf('id="wbs-qp-copy"') < phraseToolbar.indexOf('id="wbs-qp-export"'));
  assert.match(inject, /class="wbs-transfer-option selected"/);
  assert.match(inject, /wbs-transfer-option[\s\S]*type="checkbox"[\s\S]*checked/);
  assert.match(inject, /requirePassword:\s*true/);
});

test('session import never reloads WorkBuddy and only returns import results', () => {
  const daemon = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'daemon.js'), 'utf8');
  const routeStart = daemon.indexOf("if (req.method === 'POST' && p === '/api/sessions/import')");
  const routeEnd = daemon.indexOf("if (req.method === 'POST' && p === '/api/sessions/copy')", routeStart);
  assert.notEqual(routeStart, -1);
  assert.notEqual(routeEnd, -1);
  const route = daemon.slice(routeStart, routeEnd);
  const imported = route.indexOf('await importSessions(');
  assert.ok(imported >= 0, 'session import must complete before its response');
  assert.doesNotMatch(route, /await reloadWorkBuddyPage\(\)/, 'session import must not refresh automatically');
  assert.doesNotMatch(daemon, /\/api\/sessions\/reload/);
  assert.doesNotMatch(route, /quitWorkBuddy|relaunchWorkBuddy/);
});

test('session import returns bounded import diagnostics without refresh controls', () => {
  const daemon = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'daemon.js'), 'utf8');
  const inject = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'inject.js'), 'utf8');
  const routeStart = daemon.indexOf("if (req.method === 'POST' && p === '/api/sessions/import')");
  const routeEnd = daemon.indexOf("if (req.method === 'POST' && p === '/api/sessions/copy')", routeStart);
  const route = daemon.slice(routeStart, routeEnd);
  const importUiStart = inject.indexOf("title: '导入会话'");
  const importUiEnd = inject.indexOf('// 删除选中', importUiStart);
  const importUi = inject.slice(importUiStart, importUiEnd);

  assert.match(daemon, /MAX_SESSION_IMPORT_ERRORS\s*=\s*20/);
  assert.match(daemon, /MAX_SESSION_IMPORT_ERROR_LENGTH\s*=\s*240/);
  assert.match(daemon, /errors:\s*summarizeSessionImportErrors\(errors\)/);
  assert.match(route, /errors:\s*result\.errors/);
  assert.doesNotMatch(route, /reloaded|reloadError/);
  assert.doesNotMatch(daemon, /\/api\/sessions\/reload/);
  assert.match(inject, /keepOpenOnSuccess:\s*true/);
  assert.match(inject, /successMessage:\s*function \(result\)/);
  assert.match(importUi, /successDoneLabel:\s*'关闭'/);
  assert.match(inject, /closeOnError:\s*true/);
  assert.doesNotMatch(importUi, /successAction|刷新页面|页面刷新/);
  assert.match(inject, /cancelButton\.style\.display\s*=\s*'none'/);
  assert.match(inject, /if \(completed\)[\s\S]*?if \(!completeAction\)[\s\S]*?close\(\);/);
});
