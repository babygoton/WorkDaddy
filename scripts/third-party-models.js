'use strict';

// CC Switch source format reference: farion1231/cc-switch @ b78192e8fec3e062948237526d9c03ad08ea7831.
// Read providers only; never execute source config, contact endpoints, or expose credentials in previews.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { createSessionDb } = require('./session-db');
const { readModelsFile, writeModelsFile } = require('./lib');
const MAX_PROVIDERS = 2000;
const MAX_MODELS = 5000;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const str = value => typeof value === 'string' ? value.trim() : '';

function readJson(file) {
  if (fs.statSync(file).size > MAX_JSON_BYTES) throw new Error('CC Switch 配置过大，无法读取');
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (_) { throw new Error('CC Switch 配置不是有效 JSON'); }
}

function discoverCCSwitch(options = {}) {
  const home = options.home || os.homedir();
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const appData = platform === 'win32' ? (env.APPDATA || path.join(home, 'AppData', 'Roaming'))
    : platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
      : (env.XDG_DATA_HOME || path.join(home, '.local', 'share'));
  const dirs = [];
  const store = path.join(appData, 'com.ccswitch.desktop', 'app_paths.json');
  if (fs.existsSync(store)) {
    const raw = str(readJson(store).app_config_dir_override);
    const resolved = raw === '~' ? home : /^~[/\\]/.test(raw) ? path.join(home, raw.slice(2)) : raw;
    if (resolved && path.isAbsolute(resolved) && fs.existsSync(resolved)) dirs.push(resolved);
  }
  dirs.push(path.join(home, '.cc-switch'));
  if (platform === 'win32' && env.HOME && env.HOME !== home) dirs.push(path.join(env.HOME, '.cc-switch'));
  for (const dir of [...new Set(dirs)]) {
    for (const name of ['cc-switch.db', 'config.json']) {
      const file = path.join(dir, name);
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return { id: 'cc-switch', name: 'CC Switch', file, format: name.endsWith('.db') ? 'sqlite' : 'json' };
    }
  }
  return null;
}

// Parse only the scalar TOML configuration used for model routing. Unsupported
// multiline/inline-table constructs are rejected instead of guessing or executing them.
function parseRoutingToml(text) {
  if (typeof text !== 'string' || text.length > MAX_JSON_BYTES) throw new Error('Codex 配置无效');
  const tables = new Map([['', {}]]);
  let table = tables.get('');
  function keyParts(raw) {
    const parts = raw.match(/"(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_-]+/g) || [];
    if (parts.join('.').replace(/\s/g, '') !== raw.replace(/\s/g, '')) throw new Error('Codex 配置键格式暂不支持');
    return parts.map(p => p[0] === '"' ? JSON.parse(p) : p[0] === "'" ? p.slice(1, -1) : p);
  }
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    let quote = '', escaped = false, end = raw.length;
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (escaped) { escaped = false; continue; }
      if (quote === '"' && c === '\\') { escaped = true; continue; }
      if (quote) { if (c === quote) quote = ''; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === '#') { end = i; break; }
    }
    const line = raw.slice(0, end).trim();
    if (!line) continue;
    if (line.includes('"""') || line.includes("'''")) throw new Error('Codex 多行 TOML 暂不支持');
    if (line.startsWith('[')) {
      if (!line.endsWith(']') || line.startsWith('[[')) { table = {}; continue; }
      const key = JSON.stringify(keyParts(line.slice(1, -1).trim()));
      if (!tables.has(key)) tables.set(key, {});
      table = tables.get(key);
      continue;
    }
    const match = line.match(/^([A-Za-z0-9_-]+|"(?:\\.|[^"\\])*")\s*=\s*(.*)$/);
    if (!match) continue;
    const key = keyParts(match[1])[0];
    if (!['model', 'model_provider', 'base_url', 'wire_api', 'env_key', 'api_key', 'model_reasoning_effort', 'model_context_window', 'model_max_output_tokens', 'requires_openai_auth'].includes(key)) continue;
    const value = match[2];
    if (/^"(?:\\.|[^"\\])*"$/.test(value)) table[key] = JSON.parse(value);
    else if (/^'[^']*'$/.test(value)) table[key] = value.slice(1, -1);
    else if (/^\d+$/.test(value)) table[key] = Number(value);
    else if (value === 'true' || value === 'false') table[key] = value === 'true';
    else throw new Error('Codex 模型配置包含暂不支持的 TOML 写法');
  }
  return tables;
}

