'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { collectConversationUsage } = require('../scripts/inject.js');

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
  assert.match(source, /wbs-session-usage-summary\{[^}]*border:0/);
  assert.match(source, /wbs-session-usage-summary\{[^}]*cursor:pointer/);
  assert.match(source, /wbs-session-usage-detail-title\{[^}]*font-weight:700/);
  assert.match(source, /wbs-session-usage-summary\{[^}]*font-size:13px[^}]*opacity:\.72/);
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
