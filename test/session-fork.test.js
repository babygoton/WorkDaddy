'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  DEFAULT_SUFFIX,
  TITLE_LIMIT,
  buildAnchors,
  clockOf,
  describeAnchor,
  findSessionFile,
  forkedTitle,
  parseRecords,
  planFork,
  planForkAtMessage,
  resolveAnchor,
  userQueryText,
} = require('../scripts/session-fork.js');

const T0 = Date.UTC(2026, 8, 17, 7, 0, 0);

// 合成会话：真实记录形状是「消息正文 -> 该轮工具调用与结果 -> 下一条消息」。
// 锚点预期为：1=user 起头, 2=assistant 我先查, 3=assistant 查到结论, 4=user 那按 C 做,
// 5=assistant 开始做 C, 6=assistant C 做完了。
function fixture() {
  // 时间按分钟递增，保证每条锚点的时间字符串互不相同，便于验证按时间分叉
  const at = (minute) => T0 + minute * 60000;
  return [
    { type: 'message', role: 'user', timestamp: at(0), content: [{ type: 'text', text: '帮我看一下 A 方案' }] },
    { type: 'message', role: 'assistant', timestamp: at(1), content: [{ type: 'text', text: '我先查一下资料。' }] },
    { type: 'function_call', name: 'Bash', arguments: '{"command":"echo hi"}', timestamp: at(2) },
    { type: 'function_call_result', name: 'Bash', timestamp: at(3), output: [{ text: 'hi' }] },
    { type: 'message', role: 'assistant', timestamp: at(4), content: [{ type: 'text', text: '查到了，结论是 B。' }] },
    { type: 'message', role: 'user', timestamp: at(5), content: [{ type: 'text', text: '那按 C 做' }] },
    { type: 'message', role: 'assistant', timestamp: at(6), content: [{ type: 'text', text: '好，开始做 C。' }] },
    { type: 'function_call', name: 'Write', arguments: '{"file_path":"x"}', timestamp: at(7) },
    { type: 'message', role: 'assistant', timestamp: at(8), content: [{ type: 'text', text: 'C 做完了。' }] },
  ];
}

const toText = (records) => records.map((record) => JSON.stringify(record)).join('\n') + '\n';

test('parseRecords keeps raw lines verbatim and counts bad lines', () => {
  const text = `${JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'text', text: 'hi   spaced' }] })}\n\n{not json\n`;
  const { records, skipped } = parseRecords(text);
  assert.equal(records.length, 1);
  assert.equal(skipped, 1);
  // 原样保留：切片时不重新序列化，避免改写未知字段
  assert.ok(records[0].line.includes('hi   spaced'));
  assert.equal(JSON.parse(records[0].line).type, 'message');
});

test('buildAnchors numbers only user/assistant messages and skips harness injection', () => {
  const records = [
    { type: 'message', role: 'user', timestamp: T0, content: [{ type: 'text', text: '<system-reminder>harness 注入</system-reminder>' }] },
    { type: 'reasoning', timestamp: T0 + 1, rawContent: [{ type: 'reasoning_text', text: '思考' }] },
    { type: 'function_call', name: 'Read', arguments: '{}', timestamp: T0 + 2 },
    { type: 'file-history-snapshot', timestamp: T0 + 3 },
    { type: 'message', role: 'user', timestamp: T0 + 4, content: [{ type: 'text', text: '<system-reminder>注入</system-reminder><user_query>真话在这</user_query>' }] },
    { type: 'message', role: 'assistant', timestamp: T0 + 5, content: [{ type: 'text', text: '收到' }] },
  ];
  const anchors = buildAnchors(parseRecords(toText(records)).records);
  assert.equal(anchors.length, 2);
  assert.equal(anchors[0].n, 1);
  assert.equal(anchors[0].index, 4);
  assert.equal(anchors[0].role, 'user');
  // 注入块与真话同在一行时，先抽 user_query 才不会漏掉这条消息
  assert.equal(anchors[0].text, '真话在这');
  assert.equal(anchors[1].n, 2);
  assert.equal(anchors[1].text, '收到');
});

