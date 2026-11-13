'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../scripts/inject.js'), 'utf8');
const start = source.indexOf('  css.textContent = [');
const end = source.indexOf("  ].join('');", start);
const css = vm.runInNewContext(source.slice(start, end + "  ].join('');".length), { css: {} });
const lightExclusion = ':not(:where([data-wbs-appearance="light"] *,.wbs-panel-light *))';

// CodeBuddy keeps a light panel even when the official renderer uses a dark theme.
// Every dark override must exclude both ways of marking that light surface.
test('host dark edition and growth badge overrides respect the panel appearance', () => {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, selector]) =>
    /html\.cb-dark|html\[data-theme="dark"\]|body\[data-vscode-theme-name/.test(selector) &&
    /\.wbs-badge\b|\.wbs-daily-rings\b|\.wbs-checkin-tag\.ok/.test(selector));
  assert.ok(rules.length >= 4, 'checks edition, growth ink, badge surface and hover rules');
  for (const [, selector] of rules) {
    for (const match of selector.matchAll(/\.wbs-badge\b|\.wbs-daily-rings\b|\.wbs-checkin-tag\.ok/g)) {
      assert.ok(selector.slice(match.index + match[0].length).startsWith(lightExclusion), selector);
    }
  }
});

test('forced light growth badges retain the light credit color in any host theme', () => {
  const fill = '--wbs-liquid-fill:var(--wbs-credit-theme-color,var(--wbs-primary))';
  const rule = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(([, selector, body]) =>
    selector.includes('[data-wbs-appearance="light"] :is(.wbs-daily-rings,.wbs-daily-cat-status-icon)') && body.includes(fill));
  assert.ok(rule, 'explicit light appearance gets the same liquid highlight as the default light theme');
  assert.ok(rule[1].includes('.wbs-panel-light :is(.wbs-daily-rings,.wbs-daily-cat-status-icon)'));
  assert.match(css, /\.wbs-badge\{[^}]*color:var\(--wb-color-text-secondary/);
  assert.match(css, /\.wbs-daily-cat-mark\{[^}]*background:var\(--wbs-liquid-ink\)/);
});
