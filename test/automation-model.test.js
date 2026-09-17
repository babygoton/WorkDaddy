'use strict';
/* ===== 自动化指定模型（session.create 的 model）回归测试 =====
 *
 * 覆盖两层：
 *   1. scripts/automation-model.js 的纯逻辑（键解析 / 偏好合并 / 校验）；
 *   2. 协议层接线（validateTask 静态校验、executeTask 透传、daemon 接线与还原）。
 *
 * 机制出处：WorkBuddy 的新建任务模型偏好存在渲染进程 localStorage 的
 * cb-newtask:model:<uid>，只在进入「新建任务」视图时读取一次，所以 daemon 必须
 * 在挂载前写入、并在 finally 里还原。真机实测见 docs/automation-model-selection.md。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  newTaskModelStorageKey,
  hasAutomationModelRequest,
  normalizeAutomationModelRequest,
  normalizeSessionModelRequest,
  resolveAutomationModelKey,
  pickEffortLevel,
  readBooleanFlag,
  readNewTaskModelId,
  buildNewTaskModelValue,
  isTemplateValue,
  THOUGHT_LEVELS,
} = require('../scripts/automation-model.js');
const { validateTask, executeTask, CAPABILITIES, capabilityText } = require('../scripts/automation.js');

const daemon = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'daemon.js'), 'utf8');

/* ———— 1. localStorage 键 ———— */
test('new-task model key is scoped per account and rejects a missing uid', () => {
  assert.equal(newTaskModelStorageKey('uid-1'), 'cb-newtask:model:uid-1');
  assert.equal(newTaskModelStorageKey('  uid-2  '), 'cb-newtask:model:uid-2');
  assert.throws(() => newTaskModelStorageKey(''), /uid/);
  assert.throws(() => newTaskModelStorageKey(null), /uid/);
});

/* ———— 2. 请求归一化 ———— */
test('a step without model fields is not treated as a model request', () => {
  assert.equal(hasAutomationModelRequest({ op: 'session.create', message: 'hi' }), false);
  assert.equal(hasAutomationModelRequest({ op: 'session.create', message: 'hi', model: '' }), false);
  assert.equal(normalizeAutomationModelRequest({ op: 'session.create', message: 'hi' }), null);
  assert.equal(hasAutomationModelRequest(null), false);
});

test('model request normalization keeps valid values and rejects invalid ones loudly', () => {
  assert.deepEqual(
    normalizeAutomationModelRequest({ model: ' glm-5.3-flash ', thoughtLevel: 'high', isThinking: true, contextWindow: 2000000 }),
    { model: 'glm-5.3-flash', thoughtLevel: 'high', isThinking: true, contextWindow: 2000000 },
  );
  // 只给附加字段、不给 model → 必须报错（否则任务以为切了模型）
  assert.throws(() => normalizeAutomationModelRequest({ thoughtLevel: 'high' }), /必须同时指定 model/);
  assert.throws(() => normalizeAutomationModelRequest({ model: '   ' }), /不能为空/);
  assert.throws(() => normalizeAutomationModelRequest({ model: 'x'.repeat(121) }), /过长/);
  assert.throws(() => normalizeAutomationModelRequest({ model: 'a', thoughtLevel: 'max' }), /thoughtLevel/);
  assert.throws(() => normalizeAutomationModelRequest({ model: 'a', isThinking: 'yes' }), /isThinking/);
  assert.throws(() => normalizeAutomationModelRequest({ model: 'a', contextWindow: 10 }), /contextWindow/);
  assert.throws(() => normalizeAutomationModelRequest({ model: 'a', contextWindow: 1.5 }), /contextWindow/);
  assert.deepEqual(THOUGHT_LEVELS, ['low', 'medium', 'high']);
});