test('userQueryText drops injection-only records and keeps plain user text', () => {
  assert.equal(userQueryText({ content: [{ type: 'text', text: '<cb_summary>总结</cb_summary>' }] }), '');
  assert.equal(userQueryText({ content: [{ type: 'text', text: '<additional_data>上下文</additional_data>' }] }), '');
  assert.equal(userQueryText({ content: [{ type: 'text', text: '<task-notification>后台任务完成</task-notification>' }] }), '');
  assert.equal(userQueryText({ content: [{ type: 'text', text: '普通一句话' }] }), '普通一句话');
  assert.equal(userQueryText({ content: [] }), '');
  assert.equal(userQueryText(null), '');
});

test('forking at an assistant message keeps that turn tool calls and drops the next message', () => {
  const text = toText(fixture());
  const plan = planFork(text, 2);
  assert.equal(plan.ok, true);
  assert.equal(plan.anchor.n, 2);
  // 锚点 2 是 index 1，下一条 message 在 index 4 -> 保留 index 0..3（含本轮工具调用与结果）
  assert.equal(plan.keptRecords, 4);
  assert.equal(plan.droppedRecords, 5);
  assert.equal(plan.keep, 2);
  assert.equal(plan.drop, 4);
  const kept = parseRecords(plan.text).records.map((entry) => entry.value);
  assert.equal(kept.length, 4);
  assert.equal(kept[3].type, 'function_call_result');
  assert.ok(!plan.text.includes('查到了，结论是 B。'));
  assert.ok(!plan.text.includes('那按 C 做'));
});

test('forking at a user message keeps that message but drops the reply that follows', () => {
  const plan = planFork(toText(fixture()), 4);
  assert.equal(plan.ok, true);
  assert.equal(plan.keptRecords, 6);
  assert.equal(plan.keep, 4);
  const kept = parseRecords(plan.text).records.map((entry) => entry.value);
  assert.equal(kept[kept.length - 1].content[0].text, '那按 C 做');
  assert.ok(!plan.text.includes('好，开始做 C。'));
});

test('forking at the last anchor keeps the whole session and reports zero dropped', () => {
  const text = toText(fixture());
  const plan = planFork(text, 6);
  assert.equal(plan.ok, true);
  assert.equal(plan.drop, 0);
  assert.equal(plan.text, text);
});

test('fork output is byte-identical to the original kept lines and never mutates the source', () => {
  const text = toText(fixture());
  const before = text;
  const plan = planFork(text, 3);
  const sourceLines = text.split('\n').filter((line) => line.trim());
  const outLines = plan.text.split('\n');
  assert.equal(outLines[outLines.length - 1], '');
  outLines.pop();
  // 每一条输出行都必须能在原文里逐字找到（不重新序列化）
  for (const line of outLines) assert.ok(sourceLines.includes(line));
  assert.equal(text, before);
});

test('resolveAnchor accepts a number, a #number and a clock substring', () => {
  const anchors = buildAnchors(parseRecords(toText(fixture())).records);
  assert.equal(resolveAnchor('2', anchors).n, 2);
  assert.equal(resolveAnchor('#2', anchors).n, 2);
  assert.equal(resolveAnchor(2, anchors).n, 2);
  const clock = clockOf(anchors[3].timestamp);
  assert.equal(clock, '09-17 07:05');
  assert.equal(resolveAnchor(clock, anchors).n, 4);
  // 只给 HH:MM 也能定位
  assert.equal(resolveAnchor(clock.slice(6), anchors).n, 4);
  assert.equal(resolveAnchor('999', anchors), null);
  assert.equal(resolveAnchor('没有这个时间', anchors), null);
  assert.equal(resolveAnchor(undefined, anchors), null);
  assert.equal(resolveAnchor('0', anchors), null);
});

test('planFork fails closed instead of silently picking an anchor', () => {
  assert.match(planFork('', 1).reason, /为空/);
  assert.match(planFork('not json\n', 1).reason, /为空/);
  const text = toText([{ type: 'function_call', name: 'Bash', arguments: '{}' }]);
  assert.match(planFork(text, 1).reason, /没有可分叉的消息/);
  assert.match(planFork(toText(fixture()), 999).reason, /锚点没解析出来/);
});

