'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const patches = require('../scripts/theme-patches.js');

test('conversation shell and grouped agent cards use global theme patch rules', () => {
  const patch = patches.find((item) => item && item.id === 'patch-83');
  assert.ok(patch, 'patch-83 must remain registered');
  assert.equal(typeof patch.css, 'string');
  assert.match(patch.css, /\.conversation-shell__main\{background:transparent !important/);
  assert.match(patch.css, /\.conversation-section-content \.cb-agent-card\{/);
  assert.match(patch.css, /color-mix\(in srgb,var\(--wb-bg-primary\) 32%,transparent\)/);
  assert.match(patch.css, /backdrop-filter:blur\(14px\)/);
  assert.doesNotMatch(patch.css, /WBS_PROFILE|workbuddy-ai|data-theme="dark"/);
});

test('WorkBuddy widget cards use translucent theme surfaces', () => {
  const patch = patches.find((item) => item && item.id === 'patch-99');
  assert.ok(patch, 'patch-99 must be registered');
  assert.match(patch.css, /\.cr-widget-card\{[^}]*background:color-mix/);
  assert.match(patch.css, /\.cr-widget-card\{[^}]*backdrop-filter:blur\(/);
  assert.match(patch.css, /\.cr-widget-header\{[^}]*background:color-mix/);
  assert.match(patch.css, /\.cr-widget-header\{[^}]*background-color:color-mix/);
  assert.doesNotMatch(patch.css, /WBS_PROFILE|workbuddy-ai/);
});