/* ———— 3. 模型键解析 ———— */
test('model keys resolve by list key, by display name, and keep custom-local prefixes intact', () => {
  const knownModels = [
    { key: 'glm-5.3-flash', name: 'GLM-5.3-Flash' },
    { key: 'hy3', name: 'Hy3' },
    { key: 'custom-local:GLM-5.2', name: 'GLM-5.2' },
  ];
  const customModels = [{ id: 'gpt-5.6-sol', name: 'GPT-5.6' }];
  const options = { knownModels, customModels };

  // 精确键
  assert.equal(resolveAutomationModelKey('glm-5.3-flash', options).key, 'glm-5.3-flash');
  // 大小写不敏感地按键
  assert.equal(resolveAutomationModelKey('Hy3', options).key, 'hy3');
  // 按显示名
  assert.equal(resolveAutomationModelKey('GLM-5.3-Flash', options).key, 'glm-5.3-flash');
  // 已带前缀：原样保留大小写（自定义模型大小写敏感）
  const kept = resolveAutomationModelKey('custom-local:GLM-5.2', options);
  assert.equal(kept.key, 'custom-local:GLM-5.2');
  assert.equal(kept.custom, true);
  // models.json 里的自定义模型只写 id → 自动补前缀且保留原始大小写
  const auto = resolveAutomationModelKey('gpt-5.6-sol', options);
  assert.equal(auto.key, 'custom-local:gpt-5.6-sol');
  assert.equal(auto.custom, true);
});

test('an unknown model fails with candidates instead of silently falling back', () => {
  const knownModels = [{ key: 'glm-5.3-flash', name: 'GLM-5.3-Flash' }, { key: 'hy3', name: 'Hy3' }];
  assert.throws(() => resolveAutomationModelKey('gpt-9', { knownModels }), (error) => {
    assert.match(error.message, /未知模型/);
    assert.match(error.message, /glm-5\.3-flash/);
    assert.match(error.message, /hy3/);
    return true;
  });
  // 拿不到权威清单时保留裸键，交由写入后的回读校验兜底（不误报未知模型）
  const fallback = resolveAutomationModelKey('some-builtin', { knownModels: [] });
  assert.equal(fallback.key, 'some-builtin');
  assert.equal(fallback.unverified, true);
  assert.equal(isTemplateValue('{{vars.model}}'), true);
  assert.equal(isTemplateValue('glm-5.3-flash'), false);
});

/* ———— 4. 偏好值合并与回读 ———— */
test('writing a model keeps the user\'s other preference fields', () => {
  const previous = JSON.stringify({ id: 'hy3', isThinking: true, reasoningEffort: 'high', contextWindow: 1000000 });
  const resolved = { key: 'glm-5.3-flash' };
  const built = buildNewTaskModelValue(previous, resolved, { thoughtLevel: 'low' });
  assert.deepEqual(built.value, { id: 'glm-5.3-flash', isThinking: true, reasoningEffort: 'low', contextWindow: 1000000 });
  assert.deepEqual(JSON.parse(built.raw), built.value);

  // 未指定 thoughtLevel → 原 reasoningEffort 不得被改写
  assert.equal(buildNewTaskModelValue(previous, resolved, {}).value.reasoningEffort, 'high');
  // 原值缺失或损坏时以新对象为底，不阻塞任务
  assert.deepEqual(buildNewTaskModelValue(null, resolved, {}).value, { id: 'glm-5.3-flash' });
  assert.deepEqual(buildNewTaskModelValue('{oops', resolved, {}).value, { id: 'glm-5.3-flash' });
  assert.deepEqual(buildNewTaskModelValue('"str"', resolved, {}).value, { id: 'glm-5.3-flash' });
  assert.throws(() => buildNewTaskModelValue(null, null, {}), /模型键/);
});

test('reading back the stored model id tolerates corrupt values', () => {
  assert.equal(readNewTaskModelId('{"id":"hy3"}'), 'hy3');
  assert.equal(readNewTaskModelId('{"id":"  hy3  "}'), 'hy3');
  assert.equal(readNewTaskModelId('{oops'), '');
  assert.equal(readNewTaskModelId('[1,2]'), '');
  assert.equal(readNewTaskModelId('"hy3"'), '');
  assert.equal(readNewTaskModelId(null), '');
});

