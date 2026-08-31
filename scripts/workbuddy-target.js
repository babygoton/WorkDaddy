'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TARGET_FILE = 'workbuddy-target.json';
const CUSTOM_PROFILES = new Set(['workbuddy-cn', 'workbuddy-ai']);

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function emptyTarget(configured = false, source = 'default') {
  return { configured, binary: '', version: '', source };
}

function platformPath(platform) {
  return platform === 'win32' ? path.win32 : path;
}

function targetFile(dataDir) {
  return path.join(dataDir, TARGET_FILE);
}

function isAbsolute(value, platform) {
  return platformPath(platform).isAbsolute(clean(value));
}

function validateApiHost(value) {
  if (!value) return '';
  let parsed;
  try { parsed = new URL(value); } catch (_) { throw new Error('企业 API 地址必须是有效 HTTPS 地址'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('企业 API 地址必须是无账号、路径和参数的 HTTPS origin');
  }
  return parsed.origin;
}

function validateProcessName(value, pathApi) {
  const name = clean(value);
  if (!/^[^\\/:*?"<>|\0]+\.exe$/i.test(name) || name !== pathApi.basename(name)) {
    throw new Error('WorkBuddy 进程名必须是单个 .exe 文件名');
  }
  return name;
}

function inferredProcessNames(binary, platform) {
  const pathApi = platformPath(platform);
  const selectedName = pathApi.basename(binary);
  const names = [selectedName];
  const stem = selectedName.replace(/\.exe$/i, '');
  const enterprise = stem.match(/^workbuddy[-_ ]+(.+)$/i);
  if (enterprise) {
    const suffix = enterprise[1].split(/[-_ ]+/).filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()).join('');
    if (suffix) names.push(`WorkBuddy${suffix}.exe`);
  }
  return Array.from(new Set(names.map((name) => name.toLowerCase())))
    .map((lower) => names.find((name) => name.toLowerCase() === lower));
}

function validateTarget(target, options = {}) {
  const platform = options.platform || process.platform;
  if (!target || typeof target !== 'object' || Array.isArray(target)) throw new Error('WorkBuddy 客户端配置无效');
  const profileId = clean(target.profileId || target.profile);
  if (!CUSTOM_PROFILES.has(profileId)) throw new Error('WorkBuddy 客户端 profile 只能是 workbuddy-cn 或 workbuddy-ai');
  const clientType = target.clientType === 'official' ? 'official' : 'enterprise';
  const binary = clean(target.binary || target.executable || target.path);
  if (!isAbsolute(binary, platform)) throw new Error('WorkBuddy 客户端路径必须是 absolute path');
  const pathApi = platformPath(platform);
  const configuredNames = Array.isArray(target.processNames) ? target.processNames : [target.processName].filter(Boolean);
  const processNames = (configuredNames.length ? configuredNames : [pathApi.basename(binary)])
    .map((name) => validateProcessName(name, pathApi));
  const selectedName = pathApi.basename(binary);
  if (!processNames.some((name) => name.toLowerCase() === selectedName.toLowerCase())) {
    throw new Error('WorkBuddy 进程名必须包含所选 .exe 文件名');
  }
  const uniqueProcessNames = Array.from(new Set(processNames.map((name) => name.toLowerCase())))
    .map((lower) => processNames.find((name) => name.toLowerCase() === lower));
  if (uniqueProcessNames.length > 4) throw new Error('WorkBuddy 进程名候选不能超过 4 个');
  for (const field of ['dataRoot', 'authFile', 'sessionDb', 'modelsFile']) {
    if (target[field] && !isAbsolute(target[field], platform)) throw new Error(`${field} 路径必须是 absolute path`);
  }
  const apiHost = validateApiHost(clean(target.apiHost));
  const cdp = target.cdp || { mode: 'argument', port: profileId === 'workbuddy-ai' ? 9223 : 9222 };
  if (!cdp || (cdp.mode !== 'argument' && cdp.mode !== 'environment')) throw new Error('CDP mode 只能是 argument 或 environment');
  const cdpPort = Number(cdp.port);
  if (!Number.isInteger(cdpPort) || cdpPort < 1024 || cdpPort > 65535) throw new Error('CDP port 必须在 1024-65535 之间');
  const version = clean(target.version);
  if (version && !/^\d+(?:\.\d+){1,3}$/.test(version)) throw new Error('WorkBuddy 版本必须是数字版本号');
  const capabilities = {};
  if (target.capabilities && typeof target.capabilities === 'object' && !Array.isArray(target.capabilities)) {
    for (const name of ['accounts', 'sessions', 'models', 'stashPrompt', 'theme', 'checkin']) {
      if (typeof target.capabilities[name] === 'boolean') capabilities[name] = target.capabilities[name];
    }
  }
  return {
    schemaVersion: 1,
    clientType,
    profileId,
    binary,
    ...(version ? { version } : {}),
    lockVersion: target.lockVersion !== false && !!version,
    processNames: uniqueProcessNames,
    ...(target.dataRoot ? { dataRoot: clean(target.dataRoot) } : {}),
    ...(target.authFile ? { authFile: clean(target.authFile) } : {}),
    ...(target.sessionDb ? { sessionDb: clean(target.sessionDb) } : {}),
    ...(target.modelsFile ? { modelsFile: clean(target.modelsFile) } : {}),
    ...(apiHost ? { apiHost } : {}),
    targetHints: Array.from(new Set((Array.isArray(target.targetHints) ? target.targetHints : [])
      .map(clean).filter((value) => value && value.length <= 200))).slice(0, 8),
    cdp: { mode: cdp.mode, port: cdpPort },
    capabilities,
  };
}

function hostFromValue(value) {
  const text = clean(value);
  if (!text || text.length > 4096) return '';
  try {
    const parsed = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    if (parsed.protocol !== 'https:' || !parsed.hostname.includes('.') || parsed.username || parsed.password) return '';
    return parsed.origin;
  } catch (_) { return ''; }
}

function jwtIssuer(value) {
  const parts = clean(value).split('.');
  if (parts.length !== 3 || parts[1].length > 8192) return '';
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload && hostFromValue(payload.iss);
  } catch (_) { return ''; }
}

