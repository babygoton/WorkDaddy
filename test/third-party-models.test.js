'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createSessionDb } = require('../scripts/session-db');
const { convertProvider, discoverCCSwitch, readCCSwitch, createThirdPartyImport } = require('../scripts/third-party-models');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-third-party-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.cc-switch'));
  return { home, platform: 'darwin', env: {}, dir: path.join(home, '.cc-switch') };
}
function claude(overrides = {}) {
  return { id: 'provider-a', name: '供应商 A', app_type: 'claude', settings_config: {
    env: { ANTHROPIC_BASE_URL: 'https://relay.example/v1', ANTHROPIC_AUTH_TOKEN: 'test-secret',
      ANTHROPIC_MODEL: 'model-a', ANTHROPIC_DEFAULT_SONNET_MODEL: 'model-a', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'model-b' },
  }, ...overrides };
}

test('Claude slots dedupe and generate WorkBuddy chat endpoints without losing model IDs', () => {
  const rows = convertProvider(claude());
  assert.deepEqual(rows.map(r => r.model.id), ['model-a']);
  assert.equal(rows[0].model.url, 'https://relay.example/v1/chat/completions');
  assert.equal(rows[0].model.apiKey, 'test-secret');
  assert.equal(rows[0].model.useCustomProtocol, false);
});

test('Codex reads the selected provider, profiles, quoted TOML keys and comments', () => {
  const rows = convertProvider({ id: 'codex', name: 'Codex', app_type: 'codex', settings_config: {
    auth: { OPENAI_API_KEY: 'test-secret' },
    config: `model_provider = "my.relay"\nmodel = 'gpt-test' # comment\n[model_providers."my.relay"]\nbase_url = "https://relay.example/api/v1"\nwire_api = "responses"\n[profiles.small]\nmodel = "gpt-small"\nmodel_provider = "my.relay"`,
  } });
  assert.deepEqual(rows.map(r => r.model.id), ['gpt-test', 'gpt-small']);
  assert.equal(rows[0].model.url, 'https://relay.example/api/v1/chat/completions');
});