test('renderer message position forks only when roles and completion time match the JSONL', () => {
  const records = [
    { type: 'message', role: 'user', timestamp: T0, content: [{ type: 'text', text: '问题一' }] },
    { type: 'message', role: 'assistant', timestamp: T0 + 5000, content: [{ type: 'text', text: '回答一' }] },
    { type: 'message', role: 'user', timestamp: T0 + 10000, content: [{ type: 'text', text: '问题二' }] },
    { type: 'message', role: 'assistant', timestamp: T0 + 15000, content: [{ type: 'text', text: '回答二' }] },
  ];
  const text = toText(records);
  const choice = { messageIndex: 1, roles: 'uaua', finishedAt: T0 + 5200 };
  const result = planForkAtMessage(text, choice);
  assert.equal(result.ok, true);
  assert.equal(result.keep, 2);
  assert.equal(result.drop, 2);
  assert.deepEqual(parseRecords(result.text).records.map((item) => item.value.role), ['user', 'assistant']);
  assert.equal(planForkAtMessage(text, { ...choice, roles: 'auua' }).ok, false);
  assert.equal(planForkAtMessage(text, { ...choice, roles: 'uaa' }).ok, false);
  assert.equal(planForkAtMessage(text, { ...choice, messageIndex: 2 }).ok, false);
  assert.equal(planForkAtMessage(text, { ...choice, finishedAt: T0 + 120000 }).ok, false);
  assert.equal(planForkAtMessage(toText(records.map((record, i) => i === 1 ? { ...record, timestamp: 'invalid' } : record)), choice).ok, false);
  assert.equal(planForkAtMessage(text + '{bad\n', choice).ok, false);
});

test('renderer fork matching ignores task notifications and groups streamed assistant records', () => {
  const records = [
    { type: 'message', role: 'user', timestamp: T0, content: [{ type: 'text', text: '<system-reminder><user_query>问题一</user_query></system-reminder>' }] },
    { type: 'message', role: 'assistant', timestamp: T0 + 1000, content: [{ type: 'text', text: '正在处理。' }] },
    { type: 'message', role: 'assistant', timestamp: T0 + 2000, content: [{ type: 'text', text: '处理完成。' }] },
    { type: 'message', role: 'user', timestamp: T0 + 2500, content: [{ type: 'text', text: '<task-notification>后台任务完成</task-notification>' }] },
    { type: 'message', role: 'user', timestamp: T0 + 3000, content: [{ type: 'text', text: '<system-reminder><user_query>问题二</user_query></system-reminder>' }] },
    { type: 'message', role: 'assistant', timestamp: T0 + 4000, content: [{ type: 'text', text: '第二个回答。' }] },
  ];
  const result = planForkAtMessage(toText(records), {
    messageIndex: 1,
    roles: 'uaua',
    finishedAt: T0 + 2000,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(parseRecords(result.text).records.map((item) => item.value.role), ['user', 'assistant', 'assistant']);
  assert.match(result.text, /处理完成/);
  assert.doesNotMatch(result.text, /问题二|第二个回答/);
});

test('describeAnchor renders a one-line anchor summary', () => {
  const anchors = buildAnchors(parseRecords(toText(fixture())).records);
  const line = describeAnchor(anchors[1]);
  assert.match(line, /^#\s{2}2 \| 09-17 \d{2}:\d{2} \| assistant \| 我先查一下资料。/);
  assert.match(line, /（8 字）/);
});

test('forkedTitle appends the suffix and truncates to the limit', () => {
  assert.equal(forkedTitle('查积分活动'), `查积分活动${DEFAULT_SUFFIX}`);
  assert.equal(forkedTitle('', 'x'), 'x');
  const long = forkedTitle('A'.repeat(200));
  assert.equal(long.length, TITLE_LIMIT);
  assert.ok(long.endsWith(DEFAULT_SUFFIX));
  assert.equal(forkedTitle('标题', ''), '标题');
});

test('findSessionFile resolves an id under any project slug and ignores non-directories', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-fork-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'projects', 'work-a'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'projects', 'work-b'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'projects', 'stray.jsonl'), '{}\n');
  const target = path.join(dir, 'projects', 'work-b', 'session-1.jsonl');
  fs.writeFileSync(target, toText(fixture()));
  assert.equal(findSessionFile(dir, 'session-1'), target);
  assert.equal(findSessionFile(dir, 'missing'), null);
  assert.equal(findSessionFile(path.join(dir, 'nope'), 'session-1'), null);
});