function apiHostFromAuth(value) {
  const seen = new Set();
  function visit(node, key, depth) {
    if (depth > 8 || node === null || node === undefined) return '';
    if (typeof node === 'string') {
      if (/token/i.test(key || '')) return jwtIssuer(node);
      if (/^(?:iss|issuer|domain|apiHost|apiEndpoint|realm)$/i.test(key || '')) return hostFromValue(node);
      return '';
    }
    if (typeof node !== 'object' || seen.has(node)) return '';
    seen.add(node);
    for (const [childKey, child] of Object.entries(node)) {
      const found = visit(child, childKey, depth + 1);
      if (found) return found;
    }
    return '';
  }
  return visit(value, '', 0);
}

function findAuthFile(authDir, stem) {
  const exact = path.join(authDir, `workbuddy-desktop-${stem}.info`);
  try { if (fs.statSync(exact).isFile()) return exact; } catch (_) {}
  let names = [];
  try { names = fs.readdirSync(authDir); } catch (_) { return ''; }
  const tokens = stem.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2);
  const matches = names.filter((name) => name.toLowerCase().endsWith('.info') && tokens.every((token) => name.toLowerCase().includes(token)));
  return matches.length === 1 ? path.join(authDir, matches[0]) : '';
}

function buildTargetFromBinary(options = {}) {
  const platform = options.platform || process.platform;
  const pathApi = platformPath(platform);
  const binary = clean(options.binary);
  if (!binary || !isAbsolute(binary, platform)) throw new Error('请选择完整的 WorkBuddy .exe 路径');
  const processName = pathApi.basename(binary);
  if (!/\.exe$/i.test(processName)) throw new Error('请选择 WorkBuddy 的 .exe 主程序');
  const processNames = inferredProcessNames(binary, platform);
  const stem = processName.replace(/\.exe$/i, '').toLowerCase();
  const home = options.home || os.homedir();
  const localAppData = options.localAppData || process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const dataRoot = path.join(home, `.${stem}`);
  const authDir = path.join(localAppData, 'CodeBuddyExtension', 'Data', 'Public', 'auth');
  const authFile = findAuthFile(authDir, stem);
  let apiHost = '';
  if (authFile) {
    try { apiHost = apiHostFromAuth(JSON.parse(fs.readFileSync(authFile, 'utf8'))); } catch (_) {}
  }
  const profileId = clean(options.profileId) || 'workbuddy-cn';
  const port = Number(options.cdpPort) || (profileId === 'workbuddy-ai' ? 9233 : 9226);
  return validateTarget({
    schemaVersion: 1,
    clientType: 'enterprise',
    profileId,
    binary,
    version: clean(options.version),
    lockVersion: !!clean(options.version),
    processNames,
    dataRoot,
    ...(authFile ? { authFile } : {}),
    sessionDb: path.join(dataRoot, 'workbuddy.db'),
    modelsFile: path.join(dataRoot, 'models.json'),
    ...(apiHost ? { apiHost } : {}),
    targetHints: [stem, apiHost ? new URL(apiHost).hostname : ''].filter(Boolean),
    cdp: { mode: 'environment', port },
    capabilities: { accounts: !!authFile, sessions: true, models: true, stashPrompt: true, theme: true, checkin: false },
  }, { platform });
}

