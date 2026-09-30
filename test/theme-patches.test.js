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

test('nebula makes the latest teams grid containers transparent', () => {
  const patch = patches.find((item) => item && item.id === 'patch-102');
  assert.ok(patch, 'patch-102 must be registered');
  assert.equal(patch.themeId, 'nebula');
  assert.match(patch.css, /\.teams-container\s*>\s*\.teams-grid-scroll-content(?:,|\{)/);
  assert.doesNotMatch(patch.css, /\.teams-container\.is-mac/);
  assert.match(patch.css, /\.teams-grid-scroll-content\s*>\s*\[class\*="_grid_"\]\s*>\s*\[class\*="_gridView_"\]\{/);
  assert.match(patch.css, /background:transparent !important/);
  assert.match(patch.css, /background-color:transparent !important/);
  assert.match(patch.css, /backdrop-filter:none !important/);
});

test('nebula removes the teams send tooltip wrapper background', () => {
  const patch = patches.find((item) => item && item.id === 'patch-103');
  assert.ok(patch, 'patch-103 must be registered');
  assert.equal(patch.themeId, 'nebula');
  assert.match(patch.css, /\.teams-container \.cr-input-toolbar__send>span\.cr-send-button__tooltip-wrapper/);
  assert.doesNotMatch(patch.css, /\.teams-container\.is-mac/);
  assert.match(patch.css, /background:transparent !important/);
  assert.match(patch.css, /background-color:transparent !important/);
});

test('nebula removes backgrounds from the template switcher and code copy tooltip', () => {
  const patch = patches.find((item) => item && item.id === 'patch-104');
  assert.ok(patch, 'patch-104 must be registered');
  assert.match(patch.css, /\.teams-container \.industry-template-switcher__host/);
  assert.doesNotMatch(patch.css, /\.teams-container\.is-mac/);
  assert.equal(patch.themeId, 'nebula');
  assert.match(patch.css, /\.industry-template-switcher__host>button\.wb-button\.wb-button--secondary/);
  assert.match(patch.css, /\.cr-code-like-box__header>span\.cr-code-block__copy-tooltip/);
  assert.match(patch.css, /background:transparent !important/);
  assert.match(patch.css, /box-shadow:none !important/);
});

test('nebula removes the send SVG disc without hiding the arrow or changing other icons', () => {
  const patch = patches.find(item => item.id === 'patch-105');
  assert.ok(patch);
  assert.equal(patch.themeId, 'nebula');
  assert.match(patch.css, /\.cr-send-button__icon svg\[viewBox="0 0 32 32"\]>path\[d\^="M16 32C24\.8366"\]/);
  assert.match(patch.css, /d:path\("M16 19\.2104/);
  assert.match(patch.css, /fill:var\(--wb-button-primary-fg\)/);
  assert.doesNotMatch(patch.css, /display:none|visibility:hidden|opacity:0|fill:transparent/);
});

test('legacy tooltip backgrounds exclude inline anchors and copy/send trigger wrappers', () => {
  const css = patches.find(p => p.id === 'patch-15').css;
  const rule = css.split('}').find(rule => rule.includes('[class*="tooltip"]'));
  for (const cls of ['cr-clickable-path-tooltip-anchor', 'cr-code-block__copy-tooltip', 'cr-send-button__tooltip-wrapper']) {
    assert.ok(rule.includes(':not(.' + cls + ')'), cls + ' is a trigger, not a tooltip surface');
  }
  assert.match(rule, /background:var\(--wb-bg-popover\)/, 'real tooltips retain a readable surface');
});

test('nebula file links and code copy controls use transparent backgrounds in all interaction states', () => {
  const patch = patches.find(p => p.id === 'patch-106');
  assert.ok(patch);
  assert.equal(patch.themeId, 'nebula');
  for (const cls of ['cr-clickable-path-tooltip-anchor', 'cr-clickable-path', 'cr-code-block__copy-tooltip', 'cr-code-block__copy-button']) {
    assert.ok(patch.css.includes('.' + cls));
  }
  assert.match(patch.css, /background:transparent !important/);
  assert.doesNotMatch(patch.css, /:hover|:focus|:active/, 'unconditional important override covers native hover and active fills');
});

test('generic dark popup text repair excludes the WorkDaddy status popover', () => {
  const patch = patches.find(item => item.id === 'patch-44');
  const selectors = patch.css.slice(0, patch.css.indexOf('{')).split(',');
  assert.equal(selectors.length, 3);
  for (const selector of selectors) {
    assert.match(selector, /\*:not\(:where\(\.wbs-status-popover \*\)\)$/,
      'official popup text repair must not override themed WorkDaddy buttons and reward labels');
  }
  assert.match(patch.css, /color:var\(--wb-color-text-primary\) !important/,
    'official tooltip/dropdown text still needs the dark-theme repair');
});
