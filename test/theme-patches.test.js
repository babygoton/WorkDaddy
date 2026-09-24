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

test('nebula makes the latest mac teams grid containers transparent', () => {
  const patch = patches.find((item) => item && item.id === 'patch-102');
  assert.ok(patch, 'patch-102 must be registered');
  assert.equal(patch.themeId, 'nebula');
  assert.match(patch.css, /\.teams-container\.is-mac\s*>\s*\.teams-grid-scroll-content(?:,|\{)/);
  assert.match(patch.css, /\.teams-grid-scroll-content\s*>\s*\[class\*="_grid_"\]\s*>\s*\[class\*="_gridView_"\]\{/);
  assert.match(patch.css, /background:transparent !important/);
  assert.match(patch.css, /background-color:transparent !important/);
  assert.match(patch.css, /backdrop-filter:none !important/);
});

test('nebula removes the mac teams send tooltip wrapper background', () => {
  const patch = patches.find((item) => item && item.id === 'patch-103');
  assert.ok(patch, 'patch-103 must be registered');
  assert.equal(patch.themeId, 'nebula');
  assert.match(patch.css, /\.teams-container\.is-mac \.cr-input-toolbar__send>span\.cr-send-button__tooltip-wrapper/);
  assert.match(patch.css, /background:transparent !important/);
  assert.match(patch.css, /background-color:transparent !important/);
});

test('nebula removes backgrounds from the template switcher and code copy tooltip', () => {
  const patch = patches.find((item) => item && item.id === 'patch-104');
  assert.ok(patch, 'patch-104 must be registered');
  assert.equal(patch.themeId, 'nebula');
  assert.match(patch.css, /\.industry-template-switcher__host>button\.wb-button\.wb-button--secondary/);
  assert.match(patch.css, /\.cr-code-like-box__header>span\.cr-code-block__copy-tooltip/);
  assert.match(patch.css, /background:transparent !important/);
  assert.match(patch.css, /box-shadow:none !important/);
});