function buildOfficialTargetFromBinary(options = {}) {
  const platform = options.platform || process.platform;
  const pathApi = platformPath(platform);
  const binary = clean(options.binary);
  const profileId = clean(options.profileId) || 'workbuddy-cn';
  if (!binary || !isAbsolute(binary, platform)) throw new Error('请选择完整的 WorkBuddy .exe 路径');
  const expectedName = profileId === 'workbuddy-ai' ? 'WorkBuddyAI.exe' : 'WorkBuddy.exe';
  if (pathApi.basename(binary).toLowerCase() !== expectedName.toLowerCase()) {
    throw new Error(`当前安装包的官方客户端必须是 ${expectedName}`);
  }
  return validateTarget({
    schemaVersion: 1,
    clientType: 'official',
    profileId,
    binary,
    version: clean(options.version),
    lockVersion: !!clean(options.version),
    processNames: [pathApi.basename(binary)],
    targetHints: [],
    cdp: { mode: 'argument', port: profileId === 'workbuddy-ai' ? 9223 : 9222 },
    capabilities: {},
  }, { platform });
}

function readWorkBuddyTarget({ dataDir, profileId, env = process.env, platform = process.platform } = {}) {
  const envBinary = clean(env.WBSWITCH_WORKBUDDY_BIN);
  const envVersion = clean(env.WBSWITCH_WORKBUDDY_VERSION);
  let target = null;
  if (dataDir) {
    try { target = JSON.parse(fs.readFileSync(targetFile(dataDir), 'utf8')); } catch (error) {
      if (!error || error.code !== 'ENOENT') return emptyTarget(true, 'file');
    }
  }
  if (target && typeof target !== 'object') return emptyTarget(true, 'file');
  const configuredProfile = target && clean(target.profileId || target.profile);
  if (configuredProfile && profileId && configuredProfile !== clean(profileId)) return emptyTarget(true, 'file');
  if (target && (target.schemaVersion || target.processName || target.processNames || target.dataRoot || target.apiHost || target.cdp)) {
    const merged = { ...target };
    if (envBinary) {
      merged.binary = envBinary;
      merged.processNames = inferredProcessNames(envBinary, platform);
      delete merged.processName;
    }
    if (envVersion) merged.version = envVersion;
    return { ...validateTarget(merged, { platform }), configured: true, source: envBinary ? 'environment' : 'file' };
  }
  if (envBinary) return { configured: true, binary: envBinary, version: envVersion, source: 'environment' };
  if (!target) return emptyTarget();
  return {
    configured: true,
    binary: clean(target.binary || target.executable || target.path),
    version: envVersion || clean(target.version),
    source: 'file',
  };
}

function writeWorkBuddyTarget({ dataDir, profileId, target, platform = process.platform } = {}) {
  if (!dataDir) throw new Error('缺少 WorkDaddy 数据目录');
  const normalized = validateTarget(target, { platform });
  if (profileId && normalized.profileId !== profileId) throw new Error('客户端 profile 与当前 WorkDaddy 安装包不匹配');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = targetFile(dataDir);
  const temporary = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(normalized, null, 2) + '\n', { mode: 0o600 });
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    if (!error || !['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error.code)) throw error;
    fs.copyFileSync(temporary, file);
    fs.unlinkSync(temporary);
  }
  try { fs.chmodSync(file, 0o600); } catch (_) {}
  return normalized;
}

function removeWorkBuddyTarget({ dataDir } = {}) {
  if (!dataDir) return false;
  try { fs.unlinkSync(targetFile(dataDir)); return true; } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function cliValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : '';
}

function configureFromInstaller(argv = process.argv.slice(2)) {
  if (!argv.includes('--configure')) throw new Error('缺少 --configure');
  const profileId = clean(cliValue(argv, '--profile'));
  const binary = clean(cliValue(argv, '--binary'));
  const version = clean(cliValue(argv, '--version'));
  const dataDir = clean(cliValue(argv, '--data-dir'));
  const pathApi = platformPath('win32');
  const expectedName = profileId === 'workbuddy-ai' ? 'WorkBuddyAI.exe' : 'WorkBuddy.exe';
  const official = pathApi.basename(binary).toLowerCase() === expectedName.toLowerCase();
  const target = official
    ? buildOfficialTargetFromBinary({ binary, version, profileId, platform: 'win32' })
    : buildTargetFromBinary({
      binary,
      version,
      profileId,
      cdpPort: profileId === 'workbuddy-ai' ? 9233 : 9226,
      platform: 'win32',
    });
  const saved = writeWorkBuddyTarget({ dataDir, profileId, target, platform: 'win32' });
  process.stdout.write(JSON.stringify({ ok: true, name: pathApi.basename(saved.binary), version: saved.version || '', clientType: saved.clientType }) + '\n');
  return saved;
}

if (require.main === module && process.argv.slice(2).includes('--configure')) {
  try {
    configureFromInstaller();
  } catch (error) {
    process.stderr.write(String(error && error.message || error) + '\n');
    process.exitCode = 1;
  }
}

module.exports = {
  TARGET_FILE,
  apiHostFromAuth,
  buildOfficialTargetFromBinary,
  buildTargetFromBinary,
  configureFromInstaller,
  inferredProcessNames,
  readWorkBuddyTarget,
  removeWorkBuddyTarget,
  targetFile,
  validateTarget,
  writeWorkBuddyTarget,
};