/* ———— 5. 协议层校验 ———— */
test('validateTask accepts model on session.create and on session.send', () => {
  const ok = validateTask({
    id: 'model-task',
    name: 'model task',
    steps: [{ op: 'session.create', message: '你好', model: '{{vars.pick}}', thoughtLevel: 'high' }],
  });
  assert.equal(ok.steps[0].model, '{{vars.pick}}');

  // session.send 支持 model / thoughtLevel / isThinking / keepModel
  const send = validateTask({
    id: 'send-task',
    name: 'send task',
    steps: [{ op: 'session.send', conversationId: 'c', message: 'hi', model: 'glm-5.3-flash', thoughtLevel: 'max', isThinking: false, keepModel: true }],
  });
  assert.equal(send.steps[0].model, 'glm-5.3-flash');
  // thoughtLevel 走运行时按模型 supportedEfforts 解析，静态期不限制 low/medium/high
  assert.equal(send.steps[0].thoughtLevel, 'max');

  assert.throws(() => validateTask({ id: 'x', name: 'x', steps: [{ op: 'session.create', message: 'hi', model: 'a', thoughtLevel: 'max' }] }), /thoughtLevel/);
  assert.throws(() => validateTask({ id: 'x', name: 'x', steps: [{ op: 'session.create', message: 'hi', model: 42 }] }), /model 必须是字符串/);
  assert.throws(() => validateTask({ id: 'x', name: 'x', steps: [{ op: 'session.create', message: 'hi', thoughtLevel: 'high' }] }), /必须同时指定 model/);
  assert.throws(() => validateTask({ id: 'x', name: 'x', steps: [{ op: 'session.create', message: 'hi', model: 'a', contextWindow: 99999999999 }] }), /contextWindow/);
  // 会话内切换无法改上下文窗口：必须显式报错，不能静默忽略
  assert.throws(() => validateTask({ id: 'x', name: 'x', steps: [{ op: 'session.send', conversationId: 'c', message: 'hi', model: 'a', contextWindow: 1000000 }] }), /session\.send 不支持 contextWindow/);
  // keepModel 只对 session.send 有意义
  assert.throws(() => validateTask({ id: 'x', name: 'x', steps: [{ op: 'session.create', message: 'hi', model: 'a', keepModel: true }] }), /keepModel 只用于 session\.send/);
  assert.throws(() => validateTask({ id: 'x', name: 'x', steps: [{ op: 'session.send', conversationId: 'c', message: 'hi', model: 'a', keepModel: 'yes' }] }), /keepModel 必须是布尔值/);
  assert.throws(() => validateTask({ id: 'x', name: 'x', steps: [{ op: 'session.send', conversationId: 'c', message: 'hi', thoughtLevel: 'high' }] }), /必须同时指定 model/);
});

/* ———— 6. 执行期透传 ———— */
test('session.create forwards the resolved model to the session action', async () => {
  const seen = [];
  await executeTask(
    { id: 'forward', variables: { pick: 'glm-5.3-flash' }, steps: [{ op: 'session.create', message: '你好', model: '{{vars.pick}}', thoughtLevel: 'high' }] },
    { sessionAction: async (op, detail) => { seen.push({ op, detail }); return { ok: true }; } },
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].op, 'session.create');
  assert.equal(seen[0].detail.model, 'glm-5.3-flash');
  assert.equal(seen[0].detail.thoughtLevel, 'high');
});

test('a model template that resolves to nothing fails instead of falling back to the default model', async () => {
  let called = false;
  await assert.rejects(
    executeTask({ id: 'missing', steps: [{ op: 'session.create', message: '你好', model: '{{vars.nothing}}' }] },
      { sessionAction: async () => { called = true; return { ok: true }; } }),
    /模型参数解析为空/,
  );
  assert.equal(called, false, '模板解析为空时不得进入发送');
});

