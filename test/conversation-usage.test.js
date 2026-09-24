'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { collectConversationUsage, conversationMessagesToMarkdown } = require('../scripts/inject.js');

test('conversation copy preserves complete user and assistant Markdown from the message store', () => {
  const markdown = conversationMessagesToMarkdown([
    { id: 'timeline:initial', messageType: 'assistant', content: [{ type: 'text', text: 'hidden' }] },
    { id: 'u-1', messageType: 'user', content: [{ type: 'text', text: '# 需求\n\n请保留 **Markdown**。'}] },
    { id: 'a-1', messageType: 'assistant', content: [{ type: 'markdown', text: '```js\nconst answer = true;\n```\n[wbs-reply-done]: #' }] },
    { id: 'u-2', role: 'user', content: '继续。' },
    { id: 'a-2', role: 'assistant', content: [{ type: 'text', text: '第二次回复' }] },
  ]);
  assert.equal(markdown, '用户：\n\n# 需求\n\n请保留 **Markdown**。\n\n---\n\n助手：\n\n```js\nconst answer = true;\n```\n\n---\n\n用户：\n\n继续。\n\n---\n\n助手：\n\n第二次回复');
});

test('conversation usage keeps only terminal messages and groups credits by model', () => {
  const result = collectConversationUsage([
    { id: 'streaming', complete: false, usage: { inputTokens: 900, outputTokens: 40, credit: 9 }, extra: { modelId: 'a', modelName: 'Alpha' } },
    { id: 'a-1', complete: true, usage: { inputTokens: 100, outputTokens: 4, credit: 0.37 }, extra: { modelId: 'a', modelName: 'Alpha', isRequestTerminal: true } },
    { id: 'b-1', complete: true, usage: { inputTokens: 12, outputTokens: 3, credit: 0.11 }, extra: { modelId: 'b', modelName: 'Beta', isRequestTerminal: true } },
    { id: 'a-2', complete: true, usage: { inputTokens: 40, outputTokens: 5 }, extra: { modelId: 'a', modelName: 'Alpha', isRequestTerminal: true } },
    { id: 'c-1', complete: true, usage: { inputTokens: 0, outputTokens: 0, lastTokens: 20, credit: 0.05 }, extra: { modelId: 'c', isRequestTerminal: true } },
  ]);

  assert.equal(result.calls, 4);
  assert.equal(result.tokens, 184);
  assert.equal(result.credit, 0.53);
  assert.equal(result.creditKnown, false);
  assert.deepEqual(result.models.map(model => [model.modelId, model.calls, model.tokens, model.creditKnown]), [
    ['a', 2, 149, false],
    ['b', 1, 15, true],
    ['c', 1, 20, true],
  ]);
});

test('conversation usage does not double count repeated terminal snapshots', () => {
  const result = collectConversationUsage([
    { id: 'assistant-1', complete: true, usage: { inputTokens: 10, outputTokens: 2, lastTokens: 12, credit: 0.2 }, extra: { conversationRequestId: 'request-1', modelId: 'a', isRequestTerminal: true } },
    { id: 'assistant-1-final', complete: true, usage: { inputTokens: 10, outputTokens: 3, lastTokens: 13, credit: 0.3 }, extra: { conversationRequestId: 'request-1', modelId: 'a', isRequestTerminal: true } },
  ]);

  assert.equal(result.calls, 1);
  assert.equal(result.tokens, 13);
  assert.equal(result.credit, 0.3);
});

