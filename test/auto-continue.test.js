/**
 * 持续会话 · 会话异常中转（Auto-Continue）核心逻辑单测
 * 与 scripts/daemon.js（块管理）和 scripts/inject.js（标记判定/正文块识别）中实现保持同源复制。
 * 运行：node test/auto-continue.test.js
 */
'use strict';
const assert = require('assert');
const {
  classifyAutoContinueReply,
  normalizeAutoContinueError,
  classifyAutoContinueError,
  classifyAutoContinueControllerSnapshot,
  autoContinueMessageText,
  autoContinueControllerCompleted,
  selectAutoContinueAssistant,
} = require('../scripts/inject.js');

/* ===== 与 daemon.js 同源：指令块管理（v2 起块名 WorkDaddy-Rule1，兼容清理旧名 AutoContinue）===== */
const AC_TAG_START = '[WorkDaddy-Rule1 - activate]';
const AC_TAG_END = '[end WorkDaddy-Rule1]';
const AC_BLOCK_RE = /\[WorkDaddy-(?:AutoContinue|Rule1)[\s\S]*?\[end WorkDaddy-(?:AutoContinue|Rule1)\]/g;

function acBlock() {
  return AC_TAG_START + '\n' +
    'Always append one invisible zero-width marker (U+200B U+200B U+2060) at the very end of the main text body of every reply that you finish producing. The marker means the reply is complete, whether or not the underlying task is fully done. Append it whenever you finish writing a reply. Only omit it if your reply is interrupted or cut short before you finished. Write the actual invisible characters, never a visible placeholder such as text or escaped notation. Add nothing after the marker. Keep this active for all remaining replies in this conversation.' +
    '\n' + AC_TAG_END;
}
function stripACBlocks(customPrompt) {
  if (typeof customPrompt !== 'string') return '';
  const stripped = customPrompt.replace(AC_BLOCK_RE, '');
  return stripped.replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '\n');
}
function applyACBlock(customPrompt, enabled) {
  const stripped = stripACBlocks(typeof customPrompt === 'string' ? customPrompt : '');
  if (!enabled) return stripped;
  const base = stripped.replace(/\n+$/, '');
  return [base, acBlock()].filter(Boolean).join('\n\n');
}
function acCustomPromptPresent(customPrompt) {
  return typeof customPrompt === 'string' &&
    customPrompt.indexOf(AC_TAG_START) !== -1 &&
    customPrompt.indexOf(AC_TAG_END) !== -1;
}

/* ===== 与 inject.js 同源：标记判定 / 正文块识别 / 平台支持 ===== */
const AC_STRICT_MARKER = '\u200B\u200B\u2060';

function acHasMarker(text) {
  if (typeof text !== 'string' || !text.length) return false;
  const t = text.replace(/[ \t\r\n\f\v\u00A0]+$/, '');
  if (!t.length) return false;
  if (t.slice(-AC_STRICT_MARKER.length) === AC_STRICT_MARKER) return true;
  if (/[\u200B\uFEFF\u2060\u200D]$/.test(t)) return true;
  return false;
}
function acPickBodyBlock(contentEl) {
  if (!contentEl || !contentEl.children || !contentEl.children.length) return contentEl;
  const children = contentEl.children;
  let picked = null;
  for (let i = 0; i < children.length; i++) {
    const el = children[i];
    const cls = typeof el.className === 'string' ? el.className : '';
    if (/_widget|widgetRenderer|_assistantReasoning|_metaFold|_collapse/i.test(cls)) continue;
    if (/_assistantTextContent|_assistantText|_markdown|markdown/i.test(cls)) picked = el;
    else if (!picked) picked = el;
  }
  return picked || children[children.length - 1];
}
function acShouldTrigger(bodyText) {
  if (typeof bodyText !== 'string' || !bodyText.trim()) return false; // 无正文文本（纯 widget 回复）不触发
  return !acHasMarker(bodyText);
}
function acSupported(platform) {
  return platform !== 'win32';
}

