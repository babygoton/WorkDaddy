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
const lib = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'lib.js'), 'utf8');

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
const LOG_LIKE = /^(WorkBuddy 兼容层未加载|\[WBS\]|注入组件已销毁|收到 SIGTERM|当前 Node 运行时没有 WebSocket|daemon 使用临时目录锁|picker-internal\.js 注入锚点不存在)|^\[[a-z][^\]]*\]/;
const FRAGMENT_LIKE = /^[」「，、。；：]|^已发送「|^已登录「|的自动继续|项）|」的备份|」的本地备份|」，请刷新|已发送「|已登录「|^\s*(个|条)$|^快捷短语吗|^这条$/;

// 还原运行时真实文本：字面量常内嵌 HTML 标签/属性，运行时按文本节点拆分后翻译，
// 这里仅剥离标签（含标签内属性）得到接近真实的纯文本再检查。不 trim 首尾空格、
// 不剥引号内容——前导空格是整句 key 的一部分（如 ' 个会话'、' 的 WorkBuddy …'），
// 引号内文本（如 回复"已完成"）也是可翻译内容的一部分。
function uiText(lit) {
  return lit
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ');
}

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:"'\\])\/\/[^\n]*/g, '$1');
}

function chineseLiterals(src) {
  const out = new Set();
  // 拆成两个独立正则：JS 单引号串与双引号串分别匹配。
  // 原「(['"])((?:[^'"\\\n]|\\.)*)\1」在单引号串内嵌 HTML 双引号（如
  // '<div class="x">…'）时整段失配，导致弹窗/二级页文案漏出扫描网。
  const single = /'((?:[^'\\\n]|\\.)*)'/g;
  const dbl = /"((?:[^"\\\n]|\\.)*)"/g;
  let m;
  const collect = (re) => {
    while ((m = re.exec(src))) {
      const s = m[1];
      if (s && /[\u4e00-\u9fff]/.test(s)) {
        // 保留前导空格：部分整句 key 以空格开头（如 ' 的 WorkBuddy 桌面端增强工具…'），
        // trim 会让运行时本可整句匹配的文本提前落入短词替换（误报混合）。
        const clean = s.replace(/\\(['"])/g, '$1').replace(/\s+$/, '');
        if (clean.length >= 2) out.add(clean);
      }
    }
    re.lastIndex = 0;
  };
  collect(single);
  collect(dbl);
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

test('every Chinese UI literal in inject.js translates at runtime with zero Chinese residue', () => {
  const t = buildTranslator();
  const missed = [];
  for (const lit of chineseLiterals(stripComments(inject))) {
    if (LOG_LIKE.test(lit)) continue;
    if (FRAGMENT_LIKE.test(lit)) continue;
    const text = uiText(lit);
    if (text.length < 2) continue;
    const out = t(text, 'en');
    if (/[\u4e00-\u9fff]/.test(out)) missed.push(`「${lit}」-> ${out}`);
  }
  assert.deepEqual(missed, [], `运行时仍产中文（中英混合）:\n${missed.map((m, i) => `  ${i + 1}. ${m}`).join('\n')}`);
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

test('lib.js account-flow errors (surface as toasts) translate without Chinese residue', () => {
  const t = buildTranslator();
  const missed = [];
  for (const lit of chineseLiterals(stripComments(lib))) {
    if (LOG_LIKE.test(lit)) continue;
    if (FRAGMENT_LIKE.test(lit)) continue;
    const out = t(lit, 'en');
    if (/[\u4e00-\u9fff]/.test(out)) missed.push(`「${lit}」-> ${out}`);
  }
  assert.deepEqual(missed, [], `lib.js 运行时仍产中文:\n${missed.map((m, i) => `  ${i + 1}. ${m}`).join('\n')}`);
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