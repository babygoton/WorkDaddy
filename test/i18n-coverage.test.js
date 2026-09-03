'use strict';

// i18n 覆盖度回归测试：
// 1) 扫描 inject.js / daemon.js 中所有中文字面量，未进字典的必须在白名单内（否则新增中文 UI 文案会直接挂测试）
// 2) 运行时翻译：从源码提取字典+翻译函数，断言典型拼接句翻译后无中文残留（无中英混合）
// 3) 机制：属性白名单、变体覆盖、模板占位

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const inject = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'inject.js'), 'utf8');
const daemon = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'daemon.js'), 'utf8');

// ---- 工具：提取字典 + 翻译函数并构造可执行翻译器 ----
function buildTranslator() {
  const dictMatch = inject.match(/var WBS_I18N_EN = \{([\s\S]*?)\n  \};/);
  assert.ok(dictMatch, 'WBS_I18N_EN dict must exist');
  const grab = (re) => {
    const m = re.exec(inject);
    assert.ok(m, `pattern missing: ${re}`);
    return m[0];
  };
  const matchersVar = inject.match(/var wbsI18nMatchers = null;/);
  const pieces = [
    matchersVar && matchersVar[0],
    grab(/function escapeRegExp\(s\) \{[\s\S]*?\n  \}/),
    grab(/function wbsI18nBuildMatchers\(\) \{[\s\S]*?\n  \}/),
    grab(/function wbsTranslateString\(value, language\) \{[\s\S]*?\n  \}/),
  ].filter(Boolean);
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`var WBS_I18N_EN = {${dictMatch[1]}}; ${pieces.join('\n')}`, sandbox);
  return sandbox.wbsTranslateString;
}

// ---- 白名单：这些是 console 日志 / 断句残留（运行时被整句模板覆盖）/ 内部模块，不属 UI 文案 ----
const LOG_LIKE = /^(WorkBuddy 兼容层未加载|\[WBS\]|注入组件已销毁|收到 SIGTERM|当前 Node 运行时没有 WebSocket|daemon 使用临时目录锁|picker-internal\.js 注入锚点不存在)|^\[[a-z-]+\]/;
const FRAGMENT_LIKE = /^[」「，、。；：]|^已发送「|^已登录「|的自动继续|项）/;

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:"'\\])\/\/[^\n]*/g, '$1');
}

function chineseLiterals(src) {
  const out = new Set();
  const re = /(['"])((?:[^'"\\\n]|\\.)*)\1/g;
  let m;
  while ((m = re.exec(src))) {
    const s = m[2];
    if (s && /[\u4e00-\u9fff]/.test(s)) {
      const clean = s.replace(/\\(['"])/g, '$1').trim();
      if (clean.length >= 2) out.add(clean);
    }
  }
  const tpl = /`([^`${]*)`/g;
  while ((m = tpl.exec(src))) {
    const s = (m[1] || '').trim();
    if (s && /[\u4e00-\u9fff]/.test(s) && s.length >= 2) out.add(s);
  }
  return out;
}

function extractKeys() {
  const dictMatch = inject.match(/var WBS_I18N_EN = \{([\s\S]*?)\n  \};/);
  const keys = [];
  for (const m of dictMatch[1].matchAll(/'([^']+)':\s*'[^']*'/g)) {
    if (/[\u4e00-\u9fff]/.test(m[1])) keys.push(m[1]);
  }
  return keys.sort((a, b) => b.length - a.length);
}

test('every Chinese UI literal in inject.js is covered by the dictionary or a whitelisted log/fragment', () => {
  const keys = extractKeys();
  const missed = [];
  for (const lit of chineseLiterals(stripComments(inject))) {
    if (LOG_LIKE.test(lit)) continue;
    if (FRAGMENT_LIKE.test(lit)) continue;
    const covered = keys.some((k) => k.length >= 2 && lit.indexOf(k) >= 0);
    if (!covered) missed.push(lit);
  }
  assert.deepEqual(missed, [], `未覆盖中文文案:\n${missed.map((m, i) => `  ${i + 1}. ${m}`).join('\n')}`);
});

test('every user-facing Chinese literal in daemon.js (non-log) is covered', () => {
  const keys = extractKeys();
  const missed = [];
  for (const lit of chineseLiterals(stripComments(daemon))) {
    if (LOG_LIKE.test(lit)) continue;
    if (FRAGMENT_LIKE.test(lit)) continue;
    if (/^(has|must|should|the|a |an |ports|cwd)/i.test(lit)) continue; // 英文为主的不检查
    const covered = keys.some((k) => k.length >= 2 && lit.indexOf(k) >= 0);
    if (!covered) missed.push(lit);
  }
  assert.deepEqual(missed, [], `daemon 未覆盖文案:\n${missed.map((m, i) => `  ${i + 1}. ${m}`).join('\n')}`);
});

test('runtime translation: typical concatenated sentences yield pure English (no zh/en mix)', () => {
  const t = buildTranslator();
  const cases = [
    '已切换为「h」，开始领取积分…',
    '定位到第 3 条用户消息',
    '已发送「hello」',
    '「s」的备份',
    '打开面板失败: 123',
    '打开面板失败：456',
    '已关闭：由环境变量控制',
    '输入框非空，已放弃会话 abc123 的自动继续',
    '剩余时间计算中',
    '基础用量 500',
    '账号汇总 · 总积分 100',
  ];
  for (const input of cases) {
    const out = t(input, 'en');
    assert.ok(!/[\u4e00-\u9fff]/.test(out), `「${input}」翻译后仍有中文: ${out}`);
    assert.notEqual(out.trim(), '', `「${input}」被翻译成空串`);
  }
  // 用户数据（昵称/文本）不属于界面文案：保留原文是正确行为，只要求结构被翻译
  const withVar = t('已登录「老板」', 'en');
  assert.ok(withVar.indexOf('Logged in as') >= 0 && withVar.indexOf('老板') >= 0, withVar);
});

test('short keys cannot shred longer covered sentences', () => {
  const t = buildTranslator();
  // '切换' 是独立词条；整句模板存在时必须以整句为准，不允许输出 '已Switch为…'
  const out = t('已切换为「h」，开始领取积分…', 'en');
  assert.ok(out.indexOf('Switched to') >= 0, `整句模板未生效: ${out}`);
  assert.ok(out.indexOf('Switch') < 0 || out.indexOf('Switched to') >= 0 && out.indexOf('已') < 0, out);
  assert.ok(!/[\u4e00-\u9fff]/.test(out), out);
});

test('attribute whitelist includes alt and data-tip; observer watches them', () => {
  assert.match(inject, /'title', 'aria-label', 'placeholder', 'alt', 'data-tip'/);
  assert.match(inject, /attributeFilter: \['title', 'aria-label', 'placeholder', 'alt', 'data-tip'\]/);
});

test('variant keys: error prefixes with and without trailing space both translate', () => {
  const t = buildTranslator();
  // 半角冒号
  assert.equal(t('打开面板失败: x', 'en'), 'Could not open panel: x');
  // 全角冒号（归一化后同样命中）
  assert.equal(t('打开面板失败：x', 'en'), 'Could not open panel: x');
  assert.equal(t('删除失败: 原因', 'en'), 'Delete failed: 原因');
});

test('zh mode leaves text untouched', () => {
  const t = buildTranslator();
  assert.equal(t('已切换为「h」，开始领取积分…', 'zh'), '已切换为「h」，开始领取积分…');
});