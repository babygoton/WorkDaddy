#!/usr/bin/env node
/**
 * 会话分叉（对标 Codex 桌面版的 Fork）
 *
 * WorkBuddy 没有原生的「分支」按钮。本模块把一个会话的本机记录按「消息锚点」切成前段，
 * 产出新会话所需的记录文本：**只保留到所选消息为止，之后的不纳入；源会话不被修改**。
 *
 * 本模块只做纯计算（解析 / 锚点 / 切片 / 生成新标题），不写数据库、不改任何文件。
 * 落库由 daemon.js 完成：写入新的 `projects/<slug>/<id>.jsonl` 并插入 sessions 记录。
 *
 * 用法:
 *   node scripts/session-fork.js --id <会话ID> --points
 *   node scripts/session-fork.js --id <会话ID> --until 12 [--out <文件>] [--json]
 *   node scripts/session-fork.js --file <记录文件> --until "09-17 15:30"
 *   [--data-dir <数据根>]  [--max <锚点条数>]  [--dry-run]
 *
 * 分叉只支持「保留前缀到某个锚点为止」，不做区间切片：丢掉前缀会让新会话从半轮开始，
 * 缺少开头的 user 消息，反而不可用。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// 一条记录最多多大：超过就 fail closed，避免把异常文件读进内存
const MAX_RECORD_BYTES = 64 * 1024 * 1024;
// 锚点序号上限，防止把非数字或超大的值当成合法锚点
const MAX_ANCHOR = 100000;
// 分叉后标题的长度上限（含后缀）
const TITLE_LIMIT = 60;
const DEFAULT_SUFFIX = '（分支）';
// harness 注入块的起始标记：这类 user 记录不是用户真说的话
const INJECTED_PREFIX = /^\s*<(cb_summary|system-reminder|additional_data|identity_context|task-notification)/;
// 锚点只计这两种角色的消息
const ANCHOR_ROLES = new Set(['user', 'assistant']);

/**
 * 逐行解析 JSONL。坏行跳过并计数（会话进行中追加写，最后一行可能是半截 JSON）。
 * 每条记录保留原始行，切片时按原样输出，避免重新序列化改写未知字段。
 */
function parseRecords(text) {
  const records = [];
  let skipped = 0;
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      records.push({ line, value: JSON.parse(line) });
    } catch (_) {
      skipped++;
    }
  }
  return { records, skipped };
}

/** 记录里的可见正文（content[].text），不含思考与工具参数 */
function messageText(record) {
  if (!record || !Array.isArray(record.content)) return '';
  let text = '';
  for (const item of record.content) {
    if (item && typeof item.text === 'string') text += item.text;
  }
  return text.trim();
}

/**
 * user 消息的正文。
 *
 * 先抽 `<user_query>` 里的真话 —— 注入块与用户真话可能落在同一条记录里，先抽就不会漏。
 * 抽不到、且整条以 harness 注入块开头时返回空串，调用方据此跳过该记录。
 */
function userQueryText(record) {
  const raw = messageText(record);
  if (!raw) return '';
  const matched = raw.match(/<user_query>([\s\S]*?)<\/user_query>/);
  if (matched) return matched[1].trim();
  if (INJECTED_PREFIX.test(raw)) return '';
  return raw;
}

/**
 * 打锚点：按出现顺序给每条 user / assistant 消息编号。
 * 锚点序号 n 从 1 开始，index 是它在 records 里的下标。
 */
function buildAnchors(records) {
  const anchors = [];
  records.forEach((entry, index) => {
    const record = entry.value;
    if (!record || record.type !== 'message' || !ANCHOR_ROLES.has(record.role)) return;
    const text = record.role === 'user' ? userQueryText(record) : messageText(record);
    if (!text) return;
    anchors.push({
      n: anchors.length + 1,
      index,
      role: record.role,
      timestamp: Number(record.timestamp) || 0,
      chars: text.length,
      text,
    });
  });
  return anchors;
}

function clockOf(timestamp) {
  if (!timestamp) return '--:--';
  return new Date(timestamp).toISOString().slice(5, 16).replace('T', ' ');
}