test('Gemini official API uses its documented OpenAI-compatible endpoint', () => {
  const [row] = convertProvider({ id: 'g', name: 'Gemini', app_type: 'gemini', settings_config: {
    env: { GEMINI_API_KEY: 'test-secret', GEMINI_MODEL: 'gemini-test' },
  } });
  assert.equal(row.model.url, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
});

test('OpenCode and OpenClaw enumerate model maps/lists and preserve declared limits', () => {
  const [row] = convertProvider({ id: 'o', name: 'OpenCode', app_type: 'opencode', settings_config: {
    npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://relay.example/v1', apiKey: 'test-secret' },
    models: { 'model-a': { name: 'A', limit: { context: 120000, output: 8000 }, modalities: { input: ['text', 'image'] } } },
  } });
  assert.equal(row.model.maxInputTokens, 120000);
  assert.equal(row.model.maxOutputTokens, 8000);
  assert.equal(row.model.supportsImages, true);
  const [claw] = convertProvider({ id: 'c', name: 'Claw', app_type: 'openclaw', settings_config: {
    baseUrl: 'https://relay.example/v1', apiKey: 'test-secret', api: 'openai-completions', models: [{ id: 'model-a', name: 'A' }],
  } });
  assert.equal(claw.model.id, 'model-a');
});

test('OAuth, native-only endpoints, unknown types and unresolved secrets are rejected', () => {
  for (const provider of [
    claude({ settings_config: { env: {} } }),
    claude({ settings_config: { env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com', ANTHROPIC_API_KEY: 'test', ANTHROPIC_MODEL: 'claude-test' } } }),
    claude({ app_type: 'unknown' }),
    claude({ settings_config: { env: { ANTHROPIC_BASE_URL: 'https://relay.example', ANTHROPIC_API_KEY: '${MISSING_KEY}', ANTHROPIC_MODEL: 'm' } } }),
  ]) {
    const rows = convertProvider(provider, {});
    assert.ok(rows.length);
    assert.ok(rows.every(r => !r.model && r.reason));
  }
});

test('preview filters rejected rows and preserves per-client provider grouping', async t => {
  const options = fixture(t);
  const opencode = { id: 'provider-a', name: 'OpenCode provider', settings_config: {
    npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://relay.example/v1', apiKey: 'test-secret' },
    models: { 'model-a': {}, 'model-b': {} },
  } };
  fs.writeFileSync(path.join(options.dir, 'config.json'), JSON.stringify({
    claude: { providers: { a: claude(), invalid: claude({ id: 'invalid', settings_config: { env: {} } }) } },
    opencode: { providers: { a: opencode } },
  }));
  const preview = await createThirdPartyImport({ ...options, targetFile: path.join(options.home, 'models.json') }).preview();
  assert.equal(preview.models.length, 3);
  assert.ok(preview.models.every(row => !Object.hasOwn(row, 'available') && !Object.hasOwn(row, 'reason')));
  const rows = preview.models.filter(row => row.appType === 'opencode');
  assert.equal(rows[0].providerKey, rows[1].providerKey);
  assert.notEqual(rows[0].key, rows[1].key);
  assert.notEqual(rows[0].providerKey, preview.models.find(row => row.appType === 'claude').providerKey);
});

test('discovery honors the CC Switch custom directory and never creates missing databases', async t => {
  const options = fixture(t);
  assert.equal(discoverCCSwitch(options), null);
  assert.deepEqual(fs.readdirSync(options.dir), []);
  const custom = path.join(options.home, 'custom'); fs.mkdirSync(custom);
  fs.writeFileSync(path.join(custom, 'config.json'), JSON.stringify({ claude: { providers: { a: claude() } } }));
  const store = path.join(options.home, 'Library/Application Support/com.ccswitch.desktop'); fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, 'app_paths.json'), JSON.stringify({ app_config_dir_override: custom }));
  assert.equal(discoverCCSwitch(options).file, path.join(custom, 'config.json'));
  assert.equal((await readCCSwitch(options)).rows.length, 1);
});

test('SQLite and legacy JSON sources produce equivalent results; DB is read-only and preferred', async t => {
  const options = fixture(t), p = claude();
  fs.writeFileSync(path.join(options.dir, 'config.json'), JSON.stringify({ claude: { providers: { a: p } } }));
  const legacy = await readCCSwitch(options);
  const db = createSessionDb({ dbPath: path.join(options.dir, 'cc-switch.db') });
  await db.run('CREATE TABLE providers (id TEXT, name TEXT, app_type TEXT, settings_config TEXT, meta TEXT)');
  await db.run('INSERT INTO providers VALUES (?, ?, ?, ?, ?)', [p.id, p.name, p.app_type, JSON.stringify(p.settings_config), '{}']);
  assert.deepEqual((await readCCSwitch(options)).rows, legacy.rows);
  assert.equal((await db.all('SELECT COUNT(*) AS count FROM providers'))[0].count, 1);
});

test('preview shows API keys locally; import freezes the selection, requires confirmation, and backs up overwritten models', async t => {
  const options = fixture(t), target = path.join(options.home, 'models.json');
  fs.writeFileSync(path.join(options.dir, 'config.json'), JSON.stringify({ claude: { providers: { a: claude() } } }));
  fs.writeFileSync(target, JSON.stringify({ extra: true, models: [{ id: 'model-a', name: 'old', apiKey: 'old-secret' }, { id: 'keep' }] }));
  const service = createThirdPartyImport({ ...options, targetFile: target });
  const preview = await service.preview();
  assert.equal(JSON.stringify(preview).includes('test-secret'), true);
  assert.equal(preview.models.length, 1);
  const before = fs.readFileSync(target, 'utf8');
  const check = await service.import({ snapshot: preview.snapshot, ids: [preview.models[0].key] });
  assert.equal(check.confirmationRequired, true);
  assert.equal(check.replaced, 1);
  assert.equal(check.duplicateIds, 0);
  assert.equal(fs.readFileSync(target, 'utf8'), before);
  assert.equal(fs.readdirSync(options.home).some(name => name.includes('before-cc-switch')), false);
  await assert.rejects(service.import({ snapshot: preview.snapshot, ids: ['forged'], confirmed: true }), /失效|无效/);
  const result = await service.import({ snapshot: preview.snapshot, ids: [preview.models[0].key], confirmed: true });
  assert.equal(result.imported, 1); assert.equal(result.replaced, 1);
  const actual = JSON.parse(fs.readFileSync(target));
  assert.equal(actual.extra, true);
  assert.deepEqual(actual.models.map(m => m.id), ['model-a', 'keep']);
  assert.equal(actual.models[0].apiKey, 'test-secret');
  assert.equal(JSON.parse(fs.readFileSync(result.backupFile)).models[0].apiKey, 'old-secret');
  await assert.rejects(service.import({ snapshot: preview.snapshot, ids: [preview.models[0].key], confirmed: true }), /失效/);
});

test('same-ID providers remain in backups; current config uses the last selected provider', async t => {
  const options = fixture(t), target = path.join(options.home, 'models.json');
  const p = claude(); p.settings_config.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'model-a';
  const q = JSON.parse(JSON.stringify(p)); q.id = 'provider-b'; q.name = '供应商 B';
  q.settings_config.env.ANTHROPIC_AUTH_TOKEN = 'other-secret';
  fs.writeFileSync(path.join(options.dir, 'config.json'), JSON.stringify({ claude: { providers: { a: p, b: q } } }));
  fs.writeFileSync(target, JSON.stringify({ availableModels: ['keep'], models: [{ id: 'keep' }] }));
  const service = createThirdPartyImport({ ...options, targetFile: target });
  const preview = await service.preview();
  assert.equal(preview.models.length, 2);
  const check = await service.import({ snapshot: preview.snapshot, ids: preview.models.map(m => m.key) });
  assert.equal(check.confirmationRequired, true);
  assert.equal(check.replaced, 0);
  assert.equal(check.duplicateIds, 1);
  const result = await service.import({ snapshot: preview.snapshot, ids: preview.models.map(m => m.key), confirmed: true });
  assert.equal(result.imported, 1); assert.equal(result.sameIdSkipped, 1);
  const saved = JSON.parse(fs.readFileSync(target));
  assert.deepEqual(saved.availableModels, ['keep', 'model-a']);
  assert.equal(saved.models[1].apiKey, 'other-secret');
  const backups = require('../scripts/lib').listModelBackups(options.home);
  assert.equal(backups[0].items.length, 2);
});

test('non-conflicting selection imports immediately; conflicts added after preview are checked before writing', async t => {
  const options = fixture(t), target = path.join(options.home, 'models.json');
  fs.writeFileSync(path.join(options.dir, 'config.json'), JSON.stringify({ claude: { providers: { a: claude() } } }));
  const service = createThirdPartyImport({ ...options, targetFile: target });
  const first = await service.preview();
  const result = await service.import({ snapshot: first.snapshot, ids: [first.models[0].key], confirmed: false });
  assert.equal(result.imported, 1);
  assert.equal(result.replaced, 0);
  fs.writeFileSync(target, '[]');
  const second = await service.preview();
  fs.writeFileSync(target, JSON.stringify([{ id: 'model-a', name: 'newly changed' }]));
  const before = fs.readFileSync(target, 'utf8');
  const check = await service.import({ snapshot: second.snapshot, ids: [second.models[0].key], confirmed: false });
  assert.equal(check.confirmationRequired, true);
  assert.equal(fs.readFileSync(target, 'utf8'), before);
});

test('changed source cannot alter a reviewed snapshot and expired previews cannot write', async t => {
  const options = fixture(t), target = path.join(options.home, 'models.json');
  const file = path.join(options.dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ claude: { providers: { a: claude() } } }));
  let clock = 100;
  const service = createThirdPartyImport({ ...options, targetFile: target, now: () => clock });
  const preview = await service.preview();
  const expiring = await service.preview();
  fs.writeFileSync(file, '{}');
  const request = { snapshot: preview.snapshot, ids: [preview.models[0].key], confirmed: true };
  await service.import(request);
  assert.equal(JSON.parse(fs.readFileSync(target))[0].id, 'model-a');
  const before = fs.readFileSync(target, 'utf8');
  clock += 10 * 60 * 1000 + 1;
  await assert.rejects(service.import({ ...request, snapshot: expiring.snapshot }), /失效/);
  assert.equal(fs.readFileSync(target, 'utf8'), before);
});

