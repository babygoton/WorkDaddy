'use strict';

function normalizeAutomationModelId(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 120 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error('model 必须是 1–120 字符的模型 ID');
  }
  return value.trim();
}

// Runs in WorkBuddy's renderer through CDP. The option's own onSelect is the
// complete WorkBuddy path; its DOM onClick wrapper and sessionStore setter are not.
async function selectAutomationModel({ model, conversationId, accountUid }) {
  const trigger = Array.from(document.querySelectorAll('button.cr-model-selector__trigger'))
    .find((element) => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; });
  if (!trigger) throw new Error('当前输入框没有模型选择器');

  let controller = null;
  let storageKey = null;
  let previousRaw = null;
  if (conversationId) {
    const documentRoot = document.querySelector('.cr-document[data-root-id]');
    if (!documentRoot || documentRoot.getAttribute('data-root-id') !== conversationId) throw new Error('目标会话已变化');
    controller = (window.__wbsWorkBuddyCompat?.findConversationControllers?.(document) || [])
      .find((item) => String(item.conversationId) === conversationId);
    if (!controller || controller.sessionStore.getState().isBusy) throw new Error('目标会话未挂载或正在运行');
  } else {
    const tab = document.querySelector('button.conversation-list-tab-button.active');
    if (!tab || !/^(新建任务|New Task)$/i.test((tab.getAttribute('aria-label') || tab.textContent || '').trim())) {
      throw new Error('新建任务页面已变化');
    }
    storageKey = 'cb-newtask:model:' + accountUid;
    previousRaw = window.localStorage.getItem(storageKey);
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const openMenu = async () => {
    if (!document.querySelector('.cr-model-selector__popover')) trigger.click();
    for (let attempt = 0; attempt < 40; attempt++) {
      if (document.querySelectorAll('.cr-model-selector__item').length) return;
      await sleep(50);
    }
    throw new Error('模型菜单未能打开');
  };
  const options = () => Array.from(document.querySelectorAll('.cr-model-selector__item')).map((element) => {
    const fiberKey = Object.keys(element).find((key) => key.startsWith('__reactFiber$'));
    let fiber = fiberKey && element[fiberKey];
    for (let depth = 0; fiber && depth < 10; depth++, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      if (props?.option?.id && typeof props.onSelect === 'function') return { option: props.option, props };
    }
    return null;
  }).filter(Boolean);
  const selectedModel = () => {
    if (controller) {
      return controller.sessionStore.getState().model === model &&
        controller.config?.getConversation?.()?.configManager?.model === model;
    }
    try { return JSON.parse(window.localStorage.getItem(storageKey) || '{}').id === model; }
    catch (_) { return false; }
  };
  let previousModel = null;
  let changed = false;
  try {
    await openMenu();
    const available = options();
    previousModel = available.find((item) => item.props.isSelected)?.option.id || null;
    const target = available.find((item) => item.option.id === model);
    if (!target) throw new Error('未知模型 ID；请从 WorkBuddy 模型列表选择有效 ID');
    if (target.option.disabled) throw new Error('指定模型当前不可用');
    if (!previousModel) throw new Error('无法确认当前模型');
    changed = previousModel !== model;
    if (changed) target.props.onSelect();
    for (let attempt = 0; attempt < 50; attempt++) {
      if (selectedModel() && (!target.option.name || (trigger.innerText || trigger.textContent || '').includes(target.option.name))) {
        return { model, displayName: target.option.name || '', previousModel, changed, storageKey, previousRaw,
          selectedRaw: storageKey ? window.localStorage.getItem(storageKey) : null };
      }
      await sleep(80);
    }
    throw new Error('模型切换未确认');
  } catch (error) {
    if (changed && previousModel) {
      try {
        await openMenu();
        const original = options().find((item) => item.option.id === previousModel);
        if (!original) throw new Error('原模型选项已消失');
        original.props.onSelect();
        if (storageKey) {
          if (previousRaw === null) window.localStorage.removeItem(storageKey);
          else window.localStorage.setItem(storageKey, previousRaw);
        }
      } catch (restoreError) {
        throw new Error(error.message + '；恢复原模型失败：' + restoreError.message);
      }
    }
    throw error;
  } finally {
    if (document.querySelector('.cr-model-selector__popover')) trigger.click();
  }
}

function verifyAutomationModel({ model, conversationId, accountUid, displayName }) {
  const trigger = Array.from(document.querySelectorAll('button.cr-model-selector__trigger'))
    .find((element) => element.getBoundingClientRect().width > 0);
  if (!trigger || displayName && !(trigger.innerText || trigger.textContent || '').includes(displayName)) return false;
  if (conversationId) {
    const root = document.querySelector('.cr-document[data-root-id]');
    if (!root || root.getAttribute('data-root-id') !== conversationId) return false;
    const controller = (window.__wbsWorkBuddyCompat?.findConversationControllers?.(document) || [])
      .find((item) => String(item.conversationId) === conversationId);
    return !!controller && controller.sessionStore.getState().model === model &&
      controller.config?.getConversation?.()?.configManager?.model === model;
  }
  const tab = document.querySelector('button.conversation-list-tab-button.active');
  if (!tab || !/^(新建任务|New Task)$/i.test((tab.getAttribute('aria-label') || tab.textContent || '').trim())) return false;
  try { return JSON.parse(window.localStorage.getItem('cb-newtask:model:' + accountUid) || '{}').id === model; }
  catch (_) { return false; }
}

function restoreNewTaskModelPreference(selection) {
  try {
    const current = window.localStorage.getItem(selection.storageKey);
    let currentId = '';
    try { currentId = JSON.parse(current || '{}').id || ''; } catch (_) {}
    if (currentId !== selection.model && currentId !== selection.previousModel) return { restored: false, changed: true };
    if (selection.previousRaw === null) window.localStorage.removeItem(selection.storageKey);
    else window.localStorage.setItem(selection.storageKey, selection.previousRaw);
    return { restored: window.localStorage.getItem(selection.storageKey) === selection.previousRaw };
  } catch (_) { return { restored: false }; }
}

module.exports = { normalizeAutomationModelId, selectAutomationModel, verifyAutomationModel, restoreNewTaskModelPreference };
