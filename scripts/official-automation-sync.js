'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const AUTOMATION_COLUMNS = [
  'id', 'name', 'prompt', 'status', 'schedule_type', 'next_run_at', 'last_run_at',
  'cwds', 'rrule', 'scheduled_at', 'valid_from', 'valid_until', 'model_id',
  'model_is_thinking', 'skills_json', 'push_to_wechat', 'push_to_wecom_bot',
  'owner_user_id', 'owner_status', 'owner_source', 'expert_id', 'expert_marketplace',
  'connector_ids_json', 'permission_mode', 'created_at', 'updated_at', 'deleted_at',
  'wecom_bot_source', 'context_window', 'reasoning_effort', 'workspace_scope',
  'wecom_bot_chat_id',
];

// Older WorkBuddy builds inserted NULL into columns that are NOT NULL in the
// current schema. Reusing the official defaults keeps those historical tasks
// copyable while preserving NULL for genuinely nullable columns.
const AUTOMATION_DEFAULTS = {
  cwds: '[]',
  rrule: '',
  model_is_thinking: 0,
  skills_json: '[]',
  push_to_wechat: 0,
  push_to_wecom_bot: 0,
  owner_status: 'legacy_unassigned',
  connector_ids_json: '[]',
};

function cleanUid(value) {
  const uid = String(value || '').trim();
  return /^[A-Za-z0-9_-]{1,128}$/.test(uid) ? uid : '';
}

function readMapping(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (_) {
    return {};
  }
}