/* ===== 测试 1：开启追加 —用户内容保留、空行分隔、块存在 ===== */
{
  const user = '每个任务结束后输入：【任务已结束】';
  const out = applyACBlock(user, true);
  assert.ok(out.startsWith(user), '用户内容保留且在前');
  assert.ok(out.indexOf(AC_TAG_START) !== -1, '块追加');
  assert.ok(out.indexOf(AC_TAG_END) !== -1);
  assert.ok(acCustomPromptPresent(out), '完整块识别');
  assert.ok(out.indexOf(user + '\n\n[WorkDaddy') === 0, '单空行分隔');
  console.log('✓ 开启追加：用户内容保留，单空行 + 完整块');
}

/* ===== 测试 2：幂等开启不会重复追加 ===== */
{
  let out = applyACBlock('用户A', true);
  out = applyACBlock(out, true);
  out = applyACBlock(out, true);
  const n = (out.match(/\[WorkDaddy-Rule1/g) || []).length;
  assert.strictEqual(n, 1, '重复开启只保留一个块');
  assert.strictEqual(out.indexOf('用户A'), 0, '用户内容保留');
  console.log('✓ 幂等：重复开启仍只有 1 个块');
}

/* ===== 测试 3：关闭只删块，用户内容原样保留 ===== */
{
  const user = '第一行\n第二行';
  const on = applyACBlock(user, true);
  const off = applyACBlock(on, false);
  assert.ok(off.indexOf(AC_TAG_START) === -1, '块移除');
  assert.ok(off.indexOf('第一行\n第二行') === 0, '用户内容保留且在前');
  assert.ok(off !== '', '关闭后非空');
  console.log('✓ 关闭：只删自己的块，用户内容保留');
}

/* ===== 测试 4：多块清理全部删除 + 空行收敛 ===== */
{
  const user = '用户';
  const fakeOld = user + '\n\n' + acBlock() + '\n\n[WorkDaddy-AutoContinue v0 - legacy]\nold\n[end WorkDaddy-AutoContinue]\n\n继续内容';
  const off = stripACBlocks(fakeOld);
  assert.ok(off.indexOf('[WorkDaddy-AutoContinue') === -1, '新旧块全部清理');
  assert.ok(off.indexOf('用户') === 0, '用户开头保留');
  assert.ok(off.indexOf('继续内容') !== -1, '后续内容保留');
  assert.ok(!/\n{3,}/.test(off), '无连续 3 空行');
  assert.strictEqual(off, '用户\n\n继续内容', '块间空行收敛为单空行，用户内容不被 trim');
  console.log('✓ 多块清理 + 空行收敛');
}

/* ===== 测试 4b：块删除后的尾部多余空行释放为单换行，且不 trim 用户内容 ===== */
{
  const off = stripACBlocks('用户内容\n\n\n\n');
  assert.strictEqual(off, '用户内容\n', '尾部多余换行释放为单换行');
  const keep = stripACBlocks('  首部空格内容  ');
  assert.strictEqual(keep, '  首部空格内容  ', '首部空行/空格不 trim');
  console.log('✓ 尾部空行释放 + 用户内容不 trim');
}

/* ===== 测试 5：严格三连标记判定 ===== */
{
  assert.strictEqual(acHasMarker('完成任务' + '\u200B\u200B\u2060'), true, '严格三连结尾');
  assert.strictEqual(acHasMarker('完成任务\u200B\u200B\u2060 '), true, '标记后可见空白可容忍');
  assert.strictEqual(acHasMarker('完成任务 '), false, '无标记');
  console.log('✓ 严格三连标记判定');
}

/* ===== 测试 6：兼容单个零宽字符结尾 ===== */
{
  assert.strictEqual(acHasMarker('任务' + '\u200B'), true, 'U+200B');
  assert.strictEqual(acHasMarker('任务' + '\uFEFF'), true, 'U+FEFF(BOM) 不被 trim 误伤');
  assert.strictEqual(acHasMarker('任务' + '\u2060'), true, 'U+2060');
  assert.strictEqual(acHasMarker('任务' + '\u200D'), true, 'U+200D');
  console.log('✓ 兼容单零宽标记（含 FEFF 保留判定）');
}

/* ===== 测试 7：可见转义/占位文本不算标记 ===== */
{
  assert.strictEqual(acHasMarker('任务\\u200B'), false, '字面转义不算');
  assert.strictEqual(acHasMarker('任务&#8203;'), false, 'HTML 实体占位不算');
  assert.strictEqual(acHasMarker('任务U+200B'), false, '文本占位不算');
  console.log('✓ 可见转义不误判');
}

/* ===== 测试 8：判定路径 —有标记=不触发，无标记=触发 ===== */
{
  assert.strictEqual(acShouldTrigger('完整回复' + '\u200B\u200B\u2060'), false, '完成不触发');
  assert.strictEqual(acShouldTrigger('中途停了的回复'), true, '异常触发');
  assert.strictEqual(acShouldTrigger(''), false, '空正文不触发（纯 widget 回复等）');
  console.log('✓ 判定路径：完成不干预 / 异常触发');
}

/* ===== 测试 8b：正常完成操作优先于丢失的 marker，明确异常才触发 ===== */
{
  assert.deepStrictEqual(
    classifyAutoContinueReply({ observed: true, hasCompletionActions: true, assistantTextLength: 240 }),
    { trigger: false, reason: 'completion-actions' },
  );
  assert.deepStrictEqual(
    classifyAutoContinueReply({ observed: true, error: true, assistantTextLength: 240 }),
    { trigger: true, reason: 'error-ui' },
  );
  assert.deepStrictEqual(
    classifyAutoContinueReply({ observed: true, error: true, terminal: true, serviceErrorFallback: true }),
    { trigger: false, reason: 'completion-actions' },
    'terminal + renderer fallback 是已结束请求，绝不重复发送',
  );
  assert.deepStrictEqual(
    classifyAutoContinueReply({ observed: true, looksTruncated: true, assistantTextLength: 240 }),
    { trigger: true, reason: 'truncated-reply' },
  );
  console.log('✓ Auto-Continue 正常完成不误发，明确异常才续跑');
}

/* ===== 测试 9：正文块 vs widget 块识别 ===== */
{
  const contentEl = {
    children: [
      { className: '_markdown_abc', textContent: '正文…' },
      { className: '_widgetRendererWrapper_xyz', textContent: '图表' },
    ],
  };
  const body = acPickBodyBlock(contentEl);
  assert.ok(body.className.indexOf('markdown') !== -1, '跳过 widget 取正文块');
  // widget 在前，正文在后
  const contentEl2 = {
    children: [
      { className: '_widgetRendererWrapper_xyz' },
      { className: '_markdown_abc', textContent: '正文' },
    ],
  };
  const body2 = acPickBodyBlock(contentEl2);
  assert.ok(body2.className.indexOf('markdown') !== -1, '多块时取最后一个非 widget 子块');
  // 全部是 widget 时兜底取最后一个
  const contentEl3 = { children: [{ className: '_widget_1' }, { className: '_widget_2' }] };
  assert.strictEqual(acPickBodyBlock(contentEl3).className, '_widget_2', '全 widget 兜底取最后');
  // 无子块时返回自身
  const contentEl4 = { textContent: '直接文本' };
  assert.strictEqual(acPickBodyBlock(contentEl4), contentEl4, '无子块返回自身');
  // CDP 实测的真实结构：Reasoning/TextContent/metaFold 交错，取最后一段文本内容块
  const contentEl5 = {
    children: [
      { className: '_assistantReasoning_1ecmd_60 _complete', textContent: '思考' },
      { className: '_assistantTextContent_7jxnj_195', textContent: '第一段正文' },
      { className: '_metaFold_9ymy5_21', textContent: '工具信息' },
      { className: '_assistantTextContent_7jxnj_195', textContent: '最后一段正文' },
      { className: '_metaFold_9ymy5_21', textContent: '更多工具信息' },
    ],
  };
  assert.strictEqual(acPickBodyBlock(contentEl5).textContent, '最后一段正文', '取最后一段 assistantTextContent');
  console.log('✓ 正文块/widget 块识别（含降级链）');
}

/* ===== 测试 10：平台支持 —Windows 不启用 ===== */
{
  assert.strictEqual(acSupported('win32'), false, 'Windows 不支持');
  assert.strictEqual(acSupported('darwin'), true, 'macOS 支持');
  console.log('✓ 平台支持判断');
}

/* ===== 测试 11：用户原内容里有块时，开启后位置在用户内容末尾 ===== */
{
  const user = '规则一\n规则二';
  const out = applyACBlock(user, true);
  const idx = out.indexOf(AC_TAG_START);
  assert.ok(out.slice(0, idx).indexOf('规则一') === 0, '块之前只有用户内容与空行');
  console.log('✓ 追加位置：严格在用户内容之后');
}

/* ===== 测试 12：旧版块名（AutoContinue）兼容清理 + 开启替换为新块 ===== */
{
  const oldBlock = '第一行\n\n[WorkDaddy-AutoContinue v1 - activate]\nold rule\n[end WorkDaddy-AutoContinue]\n\n结尾';
  const stripped = stripACBlocks(oldBlock);
  assert.strictEqual(stripped.indexOf('AutoContinue'), -1, '旧名块清理');
  assert.ok(stripped.indexOf('第一行') === 0 && stripped.indexOf('结尾') !== -1, '用户内容保留');
  // 开启后旧块被替换为新的 Rule1 块
  const out = applyACBlock(oldBlock, true);
  assert.ok(out.indexOf(AC_TAG_START) !== -1, '新块名写入');
  assert.ok(out.indexOf('[WorkDaddy-AutoContinue') === -1, '旧块不再存在');
  console.log('✓ 旧块名兼容：清理 + 替换为新 Rule1');
}

/* ===== 测试 13：controller/store 终局判定 ===== */
{
  assert.deepStrictEqual(
    classifyAutoContinueControllerSnapshot({ assistantId: 'req-a-assistant', busy: true }),
    { trigger: false, reason: 'not-idle' },
    'store 仍 busy 时绝不触发',
  );
  assert.deepStrictEqual(
    classifyAutoContinueControllerSnapshot({ assistantId: 'req-a-assistant', complete: true, terminal: true }),
    { trigger: false, reason: 'completion-actions' },
    'assistant complete/terminal 是结构化完成证据',
  );
  assert.deepStrictEqual(
    classifyAutoContinueControllerSnapshot({ assistantId: 'req-a-assistant', complete: false, terminal: false }),
    { trigger: true, reason: 'truncated-reply' },
    '会话空闲而 assistant 未 terminal 是结构化中断证据',
  );
  assert.deepStrictEqual(
    classifyAutoContinueControllerSnapshot({ assistantId: 'req-a-assistant', error: true }),
    { trigger: true, reason: 'error-ui' },
    'store error 直接触发续跑判定',
  );
  assert.deepStrictEqual(
    classifyAutoContinueControllerSnapshot({ assistantId: 'req-a-assistant', error: true, terminal: true, serviceErrorFallback: true }),
    { trigger: false, reason: 'completion-actions' },
  );
  assert.deepStrictEqual(
    classifyAutoContinueControllerSnapshot({ assistantId: 'req-a-assistant', error: true, errorCode: 6004, rateLimited: true }),
    { trigger: false, reason: 'model-rate-limited' },
  );
  assert.deepStrictEqual(
    classifyAutoContinueControllerSnapshot({ assistantId: 'req-a-assistant', manualStop: true }),
    { trigger: false, reason: 'manual-stop' },
    '用户主动取消绝不自动续跑',
  );
  assert.strictEqual(autoContinueControllerCompleted({ terminalKnown: true, terminal: false, complete: true }), false,
    '明确 terminal=false 时 complete=true 仍不得提前视作终局');
  assert.strictEqual(autoContinueControllerCompleted({ terminalKnown: true, terminal: true, complete: true }), true,
    '明确 terminal=true 才是新版可靠终局');
  assert.strictEqual(autoContinueControllerCompleted({ terminalKnown: false, complete: true }), true,
    '旧版无 terminal 字段时兼容 complete');
  console.log('✓ controller/store 终局判定（busy/complete/terminal/incomplete/error/manual-stop）');
}

/* ===== 测试 13b：官方额度/限流错误码不可自动重试，且只保留白名单字段 ===== */
{
  const normalized = normalizeAutoContinueError({
    code: 6004,
    requestModelId: 'deepseek-v4.1-flash',
    message: 'rate limit; reset at 2026-09-26 14:32:00 UTC+8',
    terminal: { bizCode: 6004, details: { resetAt: '2026-09-26 14:32:00 UTC+8' } },
  });
  assert.equal(normalized.rateLimited, true);
  assert.equal(normalized.nonRetryable, true);
  assert.equal(normalized.requestModelId, 'deepseek-v4.1-flash');
  assert.ok(Number.isFinite(normalized.resetAt));
  assert.equal(Object.prototype.hasOwnProperty.call(normalized, 'message'), false);
  assert.deepStrictEqual(classifyAutoContinueError({ code: 14018 }), {
    quotaExhausted: true, rateLimited: false, authFailure: false, nonRetryable: true, code: 14018,
  });
  console.log('✓ 官方 14018/6004 错误码停止自动继续，错误快照不保留原文');
}

/* ===== 测试 14：消息正文从结构化 blocks 提取，不依赖 DOM ===== */
{
  const text = autoContinueMessageText({ content: [
    { type: 'reasoning', text: '内部推理' },
    { type: 'text', text: '第一段正文' },
    { type: 'tool-call', tool: { name: 'Read' } },
    { type: 'markdown', text: '第二段正文\u200B\u200B\u2060' },
  ] });
  assert.strictEqual(text, '第一段正文\n第二段正文\u200B\u200B\u2060');
  assert.strictEqual(acHasMarker(text), true, 'store 正文末尾标记可直接识别');
  console.log('✓ controller 消息 blocks 正文提取（忽略 reasoning/tool-call）');
}

/* ===== 测试 15：streaming assistant 优先，排除 timeline 合成消息 ===== */
{
  const messages = [
    { id: 'req-old-assistant', requestId: 'req-old', messageType: 'assistant', complete: true },
    { id: 'req-live-assistant', requestId: 'req-live', messageType: 'assistant', complete: false },
    { id: 'timeline:context-compaction:compact-1', requestId: 'timeline:context-compaction:compact-1', messageType: 'assistant', complete: true },
  ];
  assert.strictEqual(
    selectAutoContinueAssistant({ messages, streamingMessageId: 'req-live-assistant', streamingRequestId: 'req-live' }).id,
    'req-live-assistant',
    '数组末尾即使是 timeline 合成项，也必须选 streaming assistant',
  );
  assert.strictEqual(
    selectAutoContinueAssistant({ messages, streamingMessageId: undefined, streamingRequestId: undefined }).id,
    'req-live-assistant',
    '空闲时回退最后一条普通 assistant，跳过 timeline 合成项',
  );
  console.log('✓ streaming assistant 优先 + timeline 合成项排除');
}

console.log('\n全部 Auto-Continue 核心逻辑测试通过 ✅');
