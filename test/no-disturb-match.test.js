/**
 * 免打扰「弹窗自动点允许」匹配逻辑回归测试（1.0.16 + WorkBuddy 5.5.4）。
 * 覆盖 WorkBuddy AI 拦截卡（选项按钮带序号前缀）+ 敏感凭证保护卡（allow 文案为
 * 「允许访问」/「允许加密访问（推荐）」）+ 防御性校验（积分弹窗、凭证外发、批量删除放行、
 * 完全访问提权确认不误点、禁用按钮跳过、once 禁用时回退 always）。
 * 实现方式：从 scripts/inject.js 原样抽取扫描函数，用极简 DOM 桩驱动，
 * 保证测试对象与交付物完全同源（inject.js 是浏览器脚本，无 require/export）。
 * 运行：node test/no-disturb-match.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const injectSrc = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'inject.js'), 'utf8');
// 文案表（ND_ALLOW_ONCE_LABELS 等）位于扫描代码段之外，属于同一份事实来源，需一并注入桩环境。
const constStart = injectSrc.indexOf('var ND_ALLOW_ONCE_LABELS');
const constEnd = injectSrc.indexOf('function classifyNoDisturbApprovalCandidate');
assert.ok(constStart > 0 && constEnd > constStart, 'inject.js 未找到免打扰文案表常量');
const labelConsts = injectSrc.slice(constStart, constEnd);
const startM = injectSrc.indexOf('function ndVisible(el)');
const endM = injectSrc.indexOf('function toNdAudit');
assert.ok(startM > 0 && endM > startM, 'inject.js 未找到免打扰扫描代码段');
const scanCode = labelConsts + injectSrc
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

// 8) WorkBuddy 5.5.4「敏感凭证保护」卡：ingress 的允许选项是「允许访问」（不是「允许」）
{
  const r = runCase('是否允许模型访问敏感凭证？', ['允许访问', '允许加密访问（推荐）', '禁止访问']);
  assert.strictEqual(r.acted, '1允许访问', '敏感凭证卡的「允许访问」应被识别为 once 允许');
  assert.strictEqual(r.clicked, true);
  console.log('✓ 敏感凭证卡-ingress：自动点「1允许访问」');
}
// 9) ingress-protect-only：没有「允许访问」，只有加密访问——过去完全点不到，任务会卡死
{
  const r = runCase('是否允许模型访问敏感凭证？', ['允许加密访问（推荐）', '禁止访问']);
  assert.strictEqual(r.acted, '1允许加密访问（推荐）');
  assert.strictEqual(r.clicked, true);
  console.log('✓ 敏感凭证卡-protect-only：自动点「1允许加密访问（推荐）」');
}
// 10) 凭证外发（egress）：绝不自动点，必须人工判断目标是否可信
{
  const r = runCase('是否允许将敏感凭证发送到外部？', ['允许发送', '禁止发送']);
  assert.strictEqual(r.acted, null, '凭证外发弹窗不得自动放行');
  assert.deepStrictEqual(r.audit, []);
  console.log('✓ 敏感凭证卡-egress：不自动点（防凭证外泄）');
}
// 11) 批量删除放行：交给「大批量删除免确认」开关，不由本开关代劳
{
  const r = runCase('检测到批量删除操作，删除数量达到阈值', ['允许本次删除', '取消删除']);
  assert.strictEqual(r.acted, null);
  console.log('✓ 批量删除放行：不自动点（由专用开关控制）');
}
// 12) 开启「允许完全访问」的授权确认：属提权，必须人工
{
  const r = runCase('确认允许完全访问？', ['确认开启', '取消']);
  assert.strictEqual(r.acted, null);
  console.log('✓ 完全访问授权确认：不自动点（提权需人工）');
}

// 13) 祖先容器含扣费词不得污染弹窗判定。
// 历史故障：扣费词守卫会向上 8 层扫祖先文本，而弹窗外层就是整段会话/BODY，
// 只要那里出现「积分/费用」等词，所有层级都会被判成扣费弹窗 → 弹窗一个都点不动。
{
  const card = mkCard('检测到受保护文件修改', ['允许', '本次会话内始终允许', '拒绝']);
  const outer = mkNode('div', [mkText('本次会话共消耗 12 积分，剩余余额 380 点'), card]);
  const doc = { body: outer, querySelectorAll: (sel) => allButtons(outer) };
  const audit = [];
  makeScan(doc, audit)();
  const acted = allButtons(card).find((b) => b.getAttribute('data-nd-auto') === '1') || null;
  assert.ok(acted, '外层容器含「积分」时仍应命中弹窗');
  assert.strictEqual(acted._clicked, true);
  console.log('✓ 祖先含扣费词：弹窗仍被自动点（不被误判为扣费弹窗）');
}
// 14) 敏感凭证卡同样不得被外层扣费词污染
{
  const card = mkCard('是否允许模型访问敏感凭证？', ['允许访问', '允许加密访问（推荐）', '禁止访问']);
  const outer = mkNode('div', [mkText('本会话已消耗费用 0.41，余额充足'), card]);
  const doc = { body: outer, querySelectorAll: (sel) => allButtons(outer) };
  const audit = [];
  makeScan(doc, audit)();
  const acted = allButtons(card).find((b) => b.getAttribute('data-nd-auto') === '1') || null;
  assert.ok(acted, '外层含「费用」时敏感凭证卡仍应命中');
  console.log('✓ 祖先含费用词：敏感凭证卡仍被自动点');
}

console.log('\n免打扰弹窗匹配逻辑回归测试全部通过 ✅');
