'use strict';

const crypto = require('node:crypto');
const { readAutomations, writeAutomations } = require('./automation');
const { previewPackage } = require('./automation-packages');
const { encodeZip, decodeZip, MAX_BYTES, MAX_ENTRY_BYTES } = require('./automation-zip');
const MAX_TASKS = 200;
function exportTasks(tasks, ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_TASKS || ids.some(id => typeof id !== 'string')) throw new Error('请先勾选要导出的任务');
  const selected = [...new Set(ids)].map(id => {
    const task = tasks.find(t => t.id === id);
    if (!task) throw new Error('所选任务不存在，请刷新后重试');
    const { compatible, manualRunnable, ...definition } = task;
    return definition;
  });
  const entries = selected.map((task, i) => {
    const content = Buffer.from(JSON.stringify(task, null, 2) + '\n');
    if (content.length > MAX_ENTRY_BYTES) throw new Error('单个任务不能超过 1 MiB');
    return { name: String(i + 1).padStart(3, '0') + '-' + String(task.id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) + '.json', content };
  });
  if (entries.length === 1) return { count: 1, filename: 'WorkDaddy-task-' + entries[0].name, encoding: 'utf8', content: entries[0].content.toString('utf8'), mimeType: 'application/json' };
  return { count: entries.length, filename: 'WorkDaddy-tasks-' + new Date().toISOString().slice(0, 10) + '.zip', encoding: 'base64', content: encodeZip(entries).toString('base64'), mimeType: 'application/zip' };
}
function readFiles(payload) {
  if (!payload || typeof payload.content !== 'string' || !payload.content.length) throw new Error('请选择 JSON 或 ZIP 任务文件');
  const encoding = payload.encoding || 'utf8';
  if (!['utf8', 'base64'].includes(encoding) || payload.content.length > Math.ceil(MAX_BYTES / 3) * 4) throw new Error('任务文件不能超过 8 MiB');
  if (encoding === 'base64' && (payload.content.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload.content))) throw new Error('任务文件编码无效');
  const bytes = Buffer.from(payload.content, encoding);
  if (bytes.length > MAX_BYTES) throw new Error('任务文件不能超过 8 MiB');
  const files = bytes.length >= 2 && bytes.readUInt16LE(0) === 0x4b50 ? decodeZip(bytes) : [{ name: 'task.json', content: bytes }];
  const documents = files.filter(f => !f.name.endsWith('/') && !f.name.startsWith('__MACOSX/') && !/(^|\/)\.DS_Store$/.test(f.name));
  if (!documents.length || documents.length > MAX_TASKS) throw new Error('单次支持导入 1–200 个任务');
  if (documents.some(f => !/\.json$/i.test(f.name) || f.content.length > MAX_ENTRY_BYTES)) throw new Error('ZIP 内只能包含任务 JSON，单个任务不能超过 1 MiB');
  return documents;
}
function previewImport(payload, existingTasks, runtime) {
  const seen = new Set(existingTasks.map(t => t.id));
  const entries = readFiles(payload).map((file, index) => {
    const key = String(index), sha256 = crypto.createHash('sha256').update(file.content).digest('hex');
    let name = file.name;
    try {
      const doc = JSON.parse(file.content.toString('utf8').replace(/^\uFEFF/, ''));
      const definition = doc && (doc.kind ? doc.task : doc.task || doc);
      if (!definition || typeof definition !== 'object' || !Array.isArray(definition.steps)) throw new Error('文件不是自动化任务 JSON');
      name = String(doc.name || definition.name || file.name).slice(0, 120);
      const preview = previewPackage(file.content, { runtime });
      if (!preview.compatible) return { key, name, compatible: false, existing: false, issues: preview.issues, task: null };
      const task = preview.task;
      if (preview.kind === 'package') {
        // File content identity is local deduplication, never publisher verification.
        task.id = 'import_' + sha256.slice(0, 32);
        task['x-workdaddy-import'] = { kind: 'local-file', packageId: preview.package.id, packageVersion: preview.package.version, sha256 };
      } else if (!definition.id) task.id = 'import_' + sha256.slice(0, 32);
      const existing = seen.has(task.id); seen.add(task.id);
      return { key, name, compatible: true, existing, issues: [], task };
    } catch (_) {
      return { key, name, compatible: false, existing: false, issues: [{ code: 'invalid_document' }], task: null };
    }
  });
  return { entries, executed: false };
}
function importTasks(dataDir, payload, runtime) {
  if (!Array.isArray(payload.selected) || !payload.selected.length || payload.selected.length > MAX_TASKS) throw new Error('请至少选择一项');
  // Re-read, revalidate and write once, synchronously. Preview is not an authority
  // to overwrite tasks added/edited while the import dialog was open.
  const tasks = readAutomations(dataDir), preview = previewImport(payload, tasks, runtime);
  const selected = [...new Set(payload.selected)].map(key => {
    const entry = preview.entries.find(e => e.key === key);
    if (!entry || !entry.compatible) throw new Error('所选任务不兼容或文件已损坏');
    return entry;
  });
  const added = selected.filter(e => !e.existing).map(e => e.task);
  if (added.length && tasks.length + added.length > MAX_TASKS) throw new Error('自动化任务数量已达到上限');
  if (added.length) writeAutomations(dataDir, [...added, ...tasks]);
  return { imported: added.length, skipped: selected.length - added.length, executed: false };
}
// These file endpoints use a bounded body reader instead of the legacy API reader.
function readTransferBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, failed = false;
    req.on('data', chunk => {
      if (failed) return;
      size += chunk.length;
      if (size > 12 * 1024 * 1024) { failed = true; chunks.length = 0; reject(new Error('任务文件不能超过 8 MiB')); return; }
      chunks.push(Buffer.from(chunk));
    });
    req.on('error', reject);
    req.on('end', () => {
      if (failed) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (_) { reject(new Error('任务文件编码无效')); }
    });
  });
}
module.exports = { exportTasks, previewImport, importTasks, readTransferBody };