test('Windows discovery uses APPDATA overrides and supports the historical HOME database', async t => {
  const options = fixture(t);
  options.platform = 'win32';
  const appData = path.join(options.home, 'roaming'), oldHome = path.join(options.home, 'legacy');
  options.env = { APPDATA: appData, HOME: oldHome };
  fs.mkdirSync(path.join(oldHome, '.cc-switch'), { recursive: true });
  const legacyDb = path.join(oldHome, '.cc-switch/cc-switch.db'); fs.writeFileSync(legacyDb, 'fixture');
  assert.equal(discoverCCSwitch(options).file, legacyDb);
  const store = path.join(appData, 'com.ccswitch.desktop'); fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(options.dir, 'config.json'), '{}');
  fs.writeFileSync(path.join(store, 'app_paths.json'), JSON.stringify({ app_config_dir_override: '~/.cc-switch' }));
  assert.equal(discoverCCSwitch(options).file, path.join(options.dir, 'config.json'));
});

test('enabled shared config supplies missing Claude model routing', async t => {
  const options = fixture(t);
  const p = claude({ meta: { commonConfigEnabled: true }, settingsConfig: undefined, settings_config: { env: { ANTHROPIC_API_KEY: 'test-secret' } } });
  fs.writeFileSync(path.join(options.dir, 'config.json'), JSON.stringify({
    claude: { providers: { a: p } }, common_config_snippets: { claude: JSON.stringify({ env: { ANTHROPIC_MODEL: 'shared-model', ANTHROPIC_BASE_URL: 'https://relay.example/v1' } }) },
  }));
  const rows = (await readCCSwitch(options)).rows;
  assert.equal(rows[0].model.id, 'shared-model');
});

test('malformed configuration errors never include raw credential-bearing input', async t => {
  const options = fixture(t), secret = 'DO-NOT-PRINT-SECRET';
  fs.writeFileSync(path.join(options.dir, 'config.json'), '{"apiKey":"' + secret);
  await assert.rejects(readCCSwitch(options), e => !e.message.includes(secret));
  const rows = convertProvider(claude({ settings_config: '{"token":"' + secret }));
  assert.equal(JSON.stringify(rows).includes(secret), false);
  const unsupported = convertProvider({ id: 'c', name: 'Codex', app_type: 'codex', settings_config: { auth: { OPENAI_API_KEY: secret }, config: 'note = """\nmodel="not-a-real-model"\n"""' } });
  assert.ok(unsupported.every(r => !r.model));
});
