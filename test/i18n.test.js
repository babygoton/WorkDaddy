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
  assert.match(source, /toastRuntime\.show\(\{ message: wbsTranslateString/);
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

test('built-in editor translates defaults but preserves stored text and user edits', () => {
  const vm = require('node:vm');
  const dict = source.match(/var WBS_I18N_EN = \{([\s\S]*?)\n  \};/)[0];
  const helpers = source.slice(source.indexOf('  function wbsBuiltinAutomationText('), source.indexOf('  // ===== 全局错误钩子'));
  const context = { WBS_LANGUAGE: 'en' };
  vm.runInNewContext(dict + helpers, context);
  const directory = path.join(__dirname, '../scripts/builtin/automations');
  for (const filename of fs.readdirSync(directory).filter(f => f.endsWith('.json'))) {
    const task = JSON.parse(fs.readFileSync(path.join(directory, filename), 'utf8'));
    for (const field of ['name', 'description']) {
      const displayed = context.wbsAutomationText(task, field);
      assert.doesNotMatch(displayed, /[\u4e00-\u9fff]/);
      assert.equal(context.wbsAutomationEditedText(task, field, displayed), task[field]);
      assert.equal(context.wbsAutomationEditedText(task, field, 'My custom text'), 'My custom text');
      const edited = { ...task, [field]: '账号' };
      assert.equal(context.wbsAutomationText(edited, field), edited[field]);
      assert.equal(context.wbsBuiltinAutomationText(edited, field), false);
      const custom = { ...task, id: 'user-created' };
      assert.equal(context.wbsAutomationText(custom, field), task[field]);
      assert.equal(context.wbsBuiltinAutomationText(custom, field), false);
      context.WBS_LANGUAGE = 'zh';
      assert.equal(context.wbsAutomationText(task, field), task[field]);
      context.WBS_LANGUAGE = 'en';
    }
  }
});