/* ———— 7. daemon 接线（平台运行时不可用的部分用静态断言，见 AGENTS.md 变更流程第 3 条） ———— */
test('daemon writes the preference before opening New Task and restores it on every path', () => {
  assert.match(daemon, /require\('\.\/automation-model\.js'\)/);
  assert.match(daemon, /newTaskModelStorageKey\(uid\)/);
  assert.match(daemon, /async function prepareNewTaskModel\(uid, request\)/);
  assert.match(daemon, /async function restoreNewTaskModelPreference\(snapshot\)/);
  // 写入必须先于挂载：prepare 在 ensureAutomationNewTask 之前调用
  const prepareAt = daemon.indexOf('modelRun = await prepareNewTaskModel(');
  const newTaskAt = daemon.indexOf('await withInput(() => ensureAutomationNewTask({ guard:');
  assert.ok(prepareAt > 0 && newTaskAt > prepareAt, '模型偏好必须在进入新建任务页之前写入');
  // 还原必须落在 finally，成功/失败/停止都要回到用户原值
  const restoreAt = daemon.indexOf('if (modelRun) await restoreNewTaskModelPreference(modelRun.snapshot);');
  assert.ok(restoreAt > newTaskAt, '还原必须位于发送流程之后');
  assert.match(daemon.slice(restoreAt - 240, restoreAt), /\} finally \{/);
  // 回读校验：WorkBuddy 没采纳偏好时必须取消发送，不能静默用旧模型
  assert.match(daemon, /新建任务模型偏好未生效/);
  assert.match(daemon, /modelDisplay/);
  assert.ok(daemon.indexOf('automation-model.js') > 0);
});

