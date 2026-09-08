'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const injectSource = fs.readFileSync(path.join(__dirname, '../scripts/inject.js'), 'utf8');
const automationPickerPath = path.join(__dirname, '../scripts/automation-picker.js');
const automationPickerSource = fs.readFileSync(automationPickerPath, 'utf8');
// 拾取实现随内部模块抽离（picker-internal.js 不入库）；文件存在才测试，缺失则整文件跳过
const pickerPath = path.join(__dirname, '../scripts/picker-internal.js');
const pickerSource = fs.existsSync(pickerPath) ? fs.readFileSync(pickerPath, 'utf8') : null;
const daemonSource = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');
const macBuildSource = fs.readFileSync(path.join(__dirname, '../scripts/build-mac-dmg.sh'), 'utf8');

function functionSource(name, nextName) {
    const start = automationPickerSource.indexOf('function ' + name + '(');
    const end = automationPickerSource.indexOf('function ' + nextName + '(', start + 1);
    assert.ok(start >= 0 && end > start, `missing picker function ${name}`);
    return automationPickerSource.slice(start, end);
  }

  test('拾取点击直接打开插件内 DOM 检查器', () => {
    const handler = functionSource('onAutomationInspectClick', 'onAutomationInspectKey');
    assert.match(handler, /showAutomationInspector\(stack, el\)/);
    assert.doesNotMatch(handler, /window\.open|api\(|element-inspector-url|open-url/);
  });

test('插件内检查器只保留 DOM 树并移除重叠元素栈和节点详情', () => {
  const handler = functionSource('showAutomationInspector', 'stopAutomationInspect');
  assert.match(handler, /wbs-auto-inspector-tree/);
  assert.doesNotMatch(handler, /wbs-auto-inspector-stack|此坐标下的元素/);
  assert.doesNotMatch(handler, /wbs-auto-inspector-detail|节点详情/);
  assert.match(handler, /mouseover/);
  assert.match(automationPickerSource, /collectElementsAtPoint\(document\)/);
  assert.match(automationPickerSource, /surface\.elementsFromPoint/);
});

test('再次拾取时保留检查器和 WorkDaddy 面板并原地刷新节点', () => {
  const handler = functionSource('onAutomationInspectClick', 'onAutomationInspectKey');
  assert.doesNotMatch(handler, /setOpen\(false\)|stopAutomationInspect\(\)/);
  assert.match(handler, /inspector\.__wbsInspectAt\(stack, el\)/);
  assert.match(handler, /showAutomationInspector\(stack, el\)/);
  const startHandler = functionSource('startAutomationInspect', 'toggleAutomationInspect');
  assert.doesNotMatch(startHandler, /root\.style\.display\s*=\s*'none'/);
  const inspector = functionSource('showAutomationInspector', 'stopAutomationInspect');
  assert.match(inspector, /mask\.__wbsInspectAt = inspectAt/);
  assert.doesNotMatch(inspector, /wbs-ins-repick|重新拾取/);
});

test('检查器默认使用 WorkBuddy 窗口一半宽高并允许手动缩放', () => {
  assert.match(automationPickerSource, /\.wbs-modal\.wbs-auto-inspector-modal\{[^}]*width:50vw;height:50vh/);
  assert.match(automationPickerSource, /resize:both/);
  assert.match(automationPickerSource, /overflow:hidden/);
  assert.doesNotMatch(automationPickerSource, /@media\(max-width:900px\)\{\.wbs-auto-inspector-modal/);
  assert.doesNotMatch(automationPickerSource, /@media\(max-width:600px\)\{\.wbs-auto-inspector-modal/);
});

test('检查器浮窗外不遮罩不模糊并允许页面接收指针', () => {
  assert.match(automationPickerSource, /\.wbs-auto-inspector-mask\{[^}]*background:transparent[^}]*pointer-events:none/);
  assert.match(automationPickerSource, /\.wbs-auto-inspector-modal\{[^}]*pointer-events:auto/);
  assert.doesNotMatch(automationPickerSource, /\.wbs-auto-inspector-mask\{[^}]*backdrop-filter/);
});

test('顶部主按钮复制可供 agent 使用的完整元素信息', () => {
  const inspector = functionSource('showAutomationInspector', 'stopAutomationInspect');
  assert.match(inspector, /wbs-auto-ins-copy-element/);
  assert.match(inspector, /'CSS: ' \+ buildAutomationQueryPath\(selected\)/);
  assert.match(inspector, /'XPath: ' \+ buildAutomationXPath\(selected\)/);
  assert.match(inspector, /selected\.outerHTML/);
  assert.match(inspector, /copyPlainText\(payload\)/);
  assert.match(automationPickerSource, /\.wbs-auto-ins-copy-element\{[^}]*var\(--wb-button-primary-bg/);
});

test('拾取器为带 id 的 Shadow DOM 元素生成可深度查询的选择器', () => {
  const queryPath = functionSource('buildAutomationQueryPath', 'buildAutomationXPath');
  assert.match(queryPath, /if \(el && el\.id\) return/);
  assert.match(automationPickerSource, /e\.composedPath\(\)/);
  assert.match(automationPickerSource, /shadowRoot\.elementsFromPoint/);
});

test('重注入通过检查器关闭入口清理监听器且拾取高亮恢复原样', () => {
  assert.match(injectSource, /if \(automationInspector && automationInspector\.__wbsClose\) automationInspector\.__wbsClose\(\)/);
  const stopHandler = functionSource('stopAutomationInspect', 'onAutomationInspectMove');
  assert.match(stopHandler, /style\.setProperty\('outline', automationInspectState\.hoverOutline\.value, automationInspectState\.hoverOutline\.priority\)/);
  assert.match(stopHandler, /style\.setProperty\('outline-offset', automationInspectState\.hoverOutlineOffset\.value, automationInspectState\.hoverOutlineOffset\.priority\)/);
});

test('检查器单列 DOM 树跟随自身尺寸响应式', () => {
  assert.match(automationPickerSource, /container-type:inline-size/);
  assert.match(automationPickerSource, /\.wbs-auto-inspector-main\{[^}]*grid-template-columns:minmax\(0,1fr\)/);
  assert.doesNotMatch(automationPickerSource, /grid-template-columns:minmax\(360px/);
});

test('检查器标题栏可拖拽且使用图标关闭按钮', () => {
  const handler = functionSource('showAutomationInspector', 'stopAutomationInspect');
  assert.match(handler, /wbs-auto-inspector-drag-handle/);
  assert.match(handler, /wbs-auto-ins-close[^>]+title="关闭"[^>]+aria-label="关闭元素检查器"><svg/);
  assert.doesNotMatch(handler, />关闭<\/button>/);
  assert.match(handler, /pointerdown/);
  assert.match(handler, /pointermove/);
  assert.match(handler, /pointerup/);
  assert.match(handler, /setPointerCapture/);
});

test('daemon 不再暴露 localhost 元素检查器页面与 bridge', () => {
  assert.doesNotMatch(daemonSource, /element-inspector-url|element-inspector-command|element-inspector\.html|INSPECTOR_TICKETS|createInspectorTicketStore/);
});

test('macOS 打包不再携带外部元素检查器文件', () => {
  assert.doesNotMatch(macBuildSource, /element-inspector\.js|element-inspector\.html/);
  assert.match(macBuildSource, /automation-picker\.js/);
});

test('自动化拾取器与五连击 debug 拾取器使用独立入口和 DOM 命名空间', () => {
  assert.match(injectSource, /window\.__wbsStartAutomationPicker\(\)/);
  assert.doesNotMatch(injectSource.slice(injectSource.indexOf('function buildAutomationPane()'), injectSource.indexOf('// ===== 会话 pane')), /window\.__wbsStartPicked\(\)/);
  assert.match(automationPickerSource, /window\.__wbsStartAutomationPicker/);
  assert.doesNotMatch(automationPickerSource, /window\.__wbsStartPicked/);
  assert.match(daemonSource, /automation-picker\.js/);
  if (pickerSource) {
    assert.match(pickerSource, /wbs-inspector-stack/);
    assert.match(pickerSource, /wbs-inspector-detail/);
    assert.match(pickerSource, /width:80vw;height:60vh/);
    assert.match(pickerSource, /window\.__wbsStartPicked/);
    assert.doesNotMatch(pickerSource, /window\.__wbsStartAutomationPicker/);
  }
});