/**
 * 解析锚点选择器：`12` / `#12` / `MM-DD HH:MM` / `HH:MM`（时间从尾部往前找第一个匹配）。
 * 解析不出来返回 null —— 调用方必须据此报错，不能猜一个默认锚点。
 */
function resolveAnchor(spec, anchors) {
  if (spec === undefined || spec === null || spec === true) return null;
  const text = String(spec).replace(/^#/, '').trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    if (!Number.isSafeInteger(n) || n < 1 || n > MAX_ANCHOR) return null;
    return anchors.find((anchor) => anchor.n === n) || null;
  }
  for (let i = anchors.length - 1; i >= 0; i--) {
    if (clockOf(anchors[i].timestamp).includes(text)) return anchors[i];
  }
  return null;
}

/**
 * 切点：锚点所在这一轮结束的位置。
 *
 * 记录顺序是「消息正文 → 该轮的工具调用与结果 → 下一条消息」，因此直接砍在锚点记录之后
 * 会留下没有结果的 function_call。切点取**下一条 message 记录之前**，这样保留的是完整的一轮，
 * 同时锚点之后的新对话内容一条都不带进来。
 */
function cutIndexFor(anchor, records) {
  for (let i = anchor.index + 1; i < records.length; i++) {
    if (records[i].value && records[i].value.type === 'message') return i;
  }
  return records.length;
}

/** 分叉后的标题：截断 + 后缀，避免超长标题 */
function forkedTitle(title, suffix = DEFAULT_SUFFIX) {
  const base = String(title || '').trim();
  const tail = String(suffix || '');
  if (!base) return tail.slice(0, TITLE_LIMIT);
  const room = Math.max(1, TITLE_LIMIT - tail.length);
  const head = base.length > room ? base.slice(0, room) : base;
  return head + tail;
}

/**
 * 生成分叉方案。返回的对象里：
 * - `ok:false` 时 `reason` 说明为什么不能分叉，调用方必须原样报错，不要静默降级
 * - `text` 是新会话要写入的记录文本（保留原始行）
 * - `keep` / `drop` 是保留与丢弃的锚点数量，用于回显「本次只带了 #1–#7」
 */
function planFork(text, spec, options = {}) {
  const suffix = options.suffix === undefined ? DEFAULT_SUFFIX : options.suffix;
  const parsed = parseRecords(text);
  if (parsed.records.length === 0) return { ok: false, reason: '会话记录为空', records: [], anchors: [], skipped: parsed.skipped };
  const anchors = buildAnchors(parsed.records);
  if (anchors.length === 0) return { ok: false, reason: '会话里没有可分叉的消息', records: parsed.records, anchors, skipped: parsed.skipped };

  const anchor = resolveAnchor(spec, anchors);
  if (!anchor) return { ok: false, reason: `锚点没解析出来：${String(spec)}`, records: parsed.records, anchors, skipped: parsed.skipped };

  const cut = cutIndexFor(anchor, parsed.records);
  const kept = parsed.records.slice(0, cut);
  const keptAnchors = anchors.filter((item) => item.index < cut);
  if (keptAnchors.length === 0) return { ok: false, reason: '分叉点之前没有可保留的消息', records: parsed.records, anchors, skipped: parsed.skipped };

  return {
    ok: true,
    anchor,
    anchors,
    records: parsed.records,
    skipped: parsed.skipped,
    keep: keptAnchors.length,
    drop: anchors.length - keptAnchors.length,
    keptRecords: kept.length,
    droppedRecords: parsed.records.length - kept.length,
    text: kept.map((entry) => entry.line).join('\n') + '\n',
  };
}

