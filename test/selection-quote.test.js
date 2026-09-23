'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('the obsolete selection quote enhancement switch is removed', () => {
  const inject = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'inject.js'), 'utf8');
  assert.doesNotMatch(inject, /id="wbs-sess-selection-quote"/);
  assert.doesNotMatch(inject, /<span class="wbs-nd-title">引用消息文本<\/span>/);
  assert.doesNotMatch(inject, /SELECTION_QUOTE_ENABLED_KEY/);
});

test('selection quote is delegated to WorkBuddy and WorkDaddy no longer injects a custom button', () => {
  const inject = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'inject.js'), 'utf8');
  assert.doesNotMatch(inject, /function setupSelectionQuote\(\)/);
  assert.doesNotMatch(inject, /selectionQuoteButton/);
  assert.doesNotMatch(inject, /selection:\/\/document-selection/);
});