function writeMapping(file, mapping) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(mapping, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function taskKey(sourceUid, sourceId, targetUid) {
  return `${sourceUid}:${sourceId}:${targetUid}`;
}

function sameTask(a, b) {
  return String(a.name || '') === String(b.name || '') &&
    String(a.prompt || '') === String(b.prompt || '') &&
    String(a.schedule_type || '') === String(b.schedule_type || '') &&
    String(a.rrule || '') === String(b.rrule || '');
}

function nodeKey(uid, id) {
  return `${uid}:${id}`;
}

function taskFreshness(row) {
  const updated = Number(row && row.updated_at);
  if (Number.isFinite(updated)) return updated;
  const created = Number(row && row.created_at);
  return Number.isFinite(created) ? created : 0;
}

function compareTargetRows(left, right) {
  // When old mappings contain more than one physical copy, preserve the row
  // the user edited most recently and remove the older generated copies. The
  // ID tie-break makes the result deterministic across sync directions.
  const freshness = taskFreshness(right) - taskFreshness(left);
  if (freshness) return freshness;
  return String(left && left.id || '').localeCompare(String(right && right.id || ''));
}

function mappingGraph(mapping) {
  const graph = new Map();
  const ordered = [];
  const connect = (left, right) => {
    if (!graph.has(left)) graph.set(left, new Set());
    if (!graph.has(right)) graph.set(right, new Set());
    graph.get(left).add(right);
    graph.get(right).add(left);
  };
  Object.entries(mapping || {}).forEach(([key, value]) => {
    const parts = String(key).split(':');
    if (parts.length < 3 || !value || typeof value !== 'object') return;
    const sourceUid = parts.shift();
    const targetUid = parts.pop();
    const sourceId = parts.join(':');
    const targetId = String(value.targetAutomationId || '').trim();
    if (!cleanUid(sourceUid) || !cleanUid(targetUid) || !sourceId || !targetId) return;
    const sourceNode = nodeKey(sourceUid, sourceId);
    const targetNode = nodeKey(targetUid, targetId);
    connect(sourceNode, targetNode);
    ordered.push({ sourceUid, sourceId, targetUid, targetId, sourceNode, targetNode });
  });
  return { graph, ordered };
}

function componentNodes(graph, start) {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const node = queue.shift();
    for (const next of graph.get(node) || []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

function insertStatement(source, targetUid, id) {
  const columns = AUTOMATION_COLUMNS;
  const values = columns.map((column) => {
    if (column === 'id') return id;
    if (column === 'owner_user_id') return targetUid;
    const value = source[column];
    if (value === undefined || value === null) {
      return Object.prototype.hasOwnProperty.call(AUTOMATION_DEFAULTS, column)
        ? AUTOMATION_DEFAULTS[column] : null;
    }
    return value;
  });
  const placeholders = columns.map(() => '?').join(', ');
  return {
    sql: `INSERT INTO automations (${columns.join(', ')}) VALUES (${placeholders})`,
    params: values,
  };
}

function createOfficialAutomationSync(options = {}) {
  const db = options.db;
  const dataDir = String(options.dataDir || '');
  const mappingFile = options.mappingFile || path.join(dataDir, 'official-automation-sync.json');
  const idFactory = options.idFactory || (() => crypto.randomUUID());
  if (!db || typeof db.all !== 'function') throw new TypeError('缺少官方定时任务数据库');

  return async function syncOfficialAutomations(sourceValue, targetValue) {
    const sourceUid = cleanUid(sourceValue);
    const targetUid = cleanUid(targetValue);
    if (!sourceUid || !targetUid || sourceUid === targetUid) return { copied: 0, skipped: 0, total: 0 };

    const select = `SELECT ${AUTOMATION_COLUMNS.join(', ')} FROM automations
      WHERE owner_user_id = ? AND deleted_at IS NULL
        AND (status IS NULL OR status <> 'ARCHIVED')`;
    const sourceRows = await db.all(select, [sourceUid]);
    const targetRows = await db.all(select, [targetUid]);
    const targetById = new Map(targetRows.map((row) => [String(row.id || ''), row]));
    const mapping = readMapping(mappingFile);
    const nextMapping = { ...mapping };
    const { graph, ordered } = mappingGraph(mapping);
    const statements = [];
    const cleanupIds = new Set();
    let skipped = 0;
    let copied = 0;

    for (const source of sourceRows) {
      const sourceId = String(source.id || '').trim();
      if (!sourceId) continue;
      const key = taskKey(sourceUid, sourceId, targetUid);
      const previous = nextMapping[key];
      const previousId = previous && String(previous.targetAutomationId || '').trim();
      const component = componentNodes(graph, nodeKey(sourceUid, sourceId));
      const componentTargetIds = new Set();
      for (const item of ordered) {
        if (!component.has(item.sourceNode) && !component.has(item.targetNode)) continue;
        if (item.targetUid === targetUid && targetById.has(item.targetId)) componentTargetIds.add(item.targetId);
      }
      if (previousId && targetById.has(previousId)) componentTargetIds.add(previousId);
      // A task can travel through several accounts. Use the first mapped row
      // for this target as the stable lineage row, even if a later account
      // renamed its copy. This prevents renames from creating a new task ID.
      const lineageCandidates = [];
      for (const item of ordered) {
        if (item.targetUid !== targetUid || !component.has(item.targetNode) || !targetById.has(item.targetId)) continue;
        if (!lineageCandidates.some((row) => row.id === item.targetId)) lineageCandidates.push(targetById.get(item.targetId));
      }
      const lineageTargetId = lineageCandidates.sort(compareTargetRows)[0]?.id || '';
      if (!lineageTargetId && previousId && targetById.has(previousId)) lineageTargetId = previousId;
      if (lineageTargetId) componentTargetIds.add(lineageTargetId);
      if (lineageTargetId) {
        nextMapping[key] = {
          targetAutomationId: lineageTargetId,
          sourceUpdatedAt: source.updated_at == null ? null : String(source.updated_at),
        };
        for (const duplicateId of componentTargetIds) {
          if (duplicateId !== lineageTargetId) cleanupIds.add(duplicateId);
        }
        skipped++;
        continue;
      }

      // If a prior WorkBuddy copy already exists but the mapping file was lost,
      // adopt the matching target row and preserve any edits made there.
      const existing = targetRows.find((row) => sameTask(row, source));
      if (existing) {
        nextMapping[key] = {
          targetAutomationId: String(existing.id),
          sourceUpdatedAt: source.updated_at == null ? null : String(source.updated_at),
        };
        skipped++;
        continue;
      }

      const targetId = String(idFactory());
      if (!/^[0-9a-f-]{8,128}$/i.test(targetId) || targetById.has(targetId)) throw new Error('官方定时任务 ID 无效');
      statements.push(insertStatement(source, targetUid, targetId));
      nextMapping[key] = {
        targetAutomationId: targetId,
        sourceUpdatedAt: source.updated_at == null ? null : String(source.updated_at),
      };
      targetById.set(targetId, { ...source, id: targetId, owner_user_id: targetUid });
      copied++;
    }

    for (const id of cleanupIds) {
      statements.push({
        sql: 'DELETE FROM automations WHERE id = ? AND owner_user_id = ?',
        params: [id, targetUid],
      });
    }

    if (statements.length) {
      if (typeof db.transaction === 'function') await db.transaction(statements);
      else for (const statement of statements) await db.run(statement.sql, statement.params);
    }
    if (copied || skipped || cleanupIds.size) writeMapping(mappingFile, nextMapping);
    return { copied, skipped, total: sourceRows.length };
  };
}

module.exports = {
  AUTOMATION_COLUMNS,
  cleanUid,
  createOfficialAutomationSync,
};
