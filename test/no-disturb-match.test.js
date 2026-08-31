/**
 * 免打扰「弹窗自动点允许」匹配逻辑回归测试（1.0.16）。
 * 覆盖 WorkBuddy AI 拦截卡（选项按钮带序号前缀）+ 防御性校验（积分弹窗不误点、
 * 中性按钮不误点、禁用按钮跳过、once 禁用时回退 always）。
 * 实现方式：从 scripts/inject.js 原样抽取扫描函数，用极简 DOM 桩驱动，
 * 保证测试对象与交付物完全同源（inject.js 是浏览器脚本，无 require/export）。
 * 运行：node test/no-disturb-match.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const injectSrc = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'inject.js'), 'utf8');
const startM = injectSrc.indexOf('function ndVisible(el)');
const endM = injectSrc.indexOf('function toNdAudit');
assert.ok(startM > 0 && endM > startM, 'inject.js 未找到免打扰扫描代码段');
const scanCode = injectSrc
  .slice(startM, endM)
  .replace('var doc = (window && window.document) || document;', 'var doc = __ND_DOC__;');

// ===== 极简 DOM 桩（只实现扫描所需接口）=====
function mkText(str) {
  return { nodeType: 3, textContent: str, children: [] };
}
function mkNode(tag, children) {
  const kids = children || [];
  const node = {
    tagName: tag.toUpperCase(),
    type: tag === 'button' ? 'button' : undefined,
    children: kids,
    textContent: '',
    disabled: false,
    parentElement: null,
    attrs: {},
    _clicked: false,
    getAttribute(k) { return this.attrs[k] || null; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getClientRects() { return this.attrs._hidden ? [] : [{}]; },
    get offsetParent() { return this.attrs._hidden ? null : {}; },
    querySelectorAll() { return allButtons(this); },
    click() { this._clicked = true; },
  };
  const texts = [];
  (function collect(n) {
    for (const c of n.children || []) {
      if (c.children && c.children.length) collect(c);
      else if (c.textContent != null) texts.push(c.textContent);
    }
  })(node);
  node.textContent = texts.join('');
  for (const c of kids) c.parentElement = node;
  return node;
}
// 组卡：title(description) + optionList(buttons)，模拟 AI SandboxInterceptCard（序号 span + 文案 span）
function mkCard(desc, labels, opts) {
  const card = mkNode('div', []);
  const title = mkNode('div', [mkText(desc)]);
  const list = mkNode('div', labels.map((l, i) => {
    const b = mkNode('button', [mkText(String(i + 1)), mkText(l)]);
    if (opts && opts.disabledIdx === i) b.disabled = true;
    if (opts && opts.hiddenIdx === i) b.attrs._hidden = true;
    return b;
  }));
  card.children.push(title, list);
  title.parentElement = card;
  list.parentElement = card;
  return card;
}
function allButtons(root) {
  const all = [];
  (function walk(n) {
    for (const c of n.children || []) {
      if (c.tagName === 'BUTTON') { all.push(c); continue; }
      if (c.children && c.children.length) walk(c);
    }
  })(root);
  return all;
}

// ===== 构建测试环境：把扫描代码装进绑定桩文档的扫描函数 =====
function makeScan(doc, audit) {
  const fn = new Function('root', 'audit', '__ND_DOC__', `
    ${scanCode}
    function toNdAudit(kind, matched) { audit.push(kind + ':' + matched); }
    return function () { scanNoDisturbApproval(); };
  `);
  return fn(doc, audit, doc);
}
function runCase(desc, labels, opts) {
  const card = mkCard(desc, labels, opts);
  const doc = { body: card, querySelectorAll: (sel) => allButtons(card) };
  const audit = [];
  makeScan(doc, audit)();
  const acted = allButtons(card).find((b) => b.getAttribute('data-nd-auto') === '1') || null;
  return { acted: acted ? acted.textContent : null, clicked: acted ? acted._clicked : null, audit };
}

// ===== 用例 =====
// 1) WorkBuddy AI 拦截卡-文件外部写入（用户场景 ~/.ssh → 检测到受保护文件修改）
{
  const r = runCase('检测到受保护文件修改', ['允许', '本次会话内始终允许', '拒绝']);
  assert.strictEqual(r.acted, '1允许', 'once 按钮带序号前缀应被规范化并命中');
  assert.strictEqual(r.clicked, true, '命中按钮应被点击');
  assert.deepStrictEqual(r.audit, ['once:允许', 'session:本次会话内始终允许']);
  console.log('✓ AI 拦截卡-受保护文件修改：自动点「1允许」');
}
// 2) 敏感凭据路径
{
  const r = runCase('检测到敏感凭据路径访问', ['允许', '本次会话内始终允许', '拒绝']);
  assert.strictEqual(r.acted, '1允许');
  console.log('✓ AI 拦截卡-敏感凭据路径：自动点「1允许」');
}
// 3) 沙箱外执行命令兜底文案（老客户端行为保持）
{
  const r = runCase('CodeBuddy 想在沙箱外执行命令，需要你确认。', ['允许', '本次会话内始终允许', '拒绝']);
  assert.strictEqual(r.acted, '1允许');
  console.log('✓ 沙箱外执行命令兜底：自动点「1允许」');
}
// 4) 图片生成积分确认弹窗：绝不自动点（防扣费）
{
  const r = runCase('图片生成将消耗 5-10 积分，是否继续？', ['确认', '本次会话始终允许', '拒绝']);
  assert.strictEqual(r.acted, null, '积分确认弹窗不得被自动点击');
  assert.deepStrictEqual(r.audit, [], '积分弹窗不应产生审计');
  console.log('✓ 图片生成积分弹窗：不自动点（防扣费）');
}
// 5) 英文拦截卡
{
  const r = runCase('Detected modification to a protected file', ['Allow', 'Always allow this kind of command for this session', 'Deny, keep running in the sandbox']);
  assert.strictEqual(r.acted, '1Allow');
  console.log('✓ 英文拦截卡：自动点「1Allow」');
}
// 6) 中性工具栏按钮（无拒绝决策组）不得误点
{
  const r = runCase('', ['Allow full access']);
  assert.strictEqual(r.acted, null);
  assert.deepStrictEqual(r.audit, []);
  console.log('✓ 中性按钮「Allow full access」：不误点');
}
// 7) once 按钮禁用时回退到「始终允许」
{
  const r = runCase('检测到受保护文件修改', ['允许', '本次会话内始终允许', '拒绝'], { disabledIdx: 0 });
  assert.strictEqual(r.acted, '2本次会话内始终允许');
  assert.deepStrictEqual(r.audit, ['session:本次会话内始终允许']);
  console.log('✓ once 禁用：回退自动点「2本次会话内始终允许」');
}

console.log('\n免打扰弹窗匹配逻辑回归测试全部通过 ✅');
