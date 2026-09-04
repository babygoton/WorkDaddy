const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'inject.js'), 'utf8');

test('injected panel exposes persisted bilingual language selection', () => {
  assert.match(source, /workdaddy\.ui\.language/);
  assert.match(source, /navigator\.language/);
  assert.match(source, /value\.indexOf\('zh'\) === 0 \? 'zh' : 'en'/);
  assert.match(source, /data-tab="about"/);
  // 语言切换为 Segmented 控件，且必须位于 About pane（data-pane="about" 的构建函数内），无独立设置页残留
  assert.match(source, /function buildAboutPane\(\)[\s\S]*?wbs-lang-seg/);
  assert.doesNotMatch(source, /data-tab="settings"/);
  assert.doesNotMatch(source, /function buildSettingsPane\(\)/);
  assert.match(source, /wbs-lang-seg/);
  assert.match(source, /data-wbs-lang="zh"/);
  assert.match(source, /data-wbs-lang="en"/);
  assert.match(source, /localStorage\.setItem\(WBS_LANGUAGE_KEY/);
  assert.match(source, /setAttribute\('lang', WBS_LANGUAGE === 'zh' \? 'zh-CN' : 'en'\)/);
});

test('all dynamic panel text and toast nodes pass through the translator', () => {
  assert.match(source, /function applyI18n\(scope\)/);
  assert.match(source, /applyI18n\(t\);/);
  assert.match(source, /i18nObserver\.observe\(root/);
  assert.match(source, /'账号': 'Accounts'/);
  assert.match(source, /'设置语言': 'Language'/);
});

test('README language switch links are reciprocal', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const english = fs.readFileSync(path.join(__dirname, '..', 'README_en.md'), 'utf8');
  assert.match(readme, /\[English\]\(README_en\.md\)/);
  assert.match(english, /\[简体中文\]\(README\.md\)/);
});