/* ———— 8. session.send：会话内切换模型（走 composer 下拉，不用被证伪的 sessionStore.setModel） ———— */
test('session.send switches the conversation model through the composer model menu', () => {
  assert.match(daemon, /async function prepareSessionModel\(request\)/);
  assert.match(daemon, /async function readSessionModelMenu\(\)/);
  assert.match(daemon, /async function applySessionModel\(call\)/);
  // 必须从 fiber 上读选项与处理器，而不是改 store
  assert.match(daemon, /cr-model-selector__item/);
  assert.match(daemon, /cr-model-selector__popover/);
  assert.match(daemon, /memoizedProps\.onSelectEffort/);
  assert.match(daemon, /memoizedProps\.onToggleThinking/);
  assert.doesNotMatch(daemon, /sessionStore[^\n]*setModel\(/);
  // 切换必须在发送之前完成：发送时读的就是会话当前模型
  const switchAt = daemon.indexOf('const run = await withInput(() => prepareSessionModel(modelRequest));');
  const sendAt = daemon.indexOf('await withInput(() => acSendPhrase(String(detail.message || \'\')');
  assert.ok(switchAt > 0 && sendAt > switchAt, '会话模型切换必须先于发送');
  // 还原：keepModel 为真时跳过，否则 finally 里走 restore()
  assert.match(daemon, /sessionModelRun = run\.needsRestore && !keepModel \? run : null;/);
  const sessionRestoreAt = daemon.indexOf('const done = await withInput(() => sessionModelRun.restore(), true);');
  assert.ok(sessionRestoreAt > sendAt, '会话模型还原必须位于发送流程之后');
  assert.match(daemon.slice(sessionRestoreAt - 400, sessionRestoreAt), /\} finally \{/);
  // 还原失败只记日志，不能覆盖任务本身的结果
  assert.match(daemon, /session:model:restore-failed:/);
  // 还原顺序：目标项一旦切走就变成未选中，currentEffort/isThinking 只剩占位值，
  // 所以必须趁它还选中时先还原思考偏好，最后才把会话切回原模型。
  const restoreBody = daemon.slice(daemon.indexOf('restore: async () => {'), daemon.indexOf('async function ensureAutomationNewTask'));
  const prefsAt = restoreBody.indexOf("done.push('prefs='");
  const modelAt = restoreBody.indexOf("done.push('model='");
  assert.ok(prefsAt > 0 && modelAt > prefsAt, '思考偏好必须先于模型切换还原');
  // 还原基准取「切换完成后」的读数，而不是切换前的占位值
  assert.match(daemon, /const prefsBefore = applied\.prefsBefore \|\| null;/);
});

test('model selection ships with the daemon build and the macOS staging list', () => {
  // 改动 daemon 行为必须递增版本，启动器才不会复用旧内存代码
  assert.match(daemon, /const DAEMON_VERSION = '1\.2\.44'/);
  assert.match(daemon, /const DAEMON_BUILD_ID = 'release-1\.2\.44-20260917-automation-session-model-switch/);
  const staging = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build-mac-dmg.sh'), 'utf8');
  assert.ok(staging.includes('automation-model.js'), 'macOS 打包清单必须包含 automation-model.js');
});

test('protocol documentation covers model in both languages', () => {
  const create = CAPABILITIES.find((item) => item.id === 'session.create');
  assert.equal(create.example.model, 'glm-5.3-flash');
  assert.match(create.descriptionZh, /model/);
  assert.match(create.descriptionEn, /model/);
  assert.match(capabilityText('zh'), /session\.create 支持 model/);
  assert.match(capabilityText('en'), /session\.create accepts model/);
  const send = CAPABILITIES.find((item) => item.id === 'session.send');
  assert.match(send.descriptionZh, /可用 model 指定本次发送使用的模型/);
  assert.match(send.descriptionEn, /Optional model sends with a chosen model/);
  assert.match(send.descriptionZh, /keepModel/);
  assert.match(capabilityText('zh'), /session\.send 同样支持 model/);
  assert.match(capabilityText('en'), /session\.send also accepts model/);
});

/* ———— 9. session.send 的纯逻辑（会话内切换） ———— */
test('session.send model request rejects contextWindow and accepts thinking switches', () => {
  assert.equal(normalizeSessionModelRequest({ message: 'hi' }), null);
  assert.deepEqual(normalizeSessionModelRequest({ model: 'glm-5.3-flash', thoughtLevel: 'high', isThinking: false }),
    { model: 'glm-5.3-flash', thoughtLevel: 'high', isThinking: false });
  // 上下文窗口由会话自身决定，静默忽略会让任务以为改了却没改
  assert.throws(() => normalizeSessionModelRequest({ model: 'a', contextWindow: 1000000 }), /session\.send 不支持 contextWindow/);
  assert.throws(() => normalizeSessionModelRequest({ thoughtLevel: 'high' }), /必须同时指定 model/);
  // 档位白名单只在 session.create 路径上是固定的；session.send 交给运行时按模型清单判定，
  // 否则 glm-5.3-flash 真正支持的 max 会被静态校验误杀。
  assert.equal(normalizeSessionModelRequest({ model: 'glm-5.3-flash', thoughtLevel: 'max' }).thoughtLevel, 'max');
  assert.throws(() => normalizeAutomationModelRequest({ model: 'glm-5.3-flash', thoughtLevel: 'max' }), /thoughtLevel 只支持/);
  assert.throws(() => normalizeSessionModelRequest({ model: 'glm-5.3-flash', thoughtLevel: '   ' }), /非空字符串/);
});

test('effort levels are validated against what the model actually supports', () => {
  assert.deepEqual(pickEffortLevel('high', ['low', 'high', 'max']), { ok: true, effort: 'high', supported: ['low', 'high', 'max'] });
  // 大小写不敏感，但回写清单里的原始写法
  assert.deepEqual(pickEffortLevel('MAX', ['low', 'high', 'max']), { ok: true, effort: 'max', supported: ['low', 'high', 'max'] });
  // 模型不支持时必须报错并给出可选值，不能静默沿用旧档位
  const bad = pickEffortLevel('medium', ['low', 'high', 'max']);
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'unsupported');
  assert.deepEqual(bad.supported, ['low', 'high', 'max']);
  // 拿不到清单时先放行，交由切换后的回读校验兜底
  assert.deepEqual(pickEffortLevel('high', []), { ok: true, effort: 'high', supported: [], unverified: true });
  assert.equal(pickEffortLevel('', ['low']).reason, 'empty');
});

test('keepModel is a strict boolean flag', () => {
  assert.equal(readBooleanFlag(undefined, false), false);
  assert.equal(readBooleanFlag('', false), false);
  assert.equal(readBooleanFlag(null, true), true);
  assert.equal(readBooleanFlag(true, false), true);
  assert.equal(readBooleanFlag('true', false), true);
  assert.equal(readBooleanFlag(' FALSE ', false), false);
  assert.throws(() => readBooleanFlag('yes', false), /布尔/);
  assert.throws(() => readBooleanFlag(1, false), /布尔/);
});