function secret(value, env) {
  const text = str(value);
  const ref = text.match(/^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$|^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
  if (ref) return str(env[ref[1] || ref[2]]);
  if (/^\{(?:file|env):|^\$|^<|YOUR[_ -]|PLACEHOLDER/i.test(text)) return '';
  return text;
}

function chatEndpoint(raw, format) {
  let url;
  try { url = new URL(raw); } catch (_) { throw new Error('缺少有效的接口地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('接口地址需为不含凭据或查询参数的 HTTP(S) 地址');
  }
  if (url.hostname === 'api.anthropic.com' || url.hostname.endsWith('.anthropic.com')) {
    throw new Error('Anthropic 官方接口不支持 WorkBuddy 所需的 OpenAI 协议');
  }
  let p = url.pathname.replace(/\/+$/, '');
  if (format === 'gemini_native' && url.hostname === 'generativelanguage.googleapis.com') p = '/v1beta/openai';
  else {
    p = p.replace(/\/(?:chat\/completions|responses|messages)$/, '');
    if (!p) p = '/v1';
  }
  url.pathname = p + '/chat/completions';
  return url.toString();
}

function convertProvider(provider, env = process.env) {
  const type = str(provider.app_type);
  const label = str(provider.name) || type || '未命名供应商';
  let config, meta;
  try {
    config = typeof provider.settings_config === 'string' ? JSON.parse(provider.settings_config) : (provider.settings_config || provider.settingsConfig);
    meta = typeof provider.meta === 'string' ? JSON.parse(provider.meta) : provider.meta;
  } catch (_) { return [{ provider: label, appType: type, reason: '供应商配置不是有效 JSON' }]; }
  config = object(config); meta = object(meta);
  const rows = [], seen = new Set();
  const blocked = reason => rows.push({ provider: label, appType: type, reason });
  const add = (id, base, key, format, details = {}) => {
    id = str(id);
    if (!id) return;
    const identity = JSON.stringify([id, base, key, format]);
    if (seen.has(identity)) return;
    seen.add(identity);
    try {
      if (rows.length >= MAX_MODELS) throw new Error('供应商模型数量过多');
      if (id.length > 256 || /[\x00-\x1f]/.test(id)) throw new Error('模型名无效');
      if (meta.authBinding && !str(key)) throw new Error('账号登录授权不能作为 API Key 导入');
      const apiKey = secret(key, env);
      if (!apiKey) throw new Error('缺少 API Key，或环境变量尚未配置（OAuth 登录不能直接导入）');
      if (apiKey.length > 20000) throw new Error('API Key 格式无效');
      if (!['openai_chat', 'openai_responses', 'anthropic', 'gemini_native'].includes(format)) throw new Error('此供应商协议暂不支持');
      const url = chatEndpoint(base, format);
      const model = { id, name: label + ' · ' + (str(details.name) || id), vendor: 'Custom', url, apiKey,
        useCustomProtocol: false, supportsToolCall: details.tool_call !== false, supportsImages: !!details.images, supportsReasoning: !!details.reasoning };
      for (const [field, value] of [['maxInputTokens', details.context], ['maxOutputTokens', details.output]]) {
        if (Number.isSafeInteger(value) && value > 0) model[field] = value;
      }
      if (str(details.effort)) { model.supportsReasoning = true; model.reasoning = { effort: str(details.effort) }; }
      rows.push({ provider: label, appType: type, model });
    } catch (error) { rows.push({ provider: label, appType: type, id, reason: error.message }); }
  };
  try {
    const values = object(config.env);
    if (type === 'claude') {
      const key = values[meta.apiKeyField] || values.ANTHROPIC_AUTH_TOKEN || values.ANTHROPIC_API_KEY;
      const id = values.ANTHROPIC_MODEL || config.model || values.ANTHROPIC_DEFAULT_SONNET_MODEL;
      add(id, values.ANTHROPIC_BASE_URL || 'https://api.anthropic.com', key, meta.apiFormat || 'anthropic');
    } else if (type === 'codex') {
      const tables = parseRoutingToml(config.config || '');
      const defaults = tables.get('');
      const variants = [defaults, ...[...tables].filter(([key]) => key && JSON.parse(key)[0] === 'profiles' && JSON.parse(key).length === 2).map(([, value]) => ({ ...defaults, ...value }))];
      for (const variant of variants) {
        const providerId = str(variant.model_provider) || 'openai';
        const details = tables.get(JSON.stringify(['model_providers', providerId])) || {};
        const base = details.base_url || (providerId === 'openai' ? 'https://api.openai.com/v1' : '');
        const key = (details.env_key ? env[details.env_key] : '') || details.api_key || object(config.auth).OPENAI_API_KEY;
        add(variant.model, base, key, meta.apiFormat || (details.wire_api === 'chat' ? 'openai_chat' : 'openai_responses'),
          { effort: variant.model_reasoning_effort, context: variant.model_context_window, output: variant.model_max_output_tokens });
      }
    } else if (type === 'gemini') {
      add(values.GEMINI_MODEL || object(object(config.config).model).name, values.GOOGLE_GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com', values.GEMINI_API_KEY || values.GOOGLE_API_KEY, 'gemini_native');
    } else if (type === 'opencode') {
      const opts = object(config.options);
      const format = { '@ai-sdk/openai-compatible': 'openai_chat', '@ai-sdk/openai': 'openai_responses', '@ai-sdk/anthropic': 'anthropic', '@ai-sdk/google': 'gemini_native' }[config.npm];
      if (Object.keys(object(opts.headers)).length) throw new Error('包含额外认证请求头，不能直接导入');
      for (const [id, model] of Object.entries(object(config.models))) {
        const d = object(model), limit = object(d.limit);
        add(id, opts.baseURL, opts.apiKey, format, { ...d, context: limit.context, output: limit.output, images: (object(d.modalities).input || []).includes('image') });
      }
    } else if (type === 'openclaw') {
      const format = { 'openai-completions': 'openai_chat', 'openai-responses': 'openai_responses', 'anthropic-messages': 'anthropic', 'google-generative-ai': 'gemini_native' }[config.api];
      if (Object.keys(object(config.headers)).length) throw new Error('包含额外认证请求头，不能直接导入');
      for (const d of Array.isArray(config.models) ? config.models : []) add(d.id, config.baseUrl, config.apiKey, format, { ...d, context: d.contextWindow, output: d.maxTokens, images: (d.input || []).includes('image') });
    } else blocked('此客户端的供应商配置暂不支持导入');
  } catch (_) { blocked('模型配置格式暂不支持，或包含无法迁移的认证设置'); }
  if (!rows.length) blocked('未配置明确的模型名；请先在 CC Switch 中填写模型和 API Key');
  return rows;
}

async function readCCSwitch(options = {}) {
  const source = discoverCCSwitch(options);
  if (!source) return { found: false, rows: [] };
  let providers = [], common = {};
  if (source.format === 'sqlite') {
    const db = createSessionDb({ dbPath: source.file });
    try {
      const columns = await db.all('PRAGMA table_info(providers)');
      const names = new Set(columns.map(c => c.name));
      if (!['id', 'name', 'app_type', 'settings_config'].every(c => names.has(c))) throw new Error('schema');
      providers = await db.all(`SELECT id, name, app_type, settings_config${names.has('meta') ? ', meta' : ''} FROM providers ORDER BY app_type, id LIMIT ${MAX_PROVIDERS + 1}`);
      const tables = await db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settings'");
      if (tables.length) {
        for (const row of await db.all("SELECT key, value FROM settings WHERE key IN ('common_config_claude', 'common_config_codex', 'common_config_gemini')")) common[row.key.replace('common_config_', '')] = row.value;
      }
    } catch (_) { throw new Error('无法读取 CC Switch 数据库，请关闭 CC Switch 后重试或检查版本'); }
  } else {
    const config = object(readJson(source.file));
    for (const [type, manager] of Object.entries(config)) {
      for (const [id, provider] of Object.entries(object(object(manager).providers))) providers.push({ ...object(provider), id: provider.id || id, app_type: type });
    }
    // Pre-multi-app releases stored Claude providers directly at the root.
    if (!providers.length) for (const [id, provider] of Object.entries(object(config.providers))) providers.push({ ...object(provider), id, app_type: 'claude' });
    common = object(config.common_config_snippets);
    if (config.claude_common_config_snippet && !common.claude) common.claude = config.claude_common_config_snippet;
  }
  if (providers.length > MAX_PROVIDERS) throw new Error('CC Switch 供应商数量超过读取上限');
  const rows = [];
  for (const provider of providers) {
    // Common snippets explicitly enabled in CC Switch override provider values.
    let effective = provider;
    try {
      const meta = typeof provider.meta === 'string' ? JSON.parse(provider.meta) : object(provider.meta);
      const snippet = common[provider.app_type];
      if (meta.commonConfigEnabled === true && snippet) {
        const config = typeof provider.settings_config === 'string' ? JSON.parse(provider.settings_config) : (provider.settings_config || provider.settingsConfig);
        const next = { ...object(config) };
        if (provider.app_type === 'codex') {
          // Overlay only routing scalars/tables after parsing each document independently.
          const a = parseRoutingToml(next.config || ''), b = parseRoutingToml(snippet);
          for (const [key, value] of b) a.set(key, { ...a.get(key), ...value });
          next.config = [...a].map(([key, value]) => (key ? '[' + JSON.parse(key).map(x => JSON.stringify(x)).join('.') + ']\n' : '') + Object.entries(value).map(([k, v]) => k + ' = ' + JSON.stringify(v)).join('\n')).join('\n');
        } else {
          const patch = object(JSON.parse(snippet));
          next.env = { ...object(next.env), ...object(provider.app_type === 'claude' ? patch.env : patch) };
          if (provider.app_type === 'claude' && patch.model) next.model = patch.model;
        }
        effective = { ...provider, settings_config: next };
      }
    } catch (_) { rows.push({ provider: str(provider.name), appType: provider.app_type, reason: '通用配置片段无法解析' }); continue; }
    for (const row of convertProvider(effective, options.env || process.env)) {
      const key = crypto.createHash('sha256').update(JSON.stringify([provider.app_type, provider.id, row.id || row.model?.id || '', row.model?.url || ''])).digest('hex');
      const providerKey = crypto.createHash('sha256').update(JSON.stringify([provider.app_type, provider.id])).digest('hex');
      rows.push({ ...row, key, providerKey });
      if (rows.length > MAX_MODELS) throw new Error('CC Switch 模型数量超过读取上限');
    }
  }
  return { found: true, rows };
}

function createThirdPartyImport(options) {
  const snapshots = new Map();
  const now = options.now || Date.now;
  function prune() {
    for (const [id, value] of snapshots) if (now() - value.created > 10 * 60 * 1000) snapshots.delete(id);
    while (snapshots.size >= 4) snapshots.delete(snapshots.keys().next().value);
  }
  return {
    discover() { return discoverCCSwitch(options) ? [{ id: 'cc-switch', name: 'CC Switch' }] : []; },
    async preview() {
      const data = await readCCSwitch(options);
      if (!data.found) throw new Error('未检测到 CC Switch 本地模型配置');
      prune();
      const snapshot = crypto.randomUUID();
      snapshots.set(snapshot, { created: now(), rows: data.rows });
      const usable = data.rows.filter(row => row && row.model);
      return { snapshot, models: usable.map(row => ({ key: row.key, providerKey: row.providerKey, provider: row.provider, appType: row.appType,
        id: row.model.id, name: row.model.name || row.provider, url: row.model.url || '', apiKey: row.model.apiKey || '' })) };
    },
    async import(body) {
      if (!body) throw new Error('未选择有效模型');
      const snapshot = snapshots.get(body.snapshot);
      if (!snapshot || now() - snapshot.created > 10 * 60 * 1000) throw new Error('模型列表已失效，请重新读取');
      if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > MAX_MODELS || body.ids.some(id => typeof id !== 'string')) throw new Error('未选择有效模型');
      const ids = [...new Set(body.ids)];
      const selected = ids.map(id => snapshot.rows.find(row => row.key === id));
      if (selected.some(row => !row || !row.model)) throw new Error('模型选择无效，请重新读取');
      // WorkBuddy has one physical config per model ID. Preserve every selected
      // provider in backups before resolving same-ID conflicts in source order.
      const { writeModelBackup } = require('./lib');
      const target = readModelsFile(options.targetFile);
      const models = target.models.slice();
      let replaced = 0;
      const byId = new Map();
      for (const row of selected) byId.set(row.model.id, row.model);
      const duplicateIds = new Set(selected.filter((row, index) => selected.findIndex(other => other.model.id === row.model.id) !== index).map(row => row.model.id)).size;
      const existingIds = new Set(models.map(model => str(model && model.id)));
      const conflicts = [...byId.keys()].filter(id => existingIds.has(id)).length;
      // Check the current file at submission time. A conflict-free import writes
      // immediately; otherwise return counts without creating backups or writing.
      if (body.confirmed !== true && (conflicts || duplicateIds)) {
        return { confirmationRequired: true, replaced: conflicts, duplicateIds };
      }
      const next = [];
      const written = new Set();
      for (const existing of models) {
        const id = str(existing && existing.id);
        if (byId.has(id)) {
          if (!written.has(id)) { next.push(byId.get(id)); written.add(id); replaced++; }
        } else next.push(existing);
      }
      for (const [id, model] of byId) if (!written.has(id)) next.push(model);
      let backupFile = '';
      if (fs.existsSync(target.file)) {
        backupFile = target.file + '.before-cc-switch-' + crypto.randomUUID() + '.bak';
        fs.copyFileSync(target.file, backupFile, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(backupFile, 0o600);
      }
      if (target.format === 'object' && Array.isArray(target.wrapper.availableModels)) {
        target.wrapper = { ...target.wrapper, availableModels: [...new Set([...target.wrapper.availableModels, ...byId.keys()])] };
      }
      for (const row of selected) writeModelBackup(options.dataDir || path.dirname(target.file), {
        schema: 1, backupId: crypto.randomUUID(), createdAt: new Date().toISOString(), model: row.model,
      });
      writeModelsFile(target, next);
      snapshots.delete(body.snapshot);
      return { imported: byId.size, replaced, sameIdSkipped: selected.length - byId.size, backupFile };
    },
  };
}

module.exports = { discoverCCSwitch, convertProvider, readCCSwitch, createThirdPartyImport };
