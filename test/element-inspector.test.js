'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const injectSource = fs.readFileSync(path.join(__dirname, '../scripts/inject.js'), 'utf8');
// 拾取实现随内部模块抽离（picker-internal.js 不入库）；文件存在才测试，缺失则整文件跳过
const pickerPath = path.join(__dirname, '../scripts/picker-internal.js');
const pickerSource = fs.existsSync(pickerPath) ? fs.readFileSync(pickerPath, 'utf8') : null;
const daemonSource = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');
const macBuildSource = fs.readFileSync(path.join(__dirname, '../scripts/build-mac-dmg.sh'), 'utf8');

if (!pickerSource) {
  test('picker-internal.js 未就绪（内部模块不入库）', (t) => t.skip());
} else {
  function functionSource(name, nextName) {
    const start = pickerSource.indexOf('function ' + name + '(');
    const end = pickerSource.indexOf('function ' + nextName + '(', start + 1);
    assert.ok(start >= 0 && end > start, `missing picker function ${name}`);
    return pickerSource.slice(start, end);
  }

  test('拾取点击直接打开插件内 DOM 检查器', () => {
    const handler = functionSource('onInspectClick', 'onInspectKey');
    assert.match(handler, /showInspector\(stack, el\)/);
    assert.doesNotMatch(handler, /window\.open|api\(|element-inspector-url|open-url/);
  });

test('插件内检查器包含 DOM 树、重叠元素栈、节点详情和 HTML', () => {
  const handler = functionSource('showInspector', 'stopInspect');
  assert.match(handler, /wbs-inspector-tree/);
  assert.match(handler, /wbs-inspector-stack/);
  assert.match(handler, /wbs-inspector-detail/);
  assert.match(handler, /wbs-inspector-html/);
  assert.match(handler, /mouseover/);
  assert.match(pickerSource, /document\.elementsFromPoint/);
});

test('再次拾取时保留检查器和 WorkDaddy 面板并原地刷新节点', () => {
  const handler = functionSource('onInspectClick', 'onInspectKey');
  assert.doesNotMatch(handler, /setOpen\(false\)|stopInspect\(\)/);
  assert.match(handler, /inspector\.__wbsInspectAt\(stack, el\)/);
  assert.match(handler, /showInspector\(stack, el\)/);
  const startHandler = functionSource('startInspect', 'toggleInspect');
  assert.doesNotMatch(startHandler, /root\.style\.display\s*=\s*'none'/);
  const inspector = functionSource('showInspector', 'stopInspect');
  assert.match(inspector, /mask\.__wbsInspectAt = inspectAt/);
  assert.doesNotMatch(inspector, /wbs-ins-repick[^\n]+closeInspector\(\)/);
});

test('检查器默认严格保持 80% 高 60% 并允许手动缩放', () => {
  assert.match(pickerSource, /\.wbs-modal\.wbs-inspector-modal\{[^}]*width:80vw;height:60vh/);
  assert.match(pickerSource, /resize:both/);
  assert.match(pickerSource, /overflow:hidden/);
  assert.doesNotMatch(pickerSource, /@media\(max-width:900px\)\{\.wbs-inspector-modal/);
  assert.doesNotMatch(pickerSource, /@media\(max-width:600px\)\{\.wbs-inspector-modal/);
});

test('检查器浮窗外不遮罩不模糊并允许页面接收指针', () => {
  assert.match(pickerSource, /\.wbs-inspector-mask\{[^}]*background:transparent[^}]*pointer-events:none/);
  assert.match(pickerSource, /\.wbs-inspector-modal\{[^}]*pointer-events:auto/);
  assert.doesNotMatch(pickerSource, /\.wbs-inspector-mask\{[^}]*backdrop-filter/);
});

test('节点详情眼睛按钮切换 opacity 0 并精确恢复原内联值', () => {
  const inspector = functionSource('showInspector', 'stopInspect');
  assert.match(inspector, /wbs-ins-visibility/);
  assert.match(pickerSource, /opacityStates = new WeakMap\(\)/);
  assert.match(inspector, /style\.setProperty\('opacity', '0', 'important'\)/);
  assert.match(inspector, /style\.setProperty\('opacity', state\.value, state\.priority\)/);
  assert.match(inspector, /style\.removeProperty\('opacity'\)/);
  assert.match(inspector, /state = \{ hadValue: value !== '', value: value, priority:/);
  assert.doesNotMatch(inspector, /if \(!state\) \{\s*var value = selected\.style\.getPropertyValue\('opacity'\)/);
});

test('重注入通过检查器关闭入口清理监听器且拾取高亮恢复原样', () => {
  assert.match(injectSource, /if \(inspector && inspector\.__wbsClose\) inspector\.__wbsClose\(\)/);
  const stopHandler = functionSource('stopInspect', 'onInspectMove');
  assert.match(stopHandler, /style\.setProperty\('outline', inspectState\.hoverOutline\.value, inspectState\.hoverOutline\.priority\)/);
  assert.match(stopHandler, /style\.setProperty\('outline-offset', inspectState\.hoverOutlineOffset\.value, inspectState\.hoverOutlineOffset\.priority\)/);
});

test('检查器内部使用容器查询跟随自身尺寸响应式', () => {
  assert.match(pickerSource, /container-type:inline-size/);
  assert.match(pickerSource, /@container inspector \(max-width:760px\)/);
  assert.match(pickerSource, /grid-template-columns:1fr/);
});

test('检查器标题栏可拖拽且具有明确关闭按钮', () => {
  const handler = functionSource('showInspector', 'stopInspect');
  assert.match(handler, /wbs-inspector-drag-handle/);
  assert.match(handler, />关闭<\/button>/);
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
});
}
