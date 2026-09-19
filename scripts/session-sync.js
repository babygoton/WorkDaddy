'use strict';

// Account copies share a logical session, but may have independent continuations.
// File times are only race detectors; they never choose a winning conversation.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 20000;
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

function readSnapshot(root, id, aliases = []) {
  if (!id || /[/\\\x00]/.test(id) || id === '.' || id === '..') throw Error('无效的会话标识');
  root = path.resolve(root);
  if (fs.lstatSync(root).isSymbolicLink()) throw Error('会话目录包含符号链接，未同步');
  const knownIds = Array.from(new Set([id, ...aliases]));
  const files = new Map();
  let total = 0;
  function visit(relative, logical) {
    const file = safePath(root, relative);
    let stat;
    try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return; throw Error('会话文件无法读取'); }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(file).sort()) visit(relative + '/' + entry, logical + '/' + entry);
      return;
    }
    if (!stat.isFile()) throw Error('会话文件类型不受支持');
    total += stat.size;
    if (total > MAX_BYTES || files.size >= MAX_FILES) throw Error('会话文件过大，未自动同步');
    const bytes = fs.readFileSync(file);
    const after = fs.statSync(file);
    if (stat.size !== bytes.length || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw Error('会话文件正在变化，请稍后重试');
    let semantic = digest(bytes);
    // Workspace files and history snapshots are user work products. Their
    // extension does not guarantee valid JSON (JSONC, drafts, empty files,
    // or arbitrary bytes). Preserve and compare those files byte-for-byte.
    // Only the official index needs structured identity normalization because
    // targetBytes rewrites its ownerConversationId during a copy.
    if (logical === 'artifact-index/__session__.json') {
      let value;
      try { value = JSON.parse(bytes.toString('utf8')); } catch (_) { throw Error('会话产物索引损坏，未同步'); }
      semantic = digest(JSON.stringify(canonical(value, knownIds)));
    }
    files.set(logical, { relative, bytes, hash: digest(bytes), semantic, mode: stat.mode & 0o777, mtimeMs: stat.mtimeMs });
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
  const transcripts = [...files].filter(([key]) => /^projects\/[^/]+\/__session__\.jsonl$/.test(key));
  if (transcripts.length > 1) throw Error('会话消息文件不唯一，未同步');
  let records = null, transcriptKey = null;
  if (transcripts.length) {
    transcriptKey = transcripts[0][0];
    const lines = transcripts[0][1].bytes.toString('utf8').split(/\r?\n/).filter(line => line.trim());
    if (!lines.length) throw Error('会话消息文件为空，未同步');
    records = lines.map(line => {
      let record;
      try { record = JSON.parse(line); } catch (_) { throw Error('会话消息文件未写完或已损坏，未同步'); }
      if (!record || typeof record !== 'object' || Array.isArray(record) || typeof record.type !== 'string') throw Error('会话消息格式不受支持，未同步');
      return digest(JSON.stringify(canonical(record, knownIds)));
    });
    // Require actual messages: a metadata-only journal is not an empty base.
    if (!lines.some(line => JSON.parse(line).type === 'message')) throw Error('会话消息文件没有消息，未同步');
    transcripts[0][1].semantic = digest(records.join('\n'));
  }
  return { root, id, aliases: knownIds, files, records, transcriptKey };
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
  const now = readSnapshot(snapshot.root, snapshot.id, snapshot.aliases);
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
  const verifyPublished = () => {
    if (!unchanged(source)) throw Error('源会话正在变化，已停止同步');
    const now = readSnapshot(target.root, target.id, target.aliases);
    if (now.files.size !== expected.size || [...expected].some(([key, hash]) => now.files.get(key)?.hash !== hash)) {
      throw Error('目标会话正在变化，已停止同步');
    }
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
    return { backup, copied: changes.length, journalPending };
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

module.exports = { readSnapshot, compareSnapshots, selectTargetSnapshot, applySnapshot };
