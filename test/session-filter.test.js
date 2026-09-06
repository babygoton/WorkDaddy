'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('session panel defaults its time filter to all sessions', () => {
  const inject = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'inject.js'), 'utf8');
  const paneStart = inject.indexOf('var sessionsState =');
  const paneEnd = inject.indexOf('function isTaskSessionRecordUI', paneStart);
  const state = inject.slice(paneStart, paneEnd);
  assert.match(state, /range:\s*'all'/);

  const rangeStart = inject.indexOf("id=\"wbs-sess-range-seg\"");
  const rangeEnd = inject.indexOf("'</div></div>'", rangeStart);
  const range = inject.slice(rangeStart, rangeEnd);
  assert.match(range, /data-range=\"all\">全部/);
  assert.match(range, /class=\"wbs-sess-seg-btn active\"[^>]*data-range=\"all\">全部<\/button>/);
  assert.doesNotMatch(range, /active[^>]*data-range=\"7d\"/);
});