// Renderer message IDs are not the JSONL record IDs. Cross-check the ordered
// roles and the selected assistant's completion time before using its position.
function planForkAtMessage(text, selection) {
  const invalid = (reason) => ({ ok: false, reason });
  const roles = selection && selection.roles;
  const index = selection && selection.messageIndex;
  const finishedAt = selection && selection.finishedAt;
  if (typeof roles !== 'string' || !/^[ua]{2,10000}$/.test(roles) ||
      roles[0] !== 'u' || roles[roles.length - 1] !== 'a' ||
      !Number.isInteger(index) || index < 0 || index >= roles.length ||
      roles[index] !== 'a' ||
      !Number.isSafeInteger(finishedAt) || finishedAt <= 0) {
    return invalid('分支消息参数无效');
  }
  const parsed = parseRecords(text);
  if (parsed.skipped) return invalid('会话记录正在写入或包含损坏的行，请稍后重试');

  // The renderer may hide task-notification user records and merge consecutive
  // assistant records from one streamed turn. The selected role guards the
  // index, while finishedAt identifies the exact JSONL assistant record without
  // assuming the two representations have the same number of records.
  const messages = parsed.records.map((entry, recordIndex) => ({
    recordIndex, value: entry.value,
  })).filter((entry) => entry.value && entry.value.type === 'message' &&
    ANCHOR_ROLES.has(entry.value.role));
  const assistantMessages = messages.filter((entry) => entry.value.role === 'assistant');
  const rawRoles = messages.map((entry) => entry.value.role === 'user' ? 'u' : 'a').join('');
  let selected;
  if (rawRoles === roles) {
    // When both sides expose the same record shape, messageIndex is the
    // renderer message position. This also handles consecutive assistant
    // records emitted by streamed replies.
    selected = messages[index];
  } else {
    // In streamed files, the same visible assistant can span several JSONL
    // records. The completion timestamp is the stable cross-representation key.
    selected = assistantMessages.find((entry) => Number(entry.value.timestamp) === finishedAt);
  }
  if (!selected && rawRoles !== roles) {
    selected = assistantMessages
      .filter((entry) => Number.isSafeInteger(Number(entry.value.timestamp)) && Number(entry.value.timestamp) > 0)
      .map((entry) => ({ entry, distance: Math.abs(Number(entry.value.timestamp) - finishedAt) }))
      .filter((item) => item.distance <= 30000)
      .sort((a, b) => a.distance - b.distance)[0]?.entry;
  }
  const recordedAt = selected && selected.value.timestamp;
  if (!selected || selected.value.role !== 'assistant' ||
      !Number.isSafeInteger(recordedAt) || recordedAt <= 0 ||
      Math.abs(recordedAt - finishedAt) > 30000) {
    return invalid('无法确认所选消息的分支位置');
  }
  const anchor = buildAnchors(parsed.records).find((item) => item.index === selected.recordIndex);
  if (!anchor) return invalid('所选消息没有可分支的正文');
  return planFork(text, anchor.n);
}

/** 锚点清单的一行文本（CLI 与面板共用同一份格式） */
function describeAnchor(anchor) {
  const text = anchor.text.replace(/\s+/g, ' ').trim();
  return `#${String(anchor.n).padStart(3)} | ${clockOf(anchor.timestamp)} | ${anchor.role.padEnd(9)} | ${text.slice(0, 70)}（${anchor.chars} 字）`;
}

