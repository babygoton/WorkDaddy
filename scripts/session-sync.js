'use strict';

// Account copies share a logical session, but may have independent continuations.
// File times are only race detectors; they never choose a winning conversation.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const identityKeys = new Set(['sessionId', 'conversationId', 'ownerConversationId', 'session_id', 'conversation_id']);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function canonical(value, aliases) {
  if (Array.isArray(value)) return value.map(item => canonical(item, aliases));
  if (!value || typeof value !== 'object') return value;
  const result = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    result[key] = identityKeys.has(key) && aliases.includes(value[key]) ? '__session__' : canonical(value[key], aliases);
  }
  return result;
}

function safePath(root, relative) {
  const parts = relative.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[\\\x00]/.test(part))) throw Error('无效的会话文件路径');
  let target = root;
  for (const part of parts) {
    target = path.join(target, part);
    try { if (fs.lstatSync(target).isSymbolicLink()) throw Error('会话文件包含符号链接，未同步'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return target;
}

// List views need byte counts, not message parsing or payload buffers. Limit
// concurrent scans, never the size/file count of a session itself.
async function readSessionSizes(root, ids) {
  root = path.resolve(root);
  const sizes = new Map();
  const sharedStats = new Map();
  async function stat(file) {
    try {
      const value = await fs.promises.lstat(file);
      if (value.isSymbolicLink()) throw Error('symbolic link');
      return value;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async function base(relative) {
    if (!sharedStats.has(relative)) sharedStats.set(relative, (async () => {
      const parent = relative ? await base(path.dirname(relative) === '.' ? '' : path.dirname(relative)) : true;
      if (!parent) return null;
      if (parent !== true && !parent.isDirectory()) throw Error('invalid directory');
      return stat(path.join(root, relative));
    })());
    return sharedStats.get(relative);
  }
  async function visit(file) {
    const info = await stat(file);
    if (!info) return 0;
    if (info.isFile()) return info.size;
    if (!info.isDirectory()) throw Error('unsupported file');
    let total = 0;
    for (const entry of await fs.promises.readdir(file)) total += await visit(path.join(file, entry));
    return total;
  }
  let projects;
  try {
    const info = await base('projects');
    projects = info ? (await fs.promises.readdir(path.join(root, 'projects'), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name) : [];
  } catch (_) { return new Map(ids.map(id => [id, null])); }
  const queue = Array.from(new Set(ids));
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (next < queue.length) {
      const id = queue[next++];
      try {
        if (typeof id !== 'string' || !id || /[/\\\x00]/.test(id) || id === '.' || id === '..') throw Error('invalid id');
        let total = 0;
        const paths = projects.flatMap(project => ['projects/' + project + '/' + id + '.jsonl', 'projects/' + project + '/' + id]);
        paths.push('workspace/sessions/' + id, 'tasks/' + id, 'file-history/' + id, 'artifact-index/' + id + '.json');
        for (const relative of paths) {
          const parent = await base(path.dirname(relative));
          if (parent) {
            if (!parent.isDirectory()) throw Error('invalid directory');
            total += await visit(path.join(root, relative));
          }
        }
        sizes.set(id, total);
      } catch (_) { sizes.set(id, null); }
    }
  }));
  return sizes;
}

function aliasesEqual(left, right) {
  if (!Array.isArray(left) || left.length !== right.length) return false;
  const set = new Set(right);
  return left.every(value => set.has(value));
}

// Fingerprint cache: relative path -> { size, mtimeMs, ctimeMs, hash, mode,
// semantic, aliases, records }. A file whose size/mtime/ctime all match the
// cached fingerprint reuses its SHA-256 without being re-read; bytes load
// lazily (only files actually copied/backed up are read). Transcript records
// and the artifact index hash depend on the alias set, so those are reused
// only when computed for the same aliases.
function readSnapshot(root, id, aliases = [], cache = null) {
  if (!id || /[/\\\x00]/.test(id) || id === '.' || id === '..') throw Error('无效的会话标识');
  root = path.resolve(root);
  if (fs.lstatSync(root).isSymbolicLink()) throw Error('会话目录包含符号链接，未同步');
  const knownIds = Array.from(new Set([id, ...aliases]));
  const files = new Map();
  let total = 0;
  // Directory components repeat across thousands of session files. Verify each
  // path component once per snapshot instead of lstat-ing the whole chain per
  // file; the per-entry symlink/type checks below still apply to every file.
  const trustedComponents = new Map();
  function safePathFast(relative) {
    const parts = relative.split('/');
    let target = root;
    for (let i = 0; i < parts.length - 1; i++) {
      target = path.join(target, parts[i]);
      if (trustedComponents.has(target)) continue;
      try { if (fs.lstatSync(target).isSymbolicLink()) throw Error('会话文件包含符号链接，未同步'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      trustedComponents.set(target, true);
    }
    return path.join(target, parts[parts.length - 1]);
  }
  function attachBytes(entry) {
    if (entry.bytes) return;
    let loaded = null;
    Object.defineProperty(entry, 'bytes', {
      enumerable: true,
      get() {
        if (loaded) return loaded;
        const file = safePath(root, entry.relative);
        let now;
        try { now = fs.statSync(file); } catch (_) { throw Error('会话文件正在变化，请稍后重试'); }
        if (now.size !== entry.size || now.mtimeMs !== entry.mtimeMs || now.ctimeMs !== entry.ctimeMs) throw Error('会话文件正在变化，请稍后重试');
        loaded = fs.readFileSync(file);
        return loaded;
      },
    });
  }
  function cached(relative, stat) {
    if (!cache) return null;
    const entry = cache.get(relative);
    if (!entry || typeof entry !== 'object') return null;
    if (entry.size !== stat.size || entry.mtimeMs !== stat.mtimeMs || entry.ctimeMs !== stat.ctimeMs) return null;
    if (typeof entry.hash !== 'string' || !entry.hash) return null;
    return entry;
  }
  function visit(relative, logical) {
    const file = safePathFast(relative);
    let stat;
    try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return; throw Error('会话文件无法读取'); }
    if (stat.isSymbolicLink()) throw Error('会话文件包含符号链接，未同步');
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(file).sort()) visit(relative + '/' + entry, logical + '/' + entry);
      return;
    }
    if (!stat.isFile()) throw Error('会话文件类型不受支持');
    total += stat.size;
    const hit = cached(relative, stat);
    if (hit) {
      const entry = {
        relative, hash: hit.hash, mode: stat.mode & 0o777, mtimeMs: stat.mtimeMs,
        size: stat.size, ctimeMs: stat.ctimeMs,
        semantic: typeof hit.semantic === 'string' && hit.semantic ? hit.semantic : null,
        semanticAliases: Array.isArray(hit.aliases) ? hit.aliases : null,
        records: Array.isArray(hit.records) ? hit.records : null,
      };
      attachBytes(entry);
      files.set(logical, entry);
      return;
    }
    const bytes = fs.readFileSync(file);
    const after = fs.statSync(file);
    if (stat.size !== bytes.length || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw Error('会话文件正在变化，请稍后重试');
    files.set(logical, {
      relative, bytes, hash: digest(bytes), mode: stat.mode & 0o777, mtimeMs: stat.mtimeMs,
      size: after.size, ctimeMs: after.ctimeMs,
      semantic: null, semanticAliases: null, records: null,
    });
  }
  const projects = safePath(root, 'projects');
  if (fs.existsSync(projects)) {
    for (const entry of fs.readdirSync(projects, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      visit('projects/' + entry.name + '/' + id + '.jsonl', 'projects/' + entry.name + '/__session__.jsonl');
      visit('projects/' + entry.name + '/' + id, 'projects/' + entry.name + '/__session__');
    }
  }
  for (const prefix of ['workspace/sessions', 'tasks', 'file-history']) visit(prefix + '/' + id, prefix + '/__session__');
  visit('artifact-index/' + id + '.json', 'artifact-index/__session__.json');
  // Workspace files and history snapshots are user work products. Their
  // extension does not guarantee valid JSON (JSONC, drafts, empty files,
  // or arbitrary bytes). Preserve and compare those files byte-for-byte.
  // Only the official index needs structured identity normalization because
  // targetBytes rewrites its ownerConversationId during a copy.
  const transcripts = [...files].filter(([key]) => /^projects\/[^/]+\/__session__\.jsonl$/.test(key));
  if (transcripts.length > 1) throw Error('会话消息文件不唯一，未同步');
  let records = null, transcriptKey = null;
  if (transcripts.length) {
    transcriptKey = transcripts[0][0];
    const entry = transcripts[0][1];
    if (!(entry.records && entry.semantic && aliasesEqual(entry.semanticAliases, knownIds))) {
      const lines = entry.bytes.toString('utf8').split(/\r?\n/).filter(line => line.trim());
      if (!lines.length) throw Error('会话消息文件为空，未同步');
      entry.records = lines.map(line => {
        let record;
        try { record = JSON.parse(line); } catch (_) { throw Error('会话消息文件未写完或已损坏，未同步'); }
        if (!record || typeof record !== 'object' || Array.isArray(record) || typeof record.type !== 'string') throw Error('会话消息格式不受支持，未同步');
        return digest(JSON.stringify(canonical(record, knownIds)));
      });
      // Require actual messages: a metadata-only journal is not an empty base.
      if (!lines.some(line => JSON.parse(line).type === 'message')) throw Error('会话消息文件没有消息，未同步');
      entry.semantic = digest(entry.records.join('\n'));
      entry.semanticAliases = [...knownIds];
    }
    records = entry.records;
  }
  const indexEntry = files.get('artifact-index/__session__.json');
  if (indexEntry && !(indexEntry.semantic && aliasesEqual(indexEntry.semanticAliases, knownIds))) {
    let value;
    try { value = JSON.parse(indexEntry.bytes.toString('utf8')); } catch (_) { throw Error('会话产物索引损坏，未同步'); }
    indexEntry.semantic = digest(JSON.stringify(canonical(value, knownIds)));
    indexEntry.semanticAliases = [...knownIds];
  }
  for (const [key, entry] of files) {
    if (!entry.semantic) entry.semantic = entry.hash;
    if (cache) {
      cache.set(entry.relative, {
        size: entry.size, mtimeMs: entry.mtimeMs, ctimeMs: entry.ctimeMs,
        hash: entry.hash, mode: entry.mode, semantic: entry.semantic,
        aliases: entry.semanticAliases ? [...entry.semanticAliases] : null,
        records: entry.records ? [...entry.records] : null,
      });
    }
  }
  return { root, id, aliases: knownIds, files, records, transcriptKey, totalBytes: total, cache };
}

function compareSnapshots(left, right) {
  const a = left.records, b = right.records;
  if (!a && !b) throw Error('双方会话消息文件均缺失，未同步');
  if (!a || !b) {
    const missing = a ? right : left, complete = a ? left : right;
    // A missing journal is repairable only when surviving supporting files
    // agree. Unknown/different surviving content is never discarded.
    for (const [key, file] of missing.files) {
      if (!complete.files.has(key) || complete.files.get(key).semantic !== file.semantic) throw Error('会话消息缺失且附属文件不一致，未覆盖');
    }
    return { kind: a ? 'left-extends' : 'right-extends' };
  }
  if (left.transcriptKey !== right.transcriptKey) return { kind: 'conflict' };
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return { kind: 'conflict' };
  if (a.length !== b.length) return { kind: a.length > b.length ? 'left-extends' : 'right-extends' };
  for (const [key, file] of left.files) {
    if (right.files.has(key) && right.files.get(key).semantic !== file.semantic) return { kind: 'conflict' };
  }
  const missingRight = [...left.files.keys()].some(key => !right.files.has(key));
  const missingLeft = [...right.files.keys()].some(key => !left.files.has(key));
  return { kind: missingRight || missingLeft ? 'repair' : 'equal', missingRight, missingLeft };
}

// Legacy copies can leave several physical sessions in the target account.
// Choose by complete content, never by timestamps or the mapping alone. Keep
// only hashes while scanning, so duplicate workspaces do not accumulate in RAM.
async function selectTargetSnapshot(source, targetIds, readTarget, preferredId) {
  const ordered = [...new Set(targetIds)].sort((a, b) => {
    if (a === preferredId) return -1;
    if (b === preferredId) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const repairs = [], ancestors = [], descendants = [], errors = [];
  for (const id of ordered) {
    try {
      const snapshot = await readTarget(id);
      const comparison = compareSnapshots(source, snapshot);
      const candidate = { targetId: id, comparison, snapshot: {
        id: snapshot.id, records: snapshot.records, transcriptKey: snapshot.transcriptKey,
        files: new Map([...snapshot.files].map(([key, file]) => [key, { semantic: file.semantic }])),
      } };
      // An existing complete copy already satisfies this source, even when
      // other legacy copies have diverged or become unreadable.
      if (comparison.kind === 'equal') return candidate;
      if (comparison.kind === 'repair') repairs.push(candidate);
      if (comparison.kind === 'left-extends') ancestors.push(candidate);
      if (comparison.kind === 'right-extends') descendants.push(candidate);
    } catch (error) { errors.push(error); }
  }
  if (repairs.length) return repairs[0];
  const longestFirst = (a, b) => (b.snapshot.records?.length || 0) - (a.snapshot.records?.length || 0);
  if (descendants.length) {
    descendants.sort(longestFirst);
    const longest = descendants[0];
    // Several continuations of the source may be different branches. A
    // stored mapping must never decide which branch replaces that source.
    if (descendants.some(candidate => compareSnapshots(longest.snapshot, candidate.snapshot).kind === 'conflict')) {
      return { targetId: null, comparison: { kind: 'conflict' } };
    }
    return longest;
  }
  if (ancestors.length) return ancestors.sort(longestFirst)[0];
  // Unreadable content remains an actual failure when no safe match exists.
  if (errors.length) throw errors[0];
  return { targetId: null, comparison: { kind: 'conflict' } };
}

function unchanged(snapshot) {
  const now = readSnapshot(snapshot.root, snapshot.id, snapshot.aliases, snapshot.cache || null);
  return now.files.size === snapshot.files.size && [...snapshot.files].every(([key, file]) => now.files.get(key)?.hash === file.hash);
}

function targetRelative(logical, id) {
  return logical.split('/').map(part => part === '__session__' ? id : part === '__session__.jsonl' ? id + '.jsonl' : part === '__session__.json' ? id + '.json' : part).join('/');
}

function targetBytes(key, file, source, target) {
  if (key !== 'artifact-index/__session__.json') return file.bytes;
  const index = JSON.parse(file.bytes.toString('utf8'));
  const artifacts = Array.isArray(index) ? index : index && index.artifacts;
  if (!Array.isArray(artifacts)) throw Error('产物索引格式不受支持');
  for (const artifact of artifacts) {
    if (artifact?._meta && source.aliases.includes(artifact._meta.ownerConversationId)) artifact._meta.ownerConversationId = target.id;
  }
  return Buffer.from(JSON.stringify(index));
}

async function applySnapshot(source, target, options) {
  const { backupRoot, commit = async () => {}, guard = async () => {}, missingOnly = false } = options;
  if (source.root !== target.root || source.id === target.id) throw Error('无效的会话同步目标');
  const changes = [];
  for (const [key, file] of source.files) {
    if (missingOnly && target.files.has(key)) continue;
    const bytes = targetBytes(key, file, source, target);
    if (target.files.get(key)?.hash === digest(bytes)) continue;
    changes.push({ key, relative: targetRelative(key, target.id), bytes, mode: file.mode, mtimeMs: file.mtimeMs });
  }
  if (!missingOnly) for (const [key, file] of target.files) {
    if (!source.files.has(key)) changes.push({ key, relative: file.relative, bytes: null });
  }
  await guard();
  if (!unchanged(source) || !unchanged(target)) throw Error('会话文件正在变化，请稍后重试');
  fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const backup = fs.mkdtempSync(path.join(backupRoot, 'sync-'));
  fs.chmodSync(backup, 0o700);
  for (const [key, file] of target.files) {
    const filePath = safePath(backup, 'files/' + key);
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filePath, file.bytes, { mode: 0o600, flag: 'wx' });
  }
  const journal = { version: 1, sourceId: source.id, targetId: target.id, status: 'prepared', metadata: options.metadata || null,
    files: [...target.files].map(([key, file]) => ({ key, relative: file.relative, mode: file.mode, mtimeMs: file.mtimeMs })),
    changes: changes.map(change => ({ relative: change.relative, hash: change.bytes === null ? null : digest(change.bytes) })) };
  const journalFile = path.join(backup, 'journal.json');
  const save = () => fs.writeFileSync(journalFile, JSON.stringify(journal), { mode: 0o600 });
  save();
  const expected = new Map([...target.files].map(([key, file]) => [key, file.hash]));
  for (const change of changes) {
    if (change.bytes === null) expected.delete(change.key);
    else expected.set(change.key, digest(change.bytes));
  }
  let totalBytes = 0;
  const verifyPublished = () => {
    if (!unchanged(source)) throw Error('源会话正在变化，已停止同步');
    const now = readSnapshot(target.root, target.id, target.aliases, target.cache || null);
    if (now.files.size !== expected.size || [...expected].some(([key, hash]) => now.files.get(key)?.hash !== hash)) {
      throw Error('目标会话正在变化，已停止同步');
    }
    totalBytes = now.totalBytes;
  };
  const applied = [];
  try {
    // Snapshot all old bytes before publication. Recheck after the async guard.
    await guard();
    if (!unchanged(source) || !unchanged(target)) throw Error('会话文件正在变化，请稍后重试');
    for (const change of changes) {
      const file = safePath(target.root, change.relative);
      const old = target.files.get(change.key);
      const exists = fs.existsSync(file);
      if (old ? !exists || digest(fs.readFileSync(file)) !== old.hash : exists) throw Error('目标会话正在变化，已停止同步');
      if (change.bytes === null) fs.unlinkSync(file);
      else {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const staged = path.join(path.dirname(file), '.wbs-sync-' + crypto.randomUUID());
        try {
          fs.writeFileSync(staged, change.bytes, { mode: change.mode || 0o600, flag: 'wx' });
          if (digest(fs.readFileSync(staged)) !== digest(change.bytes)) throw Error('会话文件校验失败');
          fs.utimesSync(staged, new Date(change.mtimeMs), new Date(change.mtimeMs));
          fs.renameSync(staged, file);
        } finally { if (fs.existsSync(staged)) fs.unlinkSync(staged); }
      }
      applied.push(change);
    }
    verifyPublished();
    // The DB adapter calls this again after its asynchronous row/idle checks.
    await commit(verifyPublished);
    journal.status = 'committed';
    // Metadata already committed: a journal I/O failure must not undo files.
    let journalPending = false;
    try { save(); } catch (_) { journalPending = true; }
    // Count only newly published payload bytes. Backups, unchanged files and
    // removals are not copied session data; rolled-back writes never reach here.
    const copiedBytes = changes.reduce((sum, change) => sum + (change.bytes ? change.bytes.length : 0), 0);
    return { backup, copied: changes.length, copiedBytes, journalPending, totalBytes };
  } catch (error) {
    // Do not roll back over an official write that happened after publication.
    let incomplete = false;
    for (const change of applied.reverse()) {
      try {
        const file = safePath(target.root, change.relative);
        if (change.bytes === null ? fs.existsSync(file) : !fs.existsSync(file) || digest(fs.readFileSync(file)) !== digest(change.bytes)) { incomplete = true; continue; }
        const old = target.files.get(change.key);
        if (old) {
          fs.writeFileSync(file, old.bytes, { mode: old.mode });
          fs.utimesSync(file, new Date(old.mtimeMs), new Date(old.mtimeMs));
        } else if (fs.existsSync(file)) fs.unlinkSync(file);
      } catch (_) { incomplete = true; }
    }
    journal.status = incomplete ? 'recovery-needed' : 'rolled-back';
    try { save(); } catch (_) { /* Keep the original failure and retained backup. */ }
    throw error;
  }
}

module.exports = { readSessionSizes, readSnapshot, compareSnapshots, selectTargetSnapshot, applySnapshot };