test('conversation usage UI uses a body-fixed mount, bottom spacer and message store', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'inject.js'), 'utf8');
  assert.match(source, /\.cr-message-list__content/);
  assert.match(source, /conversationUsage\.summary\.parentNode !== document\.body/);
  assert.match(source, /wbs-session-usage-spacer/);
  assert.match(source, /controller\.messageStore\.subscribe/);
  assert.match(source, /usage\.credit/);
  assert.match(source, /wbs-session-usage-popover/);
  assert.match(source, /position:fixed/);
  assert.match(source, /wbs-sess-usage-summary/);
  assert.match(source, /conversationUsageEnabled/);
  assert.doesNotMatch(source, /悬浮查看明细|Hover for details/);
  assert.doesNotMatch(source, /el\('strong', 'wbs-session-usage/);
  assert.match(source, /wbs-session-usage-popover\{[^}]*background:color-mix/);
  assert.match(source, /wbs-session-usage-summary\{[^}]*z-index:20/);
  assert.match(source, /wbs-session-usage-popover\{[^}]*z-index:21/);
  assert.match(source, /wbs-session-usage-summary\{[^}]*border:0[^}]*background:transparent/);
  assert.match(source, /wbs-session-usage-summary\{[^}]*cursor:pointer/);
  assert.match(source, /wbs-session-usage-detail-title\{[^}]*font-weight:700/);
  assert.match(source, /wbs-session-usage-summary\{[^}]*font-size:14px[^}]*line-height:18px/);
  assert.match(source, /wbs-session-usage-summary\{[^}]*background:transparent/);
  assert.match(source, /wbs-session-usage-detail-title\{[^}]*font-size:14px/);
  assert.match(source, /wbs-session-usage-detail-title-row\{[^}]*display:flex[^}]*align-items:center[^}]*justify-content:space-between/);
  assert.match(source, /detailTitleRow\.appendChild\(el\('div', 'wbs-session-usage-detail-total'/);
  assert.match(source, /wbs-session-usage-detail-row\{[^}]*font-size:12px/);
  assert.match(source, /wbs-session-usage-detail-note/);
  assert.match(source, /用量统计会随会话完成逐步更新/);
  assert.doesNotMatch(source, /部分会话尚未完成，当前 Token 和积分仅按已完成用量统计/);
  assert.match(source, /if \(open\) \{[\s\S]{0,260}closeSessionCopyNotice\(\)/);
  assert.match(source, /pollSessionCopyNotice[\s\S]{0,500}if \(state\.open\)/);
  assert.match(source, /return usageNumber\(value\) > 0 \? '≥' \+ formatted/);
  assert.match(source, /addEventListener\('scroll', scheduleConversationUsageScrollState, \{ passive: true \}\)/);
  assert.match(source, /var canScroll = maxScroll > 1/);
  assert.match(source, /var atBottom = canScroll && maxScroll - scrollElement\.scrollTop <= 4/);
  assert.match(source, /cr-message-list__bottom-mask/);
  assert.match(source, /var anchorBottom = anchorRect && anchorRect\.bottom/);
  assert.match(source, /window\.innerHeight - anchorBottom/);
  assert.match(source, /positionConversationUsage\(\);[\s\S]{0,120}updateConversationUsageScrollState\(\)/);
  assert.match(source, /wbs-session-usage-summary\.is-hidden/);
  assert.match(source, /wbs-session-usage-label', '共'/);
  assert.match(source, /wbs-session-usage-copy/);
  assert.match(source, /复制整个会话/);
  assert.match(source, /event\.target\.closest\('\.wbs-session-usage-copy'\)/);
  assert.match(source, /listen\(copyButton, 'mouseenter', hideUsagePopover\)/);
  assert.match(source, /wbs-session-usage-copy-icon/);
  assert.match(source, /wbs-session-usage-copy\{[^}]*gap:6px[^}]*width:auto[^}]*min-width:34px[^}]*height:30px[^}]*padding:0 9px[^}]*border-radius:0[^}]*background:transparent[^}]*box-shadow:none/);
  assert.match(source, /wbs-session-usage-copy-label\{[^}]*width:auto[^}]*max-width:0[^}]*padding:0[^}]*text-align:left/);
  assert.match(source, /wbs-session-usage-copy:hover \.wbs-session-usage-copy-label[^']*max-width:72px/);
  assert.match(source, /wbs-session-usage-main\{[^}]*gap:9px[^}]*flex:0 1 auto/);
  assert.match(source, /wbs-session-usage-copy-icon svg\{[^}]*width:16px[^}]*height:16px[^}]*flex:0 0 16px/);
  assert.match(source, /wbs-session-usage-copy-icon \.wbs-session-usage-check-glyph\{[^}]*display:none/);
  assert.match(source, /wbs-session-usage-copy-icon\{[^}]*width:16px[^}]*flex:0 0 16px/);
  assert.doesNotMatch(source, /wbs-session-usage-copy-icon\{[^}]*transform:/);
  assert.match(source, /wbs-session-usage-check-glyph/);
  assert.match(source, /toast\('会话已复制到剪贴板', false, null, 'success'\)/);
  assert.doesNotMatch(source, /label\.textContent = '已复制'/);
  assert.match(source, /conversationMessagesToMarkdown/);
  assert.match(source, /messageStore\.getState\(\)/);
  assert.match(source, /surface\.conversation\.getBoundingClientRect/);
  assert.match(source, /alignmentRect = documentRect/);
  assert.match(source, /Math\.max\(4, window\.innerHeight - anchorBottom \+ 4\)/);
  assert.match(source, /var\(--wb-accent-blue/);
  assert.doesNotMatch(source, /conversation-finished-footer[\s\S]{0,120}usage/);
});

test('usage trend reserves horizontal label space so endpoint values stay visible', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'inject.js'), 'utf8');
  const chart = source.slice(source.indexOf('function renderUsageTrendChart'), source.indexOf('function usageTimeSegmentHtml'));
  assert.match(chart, /measureText\(/);
  assert.match(chart, /chartInset = Math\.max\(/);
  assert.match(chart, /chartRight = cssWidth - chartInset/);
});

test('credit model breakdown follows the selected account filter', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'inject.js'), 'utf8');
  const start = source.indexOf('var byModel = Object.create(null);');
  const end = source.indexOf("creditBody.innerHTML =", start);
  assert.ok(start >= 0 && end > start);
  assert.match(source.slice(start, end), /if \(ids\.indexOf\(item\.uid\) < 0\) return;/);
});