/** 在数据根下按会话 ID 找记录文件；找不到返回 null（与 daemon 的产物收集口径一致） */
function findSessionFile(dataDir, sessionId) {
  const projects = path.join(dataDir, 'projects');
  let entries;
  try {
    entries = fs.readdirSync(projects, { withFileTypes: true });
  } catch (_) {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const file = path.join(projects, entry.name, `${sessionId}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function readRecordsFile(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error('会话记录不是普通文件');
  if (stat.size > MAX_RECORD_BYTES) throw new Error('会话记录过大，已拒绝读取');
  return fs.readFileSync(file, 'utf8');
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { out._.push(arg); continue; }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

const USAGE = [
  'node scripts/session-fork.js --id <会话ID> --points',
  'node scripts/session-fork.js --id <会话ID> --until 12 [--out <文件>] [--json]',
  'node scripts/session-fork.js --id <会话ID> --until "09-17 15:30"',
  'node scripts/session-fork.js --file <记录文件> --until 7',
  '',
  '  --data-dir <路径>   WorkBuddy 数据根（默认取当前 profile）',
  '  --max <n>           锚点清单最多显示多少条（默认 60）',
  '  --out <文件>        把分叉后的记录文本写到指定文件',
  '  --dry-run           配合 --out 时只回显不落盘',
  '  --json              以 JSON 输出结果摘要',
];

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || process.argv.length <= 2) {
    console.log(USAGE.join('\n'));
    return 0;
  }

  let file = typeof args.file === 'string' ? args.file : '';
  if (!file) {
    const id = args.id || args._[0];
    if (!id || id === true) {
      console.error('缺少 --id 或 --file');
      console.error(USAGE.join('\n'));
      return 1;
    }
    let dataDir = typeof args['data-dir'] === 'string' ? args['data-dir'] : '';
    if (!dataDir) {
      try { dataDir = require('./lib.js').defaultDataDir(); } catch (_) { dataDir = ''; }
    }
    if (!dataDir) {
      console.error('无法确定 WorkBuddy 数据根，请用 --data-dir 指定');
      return 1;
    }
    const found = findSessionFile(dataDir, String(id));
    if (!found) {
      console.error(`数据根下没有找到会话 ${id} 的记录文件`);
      return 1;
    }
    file = found;
  }

  let text;
  try { text = readRecordsFile(file); }
  catch (error) { console.error(`读取会话记录失败: ${error.message}`); return 1; }

  const parsed = parseRecords(text);
  const anchors = buildAnchors(parsed.records);

  if (args.points) {
    const max = Number(args.max) > 0 ? Number(args.max) : 60;
    console.log(`# ${file}`);
    console.log(`# ${parsed.records.length} 条记录 | ${anchors.length} 个锚点 | 跳过 ${parsed.skipped} 行`);
    console.log('# 锚点 = user / assistant 消息。用 --until <n> 或 --until "HH:MM" 分叉。');
    for (const anchor of anchors.slice(0, max)) console.log(describeAnchor(anchor));
    if (anchors.length > max) console.log(`…（还有 ${anchors.length - max} 个锚点，用 --max 调大）`);
    return 0;
  }

  const spec = args.until;
  if (spec === undefined) {
    console.error('需要 --until 指定分叉点；先用 --points 看锚点编号');
    return 1;
  }

  const plan = planFork(text, spec, { suffix: typeof args.suffix === 'string' ? args.suffix : undefined });
  if (!plan.ok) {
    console.error(plan.reason);
    return 1;
  }

  const out = typeof args.out === 'string' ? args.out : '';
  if (args.json) {
    console.log(JSON.stringify({
      ok: true,
      file,
      anchor: { n: plan.anchor.n, role: plan.anchor.role, timestamp: plan.anchor.timestamp, chars: plan.anchor.chars },
      keep: plan.keep,
      drop: plan.drop,
      keptRecords: plan.keptRecords,
      droppedRecords: plan.droppedRecords,
      skipped: plan.skipped,
    }, null, 2));
  } else {
    console.log(`分叉点 #${plan.anchor.n}（${clockOf(plan.anchor.timestamp)}，${plan.anchor.role}）`);
    console.log(`保留 ${plan.keep} 条消息 / ${plan.keptRecords} 条记录；丢弃 ${plan.drop} 条消息 / ${plan.droppedRecords} 条记录`);
    if (plan.drop === 0) console.log('注意：分叉点在会话末尾，这等于整会话复制。');
  }
  if (out) {
    if (args['dry-run']) console.log(`（--dry-run，未写入 ${out}）`);
    else {
      fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
      fs.writeFileSync(out, plan.text, 'utf8');
      console.log(`已写入 ${out}`);
    }
  }
  return 0;
}

module.exports = {
  DEFAULT_SUFFIX,
  MAX_ANCHOR,
  TITLE_LIMIT,
  buildAnchors,
  clockOf,
  cutIndexFor,
  describeAnchor,
  findSessionFile,
  forkedTitle,
  messageText,
  parseRecords,
  planFork,
  planForkAtMessage,
  resolveAnchor,
  userQueryText,
};

if (require.main === module) process.exit(main());
