'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { validateRequirements, assessRequirements } = require('./automation-compatibility');
const { normalizeToastOptions } = require('./toast-options.js');

const SCHEMA_VERSION = 1;
const MAX_TASKS = 200;
const MAX_STEPS = 200;
const MAX_DEPTH = 12;
const MAX_TEXT = 20000;
const MAX_AGENT_FILE_BYTES = 1024 * 1024;

const AGENT_EXAMPLES = [
  {
    id: 'page-loaded-notice',
    titleZh: '账号积分与活跃天数', titleEn: 'Account credits and active streak',
    descriptionZh: '每次切换账号或页面加载完成后，显示当前账号的剩余积分和连续活跃天数。',
    descriptionEn: 'Show the current account credits and consecutive active days after account switching or page load.',
    promptZh: '每次切换账号或 WorkBuddy 页面加载完成后，立即从窗口底部弹出 toast，展示当前账号的名称、剩余积分和连续活跃天数。同一次加载只提示一次，快速切换时不要显示上一个账号的过时结果。积分不限量时显示“不限量”，天数查询失败时显示“暂不可用”。把这个任务添加到 WorkDaddy 的自动化列表。',
    promptEn: 'After each account switch or WorkBuddy page load, immediately show a toast at the window bottom with the current account name, remaining credits and consecutive active days. Show it once per load, and discard stale results when accounts change quickly. Display Unlimited for unlimited credits, and Unavailable if active days cannot be retrieved. Add this task to WorkDaddy Automation.',

  },
];

const CAPABILITIES = [
  { id: 'event.pageReady', zh: '页面就绪触发', en: 'Run when the page is ready', descriptionZh: 'WorkBuddy 首次打开、导航完成或账号切换后的页面刷新完成后运行任务。', descriptionEn: 'Run after WorkBuddy opens, finishes navigation, or completes the refresh after an account switch.', example: { trigger: { type: 'pageReady', oncePerNavigation: true }, steps: [{ op: 'logic.delay', ms: 3000 }, { op: 'dom.click', locator: { kind: 'xpath', value: "//button[contains(normalize-space(.), '关闭')]" } }] } },
  { id: 'event.pageLoaded', zh: '页面加载完成触发', en: 'Run when page loads', descriptionZh: 'WorkBuddy 页面首次打开或导航完成后运行任务。可配合等待和 DOM 点击处理弹窗。', descriptionEn: 'Run after WorkBuddy first opens or finishes a navigation. Combine with waits and DOM clicks to handle dialogs.', example: { trigger: { type: 'pageLoaded', oncePerNavigation: true }, steps: [{ op: 'logic.delay', ms: 3000 }, { op: 'dom.click', locator: { kind: 'xpath', value: "//button[contains(normalize-space(.), '关闭')]" } }] } },
  { id: 'event.accountSwitched', zh: '账号切换完成触发', en: 'Run after account switch', descriptionZh: '账号切换并完成页面刷新后运行任务。', descriptionEn: 'Run after an account switch and the resulting page refresh completes.', example: { trigger: { type: 'accountSwitched' }, steps: [] } },
  { id: 'event.clientLoaded', zh: '客户端加载触发', en: 'Client loaded', descriptionZh: '客户端页面加载完成时触发，可与打开面板和定时组合。', descriptionEn: 'Run after the client page loads; combine with panel-open and interval triggers.', example: { trigger: { types: ['clientLoaded', 'panelOpened'] } } },
  { id: 'event.panelOpened', zh: '打开面板触发', en: 'Panel opened', descriptionZh: '用户打开 WorkDaddy 面板时触发；自动化恢复面板不会触发。', descriptionEn: 'Run when the user opens the panel, excluding automatic panel restoration.', example: { trigger: { type: 'panelOpened' } } },
  { id: 'event.schedule', zh: '定时触发', en: 'Schedule', descriptionZh: '支持间隔、每天、每周、每月和指定时间一次；使用电脑本地时区，错过不补跑，运行中跳过。', descriptionEn: 'Interval, daily, weekly, monthly or once in local computer time. Missed or overlapping runs are skipped.', example: { schedule: { type: 'interval', minutes: 60 } } },
  { id: 'logic.sequence', zh: '顺序执行', en: 'Run a sequence', descriptionZh: '按顺序执行嵌套步骤。', descriptionEn: 'Run nested steps in order.', example: { op: 'logic.sequence', steps: [] } },
  { id: 'logic.delay', zh: '等待指定时间', en: 'Wait for a duration', descriptionZh: '暂停任务若干秒或毫秒。', descriptionEn: 'Pause the task for seconds or milliseconds.', example: { op: 'logic.delay', ms: 3000 } },
  { id: 'logic.if', zh: '条件判断', en: 'Conditional branch', descriptionZh: '根据两个值是否相等、包含或匹配来选择分支。', descriptionEn: 'Choose a branch using equality, containment, or regular expressions.', example: { op: 'logic.if', condition: { left: '{{response.status}}', operator: 'equals', right: 200 }, then: [], else: [] } },
  { id: 'logic.switch', zh: '多分支判断', en: 'Switch branch', descriptionZh: '根据值选择 cases 中的分支，未匹配时运行 default。', descriptionEn: 'Select a branch from cases by value, or run default when unmatched.', example: { op: 'logic.switch', value: '{{response.status}}', cases: { 200: [] }, default: [] } },
  { id: 'logic.repeat', zh: '重复执行', en: 'Repeat steps', descriptionZh: '按次数重复一组步骤。', descriptionEn: 'Repeat a group of steps a bounded number of times.', example: { op: 'logic.repeat', times: 3, steps: [] } },
  { id: 'logic.retry', zh: '失败重试', en: 'Retry on failure', descriptionZh: '失败后按次数和间隔重试。', descriptionEn: 'Retry failed steps with a bounded delay.', example: { op: 'logic.retry', times: 3, delayMs: 1000, steps: [] } },
  { id: 'logic.catch', zh: '捕获错误', en: 'Catch an error', descriptionZh: '执行 steps；失败时把错误写入 vars.error 并运行 onError。', descriptionEn: 'Run steps; on failure, write the error to vars.error and run onError.', example: { op: 'logic.catch', steps: [], onError: [] } },
  { id: 'logic.assert', zh: '条件断言', en: 'Assert a condition', descriptionZh: '条件不成立时终止任务并给出错误信息。', descriptionEn: 'Stop the task with an error when a condition is false.', example: { op: 'logic.assert', condition: { left: '{{response.ok}}', operator: 'truthy' }, message: '请求失败' } },
  { id: 'account.forEach', zh: '循环账号', en: 'Iterate accounts', descriptionZh: '对全部或指定账号依次执行步骤；switch:true 会真实切换登录账号，并在循环结束后恢复原账号。', descriptionEn: 'Run steps for all or selected accounts; switch:true physically switches the logged-in account and restores the original account when the loop ends.', example: { op: 'account.forEach', accounts: 'all', switch: true, steps: [] } },
  { id: 'account.status', zh: '查询账号状态', en: 'Read account status', descriptionZh: '查询今日签到、今日活跃和积分等只读状态。', descriptionEn: 'Read check-in, activity, and credit status.', example: { op: 'account.status', fields: ['checkin.today', 'activity.today'] } },
  { id: 'account.checkin', zh: '账号静默签到', en: 'Check in as account', descriptionZh: '使用循环账号的 token 签到，不切换客户端。当天已确认签到时跳过所有请求；返回 ok、skipped、code 等状态。', descriptionEn: 'Check in using the context account token without switching accounts. Confirmed daily records skip all requests. Returns ok, skipped and code.', example: { op: 'account.checkin', saveAs: 'checkin' } },
  { id: 'http.request', zh: 'HTTP 请求', en: 'HTTP request', descriptionZh: '调用 HTTP/HTTPS 接口并保存响应。', descriptionEn: 'Call an HTTP/HTTPS endpoint and retain its response.', example: { op: 'http.request', method: 'GET', url: 'https://example.com/api', saveAs: 'response' } },
  { id: 'http.requestAsAccount', zh: '使用账号请求', en: 'HTTP request as account', descriptionZh: '使用当前循环账号的登录态请求，任务中不会出现 Token。', descriptionEn: 'Call an endpoint with the current account session without exposing a token in the task.', example: { op: 'http.requestAsAccount', method: 'GET', url: 'https://example.com/api' } },
  { id: 'dom.find', zh: '查找页面元素', en: 'Find DOM element', descriptionZh: '使用 CSS、XPath 或文字查找页面元素。', descriptionEn: 'Find an element using CSS, XPath, or text.', example: { op: 'dom.find', locator: { kind: 'xpath', value: "//button[contains(., '领取')]" }, saveAs: 'element' } },
  { id: 'dom.click', zh: '点击页面元素', en: 'Click DOM element', descriptionZh: '查找并真实点击页面元素。', descriptionEn: 'Find and click an element using a trusted input event.', example: { op: 'dom.click', locator: { kind: 'xpath', value: "//button[contains(., '领取')]" } } },
  { id: 'dom.type', zh: '输入文字', en: 'Type text', descriptionZh: '向页面输入框写入文字。', descriptionEn: 'Type text into a page input.', example: { op: 'dom.type', locator: { kind: 'css', value: 'input[name="q"]' }, text: 'hello' } },
  { id: 'dom.clear', zh: '清空输入框', en: 'Clear an input', descriptionZh: '使用 Chromium 编辑命令清空普通或富文本输入框，并验证结果。', descriptionEn: 'Clear a plain or rich text editor using Chromium editing commands and verify the result.', example: { op: 'dom.clear', locator: { kind: 'css', value: 'input[name="q"]' } } },
  { id: 'dom.press', zh: '按下按键', en: 'Press a key', descriptionZh: '聚焦元素后发送一个键盘按键。', descriptionEn: 'Focus an element and dispatch one keyboard key.', example: { op: 'dom.press', locator: { kind: 'css', value: 'input[name="q"]' }, key: 'Enter' } },
  { id: 'dom.readText', zh: '读取页面文字', en: 'Read DOM text', descriptionZh: '读取页面元素的可见文字。', descriptionEn: 'Read visible text from an element.', example: { op: 'dom.readText', locator: { kind: 'css', value: '.result' }, saveAs: 'resultText' } },
  { id: 'dom.readAttribute', zh: '读取元素属性', en: 'Read an attribute', descriptionZh: '读取页面元素的指定属性。', descriptionEn: 'Read a named attribute from a page element.', example: { op: 'dom.readAttribute', locator: { kind: 'css', value: 'a.result' }, attribute: 'href', saveAs: 'href' } },
  { id: 'dom.wait', zh: '等待页面变化', en: 'Wait for DOM', descriptionZh: '等待固定时间或等待元素达到指定状态。', descriptionEn: 'Wait for a duration or an element state.', example: { op: 'dom.wait', seconds: 2 } },
  { id: 'session.sendCurrent', zh: '发送当前会话消息', en: 'Send in current session', descriptionZh: '向当前 WorkBuddy 会话发送文字。', descriptionEn: 'Send text in the current WorkBuddy session.', example: { op: 'session.sendCurrent', message: '你好' } },
  { id: 'session.waitReply', zh: '等待会话回复', en: 'Wait for session reply', descriptionZh: '等待当前会话产生新回复。', descriptionEn: 'Wait for a new reply in the current session.', example: { op: 'session.waitReply', timeoutMs: 120000 } },
  { id: 'state.get', zh: '读取任务状态', en: 'Read task state', descriptionZh: '读取任务或账号范围内的持久化值。', descriptionEn: 'Read a persisted value scoped to a task or account.', example: { op: 'state.get', key: 'lastRun' } },
  { id: 'state.set', zh: '保存任务状态', en: 'Write task state', descriptionZh: '保存任务或账号范围内的持久化值。', descriptionEn: 'Persist a value scoped to a task or account.', example: { op: 'state.set', key: 'lastRun', value: '{{now}}' } },
  { id: 'notify.toast', zh: '显示提示', en: 'Show notification', descriptionZh: '使用 react-hot-toast 从窗口底部弹出提示。level 支持 info/success/warning/error/loading；duration 为 1000–60000 毫秒，默认 4200（loading 默认持续显示）。同一 id 更新原提示；saveAs 保存返回的 id。', descriptionEn: 'Show a react-hot-toast notification at the window bottom. Levels: info/success/warning/error/loading. duration: 1000–60000 ms, default 4200 (loading persists). Reuse id to update; saveAs stores the returned id.', example: { op: 'notify.toast', level: 'success', message: '任务完成', duration: 4200, id: 'progress' } },
  { id: 'notify.dismiss', zh: '关闭通知', en: 'Dismiss notification', descriptionZh: '按 id 关闭本次运行创建的提示，不影响其他任务或界面通知。任务结束时自动清理未结束的 loading 提示。', descriptionEn: 'Dismiss a notification by id within this run. Unfinished loading notifications are cleared when the run ends.', example: { op: 'notify.dismiss', id: 'progress' } },
  { id: 'notify.afterAllTasks', zh: '全部任务完成后汇报主账号', en: 'Report completion to primary account', descriptionZh: '手动监听当前账号的全部 WorkBuddy 会话，连续确认完成后用主账号 token 新建云端汇报会话；不切换账号。未设置主账号或当前即主账号时跳过；账号变化、失败、状态不明时不发送。最长等待 24 小时。', descriptionEn: 'Manually wait for all current-account WorkBuddy conversations, then create a cloud report conversation as the primary account without switching. Skip if no primary or already primary. Abort on changed account, failure or unknown status. Maximum 24 hours.', example: { op: 'notify.afterAllTasks', timeoutMs: 86400000 } },
];

// Additive v1 contract. Deprecated operations remain executable for saved tasks.
for (const [id, zh, en, example, descriptionZh, descriptionEn] of [
  ['account.list', '列出账号', 'List accounts', {op:'account.list',saveAs:'accounts'}, '返回账号公开信息数组，不包含凭据。', 'Return public account records without credentials.'],
  ['account.getCurrent', '当前账号', 'Current account', {op:'account.getCurrent',saveAs:'current'}, '返回实际登录账号，同时更新 account 上下文。', 'Return the logged-in account and update account context.'],
  ['account.getPrimary', '主账号', 'Primary account', {op:'account.getPrimary',saveAs:'primary'}, '返回主账号公开信息；未设置时为 null。', 'Return the primary public record, or null.'],
  ['vars.set', '设置变量', 'Set variable', {op:'vars.set',key:'count',value:1}, '设置 vars 下的单个变量，值支持递归模板。', 'Set one variable in vars with recursive templates.'],
  ['logic.forEach', '循环列表', 'Iterate list', {op:'logic.forEach',items:'{{vars.items}}',steps:[]}, '遍历最多 1000 项，使用 vars.item 和 vars.index，退出后恢复上下文。', 'Iterate up to 1000 entries via vars.item and vars.index; restore context on exit.'],
  ['logic.break', '退出循环', 'Break loop', {op:'logic.break'}, '退出最近一层列表、重复或账号循环。', 'Exit the nearest list, repeat or account loop.'],
  ['logic.waitUntil', '等待条件', 'Wait for condition', {op:'logic.waitUntil',timeoutMs:10000,intervalMs:250,steps:[],condition:{left:'{{vars.ready}}',operator:'truthy'}}, '立即执行查询步骤并检查条件；超时失败，可取消。', 'Immediately run polling steps and check a condition; cancellable with timeout.'],
  ['session.create', '新建会话并发送', 'Create and send', {op:'session.create',message:'你好',saveAs:'receipt'}, '保存现有新建页草稿后发送第一条消息，返回绑定账号、会话和请求的回执。', 'Preserve a New Task draft, send the first message and return an account/conversation/request receipt.'],
  ['session.send', '向指定可见会话发送', 'Send to visible session', {op:'session.send',conversationId:'{{vars.receipt.conversationId}}',message:'继续',saveAs:'receipt'}, '仅发送到已挂载且选中的指定会话；草稿非空时拒绝，未确认发送不会自动重发。', 'Only send to the selected mounted conversation; reject occupied drafts and never automatically resend unconfirmed sends.'],
  ['session.wait', '等待指定回复完成', 'Wait for bound reply', {op:'session.wait',receipt:'{{vars.receipt}}',timeoutMs:180000}, '按回执绑定账号、会话和请求等待完成；失败、取消或身份变化时退出。', 'Wait by account/conversation/request receipt; fail on errors, cancellation or identity changes.'],
  ['state.checkpoint', '保存检查点', 'Save checkpoint', {op:'state.checkpoint',key:'progress',value:{done:'{{vars.done}}'}}, '显式保存进度，使用 state.get 恢复；不会自动重放发送或其他副作用。', 'Explicitly save progress; restore with state.get. Never automatically replay sends or other side effects.'],
]) CAPABILITIES.push({id,zh,en,example,descriptionZh,descriptionEn});
for (const item of CAPABILITIES) {
  if (['session.sendCurrent','session.waitReply','notify.afterAllTasks','event.clientLoaded'].includes(item.id)) item.deprecated = true;
  if (item.id === 'session.sendCurrent') { item.descriptionZh = '兼容旧任务：实际进入新建任务后发送。新任务使用 session.create。'; item.descriptionEn = 'Legacy: navigates to New Task and sends. Use session.create for new tasks.'; }
  if (item.id === 'session.waitReply') { item.descriptionZh = '兼容旧任务：等待本轮发送绑定的会话回复。新任务使用 session.wait。'; item.descriptionEn = 'Legacy: wait for this run’s bound send. Use session.wait for new tasks.'; }
  if (item.id === 'http.requestAsAccount') item.example.url = 'https://www.workbuddy.cn/api/example';
}

const SUPPORTED_OPS = new Set(CAPABILITIES.filter((item) => !item.id.startsWith('event.') && item.available !== false).map((item) => item.id));

function storePath(dataDir) { return path.join(dataDir, 'automations.json'); }

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }

function safeId(value) {
  const id = String(value || '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id) ? id : '';
}

function readAutomations(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(dataDir), 'utf8'));
    const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.items) ? raw.items : [];
    return list.filter(Boolean).map((item) => isSupportedTaskSchema(item) ? normalizeTask(item) : clone(item));
  } catch (_) { return []; }
}

function writeAutomations(dataDir, items) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = storePath(dataDir);
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(items, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

let automationRuntime = {};
function configureAutomationRuntime(runtime) { automationRuntime = {...runtime}; }
function isTaskCompatible(task) {
  try { validateTask(task); return !task.requires || assessRequirements(task.requires, {...automationRuntime,capabilities:CAPABILITIES.filter(c=>c.available!==false).map(c=>c.id)}).length === 0; } catch (_) { return false; }
}

function isSupportedTaskSchema(task) { return !!task && (task.schemaVersion == null || task.schemaVersion === SCHEMA_VERSION); }

function normalizeTask(input) {
  const src = input && typeof input === 'object' ? input : {};
  if (!isSupportedTaskSchema(src)) return clone(src);
  const { manualRunnable, compatible, ...preserved } = clone(src);
  const id = safeId(src.id) || ('task_' + crypto.randomBytes(5).toString('hex'));
  const steps = Array.isArray(src.steps) ? src.steps.slice(0, MAX_STEPS) : [];
  return {
    ...preserved,
    schemaVersion: SCHEMA_VERSION,
    id,
    name: String(src.name || id).slice(0, 120),
    description: String(src.description || '').slice(0, 500),
    enabled: src.enabled !== false,
    trigger: normalizeTrigger(src.trigger),
    schedule: src.schedule && typeof src.schedule === 'object' ? clone(src.schedule) : { type: 'manual' },
    variables: src.variables && typeof src.variables === 'object' ? clone(src.variables) : {},
    steps,
    onSuccess: Array.isArray(src.onSuccess) ? src.onSuccess.slice(0, 40) : [],
    onFailure: Array.isArray(src.onFailure) ? src.onFailure.slice(0, 40) : [],
    updatedAt: Number(src.updatedAt) || Date.now(),
  };
}

function normalizeTrigger(input) {
  const src = input && typeof input === 'object' ? input : {};
  const type = String(src.type || 'manual').trim();
  return {
    ...clone(src),
    type,
    ...(Array.isArray(src.types) ? { types: [...new Set(src.types.filter((v) => v !== 'manual'))] } : {}),
    oncePerNavigation: src.oncePerNavigation !== false,
    // 仅幂等的页面清理任务主动启用：换页时结束旧轮，再检测新页面。
    ...(src.restartOnNavigation === true ? { restartOnNavigation: true } : {}),
  };
}


// Legacy single triggers remain valid; a types array explicitly selects multiple events.
function canManuallyRunTask(task) {
  if (!isTaskCompatible(task)) return false;
  const trigger = task.trigger || {};
  const types = Array.isArray(trigger.types) ? trigger.types : [trigger.type || 'manual'];
  return !types.some((type) => type && type !== 'manual') && !(task.schedule && task.schedule.type !== 'manual');
}

function taskMatchesEvent(task, type, detail = {}) {
  if (!isTaskCompatible(task) || !task.enabled) return false;
  const trigger = task.trigger || {};
  const types = Array.isArray(trigger.types) ? trigger.types : [trigger.type];
  return types.some((t) => t === type || type === 'pageReady' && (t === 'pageLoaded' || t === 'accountSwitched' && /account-switch/.test(detail.source || '') || t === 'clientLoaded' && detail.source === 'connect'));
}

function validateSchedule(schedule) {
  if (!schedule || !['manual', 'interval', 'daily', 'weekly', 'monthly', 'once'].includes(schedule.type)) throw new Error('不支持的定时方式');
  if (schedule.type === 'interval' && (!Number.isInteger(schedule.minutes) || schedule.minutes < 1 || schedule.minutes > 10080)) throw new Error('定时间隔必须是 1–10080 分钟的整数');
  if (['daily', 'weekly', 'monthly'].includes(schedule.type) && !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time || '')) throw new Error('请选择有效的执行时间');
  if (schedule.type === 'weekly' && (!Array.isArray(schedule.days) || !schedule.days.length || schedule.days.some(d => !Number.isInteger(d) || d < 0 || d > 6))) throw new Error('请至少选择一个星期');
  if (schedule.type === 'monthly' && (!Number.isInteger(schedule.day) || schedule.day < 1 || schedule.day > 31)) throw new Error('每月日期必须是 1–31');
  if (schedule.type === 'once') {
    const value = String(schedule.at || '');
    const date = new Date(value);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || localScheduleSlot(date) !== value) throw new Error('请选择有效的执行日期和时间');
  }
  return schedule;
}

function localScheduleSlot(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function createScheduleTicker(dataDir) {
  const due = new Map();
  const stateFile = dataDir && path.join(dataDir, 'automation-schedule-state.json');
  let marks = {};
  try { if (stateFile) marks = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (_) {}
  if (!marks || typeof marks !== 'object' || Array.isArray(marks)) marks = {};
  return (tasks, start, isRunning, now = Date.now()) => {
    const ids = new Set();
    for (const task of tasks) {
      const schedule = task.schedule;
      if (!isTaskCompatible(task) || !task.enabled || !schedule || schedule.type === 'manual') continue;
      try { validateSchedule(schedule); } catch (_) { continue; }
      ids.add(task.id);
      if (schedule.type === 'interval') {
        const interval = schedule.minutes * 60000;
        let entry = due.get(task.id);
        if (!entry || entry.interval !== interval) {
          entry = { interval, next: now + interval };
          due.set(task.id, entry);
        }
        if (now < entry.next) continue;
        entry.next = now + interval;
      } else {
        due.delete(task.id);
        const date = new Date(now), slot = localScheduleSlot(date);
        const time = slot.slice(11);
        const matches = schedule.type === 'once' ? slot === schedule.at : time === schedule.time &&
          (schedule.type !== 'weekly' || schedule.days.includes(date.getDay())) &&
          (schedule.type !== 'monthly' || schedule.day === date.getDate());
        if (!matches || marks[task.id] && marks[task.id] >= slot) continue;
        // Persist before dispatch: restarts, DST fallback and a busy task must
        // not repeat the same wall-clock slot. Missed slots are never replayed.
        marks[task.id] = slot;
        if (stateFile) {
          try { atomicWriteText(stateFile, JSON.stringify(marks) + '\n'); }
          catch (_) { continue; }
        }
      }
      if (!isRunning(task.id)) start(task, { type: 'schedule', source: schedule.type });
    }
    for (const id of due.keys()) if (!ids.has(id)) due.delete(id);
  };
}

// Navigation-scoped click-only observers must keep dismissing late popups while
// an account loop waits for a reply. They share the short input gate instead of
// monopolizing the renderer for their entire observation window.
function taskIsPassiveCleanup(task) {
  if (!(task.trigger && task.trigger.restartOnNavigation)) return false;
  const allowed = new Set(['logic.sequence','logic.repeat','logic.retry','logic.catch','logic.delay','logic.if','logic.assert','logic.switch','dom.find','dom.click','dom.wait','dom.readText','dom.readAttribute','notify.toast','notify.dismiss']);
  let clicks = 0, valid = true;
  const walk = value => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') {
      if (value.op) { if (!allowed.has(value.op)) valid = false; if (value.op === 'dom.click') { clicks++; const locators = value.locators || [value.locator]; if (!locators.every(l=>l && l.visible === true && /close|dismiss|关闭|不再展示/i.test(l.value || ''))) valid = false; } }
      Object.values(value).forEach(walk);
    }
  };
  walk([task.steps,task.onSuccess,task.onFailure]);
  return valid && clicks > 0;
}

function taskNeedsPanelClosed(task) {
  const walk = (value) => {
    if (Array.isArray(value)) return value.some(walk);
    if (!value || typeof value !== 'object') return false;
    if (/^(dom\.|session\.)/.test(value.op || '') || value.op === 'account.forEach' && (value.switch === true || value.switchAccounts === true)) return true;
    return Object.values(value).some(walk);
  };
  return walk([task.steps, task.onSuccess, task.onFailure]);
}

function installBuiltinTask(dataDir, file) {
  const task = validateTask(JSON.parse(fs.readFileSync(file, 'utf8')));
  const markerFile = path.join(dataDir, 'automation-builtins.json');
  let markers = {};
  try { markers = JSON.parse(fs.readFileSync(markerFile, 'utf8')); } catch (_) {}
  if (markers[task.id]) return;
  const tasks = readAutomations(dataDir);
  if (!tasks.some((t) => t.id === task.id)) {
    if (tasks.length >= MAX_TASKS) return;
    writeAutomations(dataDir, tasks.concat(task));
  }
  atomicWriteText(markerFile, JSON.stringify({ ...markers, [task.id]: true }) + '\n');
}

function validateLocator(locator) {
  if (!locator || typeof locator !== 'object') throw new Error('缺少 locator');
  const kind = String(locator.kind || '').trim();
  const value = String(locator.value || '').trim();
  if (!['css', 'xpath', 'text', 'role', 'ariaLabel', 'placeholder', 'attribute', 'coordinates'].includes(kind)) {
    throw new Error('不支持的定位方式: ' + kind);
  }
  if (!value && kind !== 'coordinates') throw new Error('locator.value 不能为空');
  if (kind === 'coordinates' && (!Number.isFinite(Number(locator.x)) || !Number.isFinite(Number(locator.y)))) throw new Error('坐标定位无效');
}

function validateSteps(steps, depth = 0) {
  if (!Array.isArray(steps)) throw new Error('steps 必须是数组');
  if (depth > MAX_DEPTH) throw new Error('任务嵌套层级过深');
  if (steps.length > MAX_STEPS) throw new Error('步骤数量超过限制');
  steps.forEach((step, index) => {
    if (!step || typeof step !== 'object') throw new Error(`第 ${index + 1} 步不是对象`);
    const op = String(step.op || '').trim();
    if (op === 'notify.toast' || op === 'notify.dismiss') {
      const id = typeof step.id === 'string' && /\{\{[\w. -]+\}\}/.test(step.id) ? 'template-id' : step.id;
      normalizeToastOptions({ ...step, id }, op === 'notify.dismiss');
    }
    if (/^state\./.test(op) && (!['task','account'].includes(step.scope || 'task') || typeof step.key !== 'string' || !step.key.trim())) throw new Error('状态需要有效的 scope 和 key');
    if (step.saveAs && (!/^[A-Za-z_][\w-]{0,79}$/.test(step.saveAs) || ['__proto__','prototype','constructor'].includes(step.saveAs))) throw new Error('saveAs 必须是变量名');
    if (step.locators) { if (!Array.isArray(step.locators) || !step.locators.length || step.locators.length > 10) throw new Error('候选定位器需要 1–10 项'); step.locators.forEach(validateLocator); }
    if (!SUPPORTED_OPS.has(op)) throw new Error(`第 ${index + 1} 步不支持能力: ${op || '(空)'}`);
    if (['logic.sequence', 'logic.repeat', 'logic.retry', 'logic.catch', 'logic.forEach', 'logic.waitUntil', 'account.forEach'].includes(op)) validateSteps(step.steps || [], depth + 1);
    if (op === 'logic.retry' && /\"op\"\s*:\s*\"session\.(create|send|sendCurrent)\"/.test(JSON.stringify(step.steps || []))) throw new Error('会话发送不能放入 retry，避免重复发送');
    if (op === 'logic.catch') validateSteps(step.onError || [], depth + 1);
    if (op === 'logic.if') { validateSteps(step.then || [], depth + 1); validateSteps(step.else || [], depth + 1); }
    if (op === 'logic.switch') {
      Object.values(step.cases || {}).forEach((value) => validateSteps(value || [], depth + 1));
      validateSteps(step.default || [], depth + 1);
    }
    if (['dom.find', 'dom.click', 'dom.type', 'dom.clear', 'dom.press', 'dom.readText', 'dom.readAttribute', 'dom.wait'].includes(op) && step.locator) validateLocator(step.locator);
    if (op === 'http.request' || op === 'http.requestAsAccount') {
      const url = String(step.url || '').trim();
      if (!/^https?:\/\//i.test(url) && !/^\{\{\s*[\w.-]+\s*\}\}$/.test(url)) throw new Error(`第 ${index + 1} 步 URL 仅支持 http(s)`);
      if (url.length > 2048) throw new Error(`第 ${index + 1} 步 URL 过长`);
    }
  });
}

function validateTask(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('任务必须是 JSON 对象');
  if (input.kind != null) throw new Error('任务包或索引不能作为本地任务执行');
  if (input.schemaVersion != null && input.schemaVersion !== 1) throw new Error('不支持的任务协议版本');
  if (input.id != null && !safeId(input.id)) throw new Error('任务 ID 无效');
  if (input.requires) { validateRequirements(input.requires); if(input.requires.taskSchemaVersion !== (input.schemaVersion || 1)) throw new Error('任务协议与兼容要求不一致'); }
  for(const [key,limit] of [['steps',MAX_STEPS],['onSuccess',40],['onFailure',40]]) if(input[key]!=null && (!Array.isArray(input[key]) || input[key].length>limit)) throw new Error('任务步骤不是数组或超过数量限制');
  if (input.trigger) {
    const allowed = ['manual','pageReady','pageLoaded','accountSwitched','clientLoaded','panelOpened'];
    if (input.trigger.type && !allowed.includes(input.trigger.type) || input.trigger.types != null && (!Array.isArray(input.trigger.types) || input.trigger.types.some(t=>!allowed.includes(t)))) throw new Error('不支持的触发方式');
  }
  const task = normalizeTask(input);
  if (!safeId(task.id)) throw new Error('任务 ID 必须是字母、数字、下划线或短横线');
  if (!task.name.trim()) throw new Error('任务名称不能为空');
  if (!['manual', 'pageReady', 'pageLoaded', 'accountSwitched', 'clientLoaded', 'panelOpened'].includes(task.trigger.type)) throw new Error('不支持的触发方式: ' + task.trigger.type);
  validateSchedule(task.schedule);
  validateSteps(task.steps);
  validateSteps(task.onSuccess || []);
  validateSteps(task.onFailure || []);
  return task;
}

function interpolate(value, ctx) {
  if (typeof value !== 'string') return value;
  return value.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key) => {
    const parts = key.split('.');
    let cur = ctx;
    for (const part of parts) cur = cur == null ? undefined : cur[part];
    return cur == null ? '' : String(cur);
  });
}

function resolveValue(value, ctx) {
  if (Array.isArray(value)) return value.map(item => resolveValue(item, ctx));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, resolveValue(v, ctx)]));
  if (typeof value !== 'string') return value;
  const exact = value.match(/^\{\{\s*([\w.-]+)\s*\}\}$/);
  if (!exact) return interpolate(value, ctx);
  const parts = exact[1].split('.');
  let cur = ctx;
  for (const part of parts) cur = cur == null ? undefined : cur[part];
  return cur;
}

function getPath(ctx, key) { return resolveValue('{{' + String(key || '') + '}}', ctx); }

function compare(left, operator, right) {
  if (['gt','gte','lt','lte'].includes(operator)) {
    if (left == null || right == null || left === '' || right === '' || !Number.isFinite(Number(left)) || !Number.isFinite(Number(right))) return false;
    return ({gt: (a,b)=>a>b, gte:(a,b)=>a>=b, lt:(a,b)=>a<b, lte:(a,b)=>a<=b})[operator](Number(left),Number(right));
  }
  if (operator === 'equals') return left === right || String(left) === String(right);
  if (operator === 'notEquals') return !(left === right || String(left) === String(right));
  if (operator === 'contains') return String(left == null ? '' : left).includes(String(right == null ? '' : right));
  if (operator === 'matches') { try { return new RegExp(String(right)).test(String(left == null ? '' : left)); } catch (_) { return false; } }
  if (operator === 'truthy') return !!left;
  if (operator === 'falsy') return !left;
  throw new Error('不支持的判断运算符: ' + operator);
}

function capabilityText(language = 'zh') {
  const zh = language !== 'en';
  const available = CAPABILITIES.filter((item) => item.available !== false);
  const reserved = CAPABILITIES.filter((item) => item.available === false);
  const triggers = available.filter((item) => item.id.startsWith('event.'));
  const executable = available.filter((item) => !item.id.startsWith('event.'));
  const groups = {};
  CAPABILITIES.filter(item => item.available !== false).forEach((item) => {
    const group = item.id.split('.')[0];
    if (!groups[group]) groups[group] = [];
    groups[group].push(item.id + (item.available === false ? (zh ? '（预留）' : ' (reserved)') : ''));
  });
  const lines = zh ? [
    'WorkDaddy 自动化任务协议 v1',
    '',
    '任务 JSON：',
    JSON.stringify({ schemaVersion: 1, id: 'example-task', name: '任务名称', description: '', enabled: true, trigger: { type: 'manual', oncePerNavigation: true }, variables: {}, steps: [], onSuccess: [], onFailure: [] }, null, 2),
    '',
    '任务字段：schemaVersion 固定为 1；id 在全部任务中唯一；name 必填；description 可空；enabled 控制生命周期触发；variables 是任务初始变量；steps 是主步骤；onSuccess/onFailure 分别在成功/失败后执行。',
    '约束：最多 200 个任务；每组最多 200 个步骤；最多嵌套 12 层；单次重复最多 100 次；重试最多 10 次；单次等待最多 300 秒。任务中不要保存 Token、Cookie 或密码。',
    '触发器：manual 仅手动运行；pageReady 在首次打开、导航完成或账号切换后的页面刷新完成后运行。pageReady 默认同一次页面导航只触发一次；pageLoaded 同样覆盖页面加载（包括切换刷新）；accountSwitched 仅账号切换；clientLoaded 仅 daemon 连接已加载客户端时触发（兼容名，不建议新任务使用）。组合事件同一导航只执行一次。',
    '组合触发：trigger.types:["clientLoaded","panelOpened"] 可多选，存在时替代 trigger.type；空数组仅手动。schedule:{type:"interval",minutes:60} 每小时触发（1–10080 分钟）；也支持 {type:"daily",time:"09:00"}、{type:"weekly",days:[1,2,3,4,5],time:"09:00"}（0=周日）、{type:"monthly",day:15,time:"09:00"}、{type:"once",at:"2026-12-01T09:00"}。均为电脑本地时区，每月不存在的日期跳过，指定时间任务不会重复，可与事件组合；enabled:false 停止所有自动触发。自动任务不提供立即运行；需要测试时在编辑器清空自动触发条件并关闭定时，再手动运行。运行中的同一任务不会重入，错过的定时不会补跑。POST /api/automations/events {type:"panelOpened"} 在面板从关闭变为打开时调用，需标准本地 API 认证。',
    '签到：account.checkin 使用循环账号的 token，先检查本地今日已验证记录，成功则跳过（包括 token 刷新）；失败返回 ok:false，单账号异常可用 logic.catch 捕获。无需 switch:true。',
    '通用步骤字段：op 必填；saveAs 可把该步骤返回值保存到 {{vars.<name>}}；每个步骤的返回值也会覆盖 {{step.*}}。嵌套步骤仍按顺序执行。',
    '模板变量：{{now}}、{{event.type}}、{{event.account.uid}}、{{account.uid}}、{{account.nickname}}、{{vars.name}}、{{response.status}}、{{response.text}}、{{response.json}}、{{step.*}}。对象与数组递归展开模板；完整字符串模板保留原始数值/对象/数组类型，混合文本模板会转成字符串。',
    '条件运算符：equals、notEquals、contains、matches、truthy、falsy、gt、gte、lt、lte。matches 的 right 是正则表达式字符串。',
    '账号作用域：account.forEach 默认只改变嵌套步骤的账号上下文；设置 switch:true 才会真实切换登录账号，并在循环结束后恢复原账号。account.status 和 http.requestAsAccount 使用当前上下文；DOM 与当前会话步骤操作切换后的可见 WorkBuddy 页面。',
    '元素定位 locator：{kind,value}。kind 支持 css、xpath、text、role、ariaLabel、placeholder、attribute。coordinates 仅保留协议格式，当前不可用于 DOM 步骤。',
    'DOM 等待：dom.wait 可使用 seconds 做固定等待；或使用 locator、until:{state:"visible"|"hidden"|"attached"|"detached"|"clickable"}、timeoutMs 等待元素状态。until 还支持 text 包含匹配或 attribute/value 相等。locators 数组提供依次回退的定位器；readText 最多 100000 字符。iframe 内目前只支持读取，不支持点击与输入。DOM 读取结果可用 saveAs 保存。',
    'HTTP 输入：method、url、query、headers、body、timeoutMs（500-60000）、saveAs。响应：{ok,status,headers,text,json}，正文最多 1 MiB。http.request 不允许自定义 Authorization/Cookie；http.requestAsAccount 只对当前客户端官方 HTTPS origin 注入账号登录态；禁止跨域、非默认端口、URL 用户名密码。重定向不会自动跟随。body/query/headers 支持递归模板。默认非 2xx 返回 ok:false 供分支判断；throwOnHttpError:true 抛错以配合 retry（支持 backoff，默认 1）。停止会中止 HTTP 和等待。',
    '会话：session.create 新建并发送第一条消息；session.send 仅向选中且无草稿的指定 conversationId 发送；返回 {accountUid,conversationId,userMessageId,requestId,baselineAssistantId} 回执，saveAs 保存。session.wait 接受 receipt（默认 vars.session）、timeoutMs（最长 300000）、contains，按回执监听。未知发送结果不会自动重发；发送不能嵌套 retry。session.sendCurrent/waitReply 是兼容别名，前者实际上新建会话。仅支持挂载的可见会话，不支持后台任意会话发送。',
    '状态作用域：state.get/state.set 的 scope 支持 task（默认）或 account；所有状态首先按任务 ID 隔离；task scope 不随账号变化，account scope 再按 uid 隔离；写入合并最新状态。旧版本无任务 ID 的歧义状态不会自动归入任何任务。key 必填；state.get 可配 saveAs。',
    '通知：notify.toast 使用 react-hot-toast，从窗口底部向上弹出；level 支持 info、success、warning、error、loading。可选 duration（1000–60000 毫秒）、id、saveAs；相同 id 更新提示，notify.dismiss 用 id 关闭。id 按本次运行隔离，任务结束自动清理 loading。notify.afterAllTasks 已废弃，仅兼容旧任务；新任务不要使用。',
    '失败语义：未捕获错误会停止主步骤并执行 onFailure；logic.catch 捕获局部错误并把消息写入 {{vars.error.message}}；logic.retry 只重试其嵌套步骤。',
    '',
    '基础接口总目录：',
  ] : [
    'WorkDaddy Automation Task Protocol v1',
    '',
    'Task JSON:',
    JSON.stringify({ schemaVersion: 1, id: 'example-task', name: 'Task name', description: '', enabled: true, trigger: { type: 'manual', oncePerNavigation: true }, variables: {}, steps: [], onSuccess: [], onFailure: [] }, null, 2),
    '',
    'Task fields: schemaVersion is 1; id is unique; name is required; description may be empty; enabled controls lifecycle triggers; variables contains initial values; steps is the main sequence; onSuccess/onFailure run after success/failure.',
    'Limits: 200 tasks; 200 steps per group; nesting depth 12; 100 repeat iterations; 10 retry attempts; 300 seconds per wait. Never store tokens, cookies, or passwords in a task.',
    'Triggers: manual only runs on demand; pageReady runs after initial load, navigation, or the page refresh following an account switch. pageReady runs once per navigation by default; pageLoaded includes all page loads; accountSwitched only matches switches; clientLoaded is a legacy connection-only trigger. Combined events run once per navigation.',
    'Combined triggers: trigger.types:["clientLoaded","panelOpened"] overrides trigger.type. Empty types means manual only. schedule:{type:"interval",minutes:60} adds an interval of 1–10080 minutes. Also supported: {type:"daily",time:"09:00"}, {type:"weekly",days:[1,2,3,4,5],time:"09:00"} (0=Sunday), {type:"monthly",day:15,time:"09:00"}, {type:"once",at:"2026-12-01T09:00"}. All use local computer time; nonexistent month dates and missed slots are skipped, and calendar slots are not repeated after restart. Only tasks without automatic triggers or a schedule can run manually. Disabled tasks do not auto-run; running tasks skip overlapping triggers. POST /api/automations/events {type:"panelOpened"} requires local API authentication. account.checkin uses the context account token and skips all requests for a confirmed daily check-in; use logic.catch to handle individual account errors.',
    'Common step fields: op is required; saveAs stores the returned value at {{vars.<name>}}; each result also replaces {{step.*}}. Nested steps execute sequentially.',
    'Template values: {{now}}, {{event.type}}, {{event.account.uid}}, {{account.uid}}, {{account.nickname}}, {{vars.name}}, {{response.status}}, {{response.text}}, {{response.json}}, {{step.*}}. Objects and arrays recursively resolve templates. A whole-value template preserves numbers/objects/arrays; interpolation inside text produces a string.',
    'Condition operators: equals, notEquals, contains, matches, truthy, falsy, gt, gte, lt, lte. matches treats right as a regular-expression string.',
    'Account scope: account.forEach only changes nested context by default. Set switch:true to physically switch the logged-in account and restore the original account after the loop. account.status and http.requestAsAccount use the current context; DOM and current-session steps operate the visible WorkBuddy page after switching.',
    'Locator: {kind,value}. kind supports css, xpath, text, role, ariaLabel, placeholder, and attribute. coordinates is reserved and unavailable to current DOM steps.',
    'DOM waits: use seconds for a fixed delay, or locator plus until:{state:"visible"|"hidden"|"attached"|"detached"|"clickable"} and timeoutMs. until also accepts text containment or attribute/value equality. locators supplies ordered fallbacks; readText is capped at 100000 characters. Iframes support reads only, not clicks or input. DOM read results can be stored with saveAs.',
    'HTTP input: method, url, query, headers, body, timeoutMs (500-60000), saveAs. Response: {ok,status,headers,text,json}; body is capped at 1 MiB. http.request rejects Authorization/Cookie; http.requestAsAccount injects credentials only for current-profile official HTTPS origins, rejecting foreign origins, ports and URL credentials. Redirects are not followed. body/query/headers resolve recursive templates. Non-2xx returns ok:false by default; throwOnHttpError:true enables retry (backoff defaults to 1). Cancellation aborts HTTP and waits.',
    'Sessions: session.create creates by sending the first message; session.send targets only a selected conversationId with an empty composer. Returns {accountUid,conversationId,userMessageId,requestId,baselineAssistantId}; saveAs persists the receipt in variables. session.wait accepts receipt (default vars.session), timeoutMs (up to 300000), contains. Unconfirmed sends are never automatically retried; sends cannot be nested in retry. sendCurrent/waitReply are legacy aliases; sendCurrent creates a new conversation. Only mounted visible sessions are supported.',
    'State scope: state.get/state.set scope is task (default) or account. all state is isolated by task ID first, with an additional uid dimension for account scope. Writes merge the latest state. Ambiguous legacy state without task IDs is not automatically assigned to any task. key is required; state.get accepts saveAs.',
    'Notifications: notify.toast uses react-hot-toast at bottom-center. level is info, success, warning, error, or loading. Optional duration (1000–60000 ms), id, and saveAs; reuse id to update, notify.dismiss with id to dismiss. IDs are scoped to a run; unfinished loading notifications are cleared when the run ends. notify.afterAllTasks is deprecated and retained only for saved tasks. Do not generate it for new tasks.',
    'Failure behavior: an uncaught error stops main steps and runs onFailure. logic.catch writes a local error to {{vars.error.message}}. logic.retry retries only its nested steps.',
    '',
    'Capability index:',
  ];
  lines.push(zh
    ? `${CAPABILITIES.length} 项：${triggers.length} 个触发事件，${executable.length} 个可执行 op，${reserved.length} 个预留接口。event.* 只能写入 trigger.type；只有可执行 op 能写入任务步骤。`
    : `${CAPABILITIES.length} entries: ${triggers.length} trigger events, ${executable.length} executable ops, ${reserved.length} reserved interface. event.* belongs in trigger.type; only executable ops may be used in task steps.`);
  Object.keys(groups).forEach((group) => lines.push(group + ': ' + groups[group].join(', ')));
  lines.push('', zh ? '逐项说明与最小示例：' : 'Per-operation reference and minimal examples:');
  CAPABILITIES.filter(item => item.available !== false).forEach((item) => {
    const availability = item.deprecated ? (zh ? ' [兼容旧任务，新任务勿用]' : ' [legacy, avoid in new tasks]') : '';
    lines.push('', item.id + availability, (zh ? item.zh + '：' + item.descriptionZh : item.en + ': ' + item.descriptionEn), JSON.stringify(item.example, null, 2));
  });
  lines.push('', zh ? '账号状态字段：checkin.today、activity.today、activity.streak、credits。返回 uid、isPrimary、checkin、activity、credits；activity.streak={days,status}，days=null 表示不可用；credits={total,unlimited,cycleResetTime}。活跃天数是连续活跃天数，不是注册天数。' : 'Account fields: checkin.today, activity.today, activity.streak, credits. Returns uid,isPrimary,checkin,activity,credits. activity.streak={days,status}; null means unavailable. credits={total,unlimited,cycleResetTime}. Streak means consecutive active days, not registration age.');
  lines.push(zh ? '预检：POST /api/automations/validate 或 /api/automations/dry-run，body={task}，需本地认证。仅静态校验并返回操作计划/弃用警告，executed:false，不发请求、不切账号、不发送消息，不保证运行时 DOM/API 可用。state.checkpoint 显式保存业务进度，state.get 读取；不会自动恢复或重放副作用。修改同一渲染器的任务排队串行，静默 API 任务可并发；restartOnNavigation 的只读/关闭按钮监听不占用整轮锁，但点击与输入仍互斥，避免关闭弹窗任务阻塞发送；取消不代表已发送消息或已完成服务器操作可撤销。' : 'Preflight: authenticated POST /api/automations/validate or /api/automations/dry-run with {task}. Static validation and operation plan/deprecation warnings only; executed:false. No HTTP, switches or messages. Does not guarantee runtime DOM/API availability. state.checkpoint explicitly saves progress for state.get; never automatically resumes or replays side effects. Renderer tasks queue serially; silent API tasks can run concurrently. Navigation-scoped read/click-only observers share a short input lock so popup cleanup can run between sends. Cancellation cannot undo messages or completed server operations.');
  lines.push(zh ? '共享任务兼容：本地任务继续使用 schemaVersion:1，可选 requires={minWorkDaddyVersion,taskSchemaVersion,capabilities,profiles?,platforms?}；不满足依赖时不会执行。外部分发使用独立的 workdaddy.automation-package 包（formatVersion:1、独立 id/version、requires、inputs、task）。POST /api/automations/packages/preview {document,values?} 只预检，需检查 compatible:true；不会安装或执行。为本面板生成任务时仍输出本地任务 JSON，不要向 Agent 收件箱写入包或索引。' : 'Sharing compatibility: local tasks remain schemaVersion:1 and may declare requires={minWorkDaddyVersion,taskSchemaVersion,capabilities,profiles?,platforms?}; incompatible tasks never execute. Distribution uses a separate workdaddy.automation-package envelope with formatVersion:1, independent id/version, requires, inputs and task. POST /api/automations/packages/preview {document,values?} is preview-only; check compatible:true. No installation or execution. When creating tasks for this panel, keep generating local task JSON, never a package or index in the Agent inbox.');
  return lines.join('\n');
}

function agentBridgePaths(dataDir) {
  const root = path.join(dataDir, 'automation-agent');
  return {
    root,
    protocolZh: path.join(root, 'PROTOCOL.zh-CN.txt'),
    protocolEn: path.join(root, 'PROTOCOL.en.txt'),
    guide: path.join(root, 'README.txt'),
    inboxDir: path.join(root, 'inbox'),
    resultsDir: path.join(root, 'results'),
  };
}

function atomicWriteText(file, text) {
  const content = String(text);
  try {
    if (fs.readFileSync(file, 'utf8') === content) return;
  } catch (_) {}
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  try { fs.renameSync(tmp, file); }
  catch (error) {
    try { fs.rmSync(file, { force: true }); fs.renameSync(tmp, file); }
    catch (_) { try { fs.rmSync(tmp, { force: true }); } catch (_) {} throw error; }
  }
}

function agentGuideText(paths, profileId) {
  return [
    'WorkDaddy automation agent bridge',
    '',
    'Profile: ' + String(profileId || 'unknown'),
    'Chinese protocol: ' + paths.protocolZh,
    'English protocol: ' + paths.protocolEn,
    'Task inbox: ' + paths.inboxDir,
    'Import results: ' + paths.resultsDir,
    '',
    'Read the protocol, then write exactly one task JSON object to the requested .json file in inbox.',
    'The daemon validates the task and writes a same-name result JSON file in results.',
    'Do not place tokens, cookies, passwords, or executable code in a task.',
    'Do not edit automations.json directly.',
    '不要直接修改 automations.json。',
    '',
  ].join('\n');
}

function ensureAgentBridge(dataDir, options = {}) {
  const paths = agentBridgePaths(dataDir);
  fs.mkdirSync(paths.inboxDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(paths.resultsDir, { recursive: true, mode: 0o700 });
  atomicWriteText(paths.protocolZh, capabilityText('zh') + '\n');
  atomicWriteText(paths.protocolEn, capabilityText('en') + '\n');
  atomicWriteText(paths.guide, agentGuideText(paths, options.profileId));
  return paths;
}

function safeRequestId(value) {
  const id = String(value || '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(id) ? id : '';
}

function createAgentRequest(dataDir, options = {}) {
  const example = AGENT_EXAMPLES.find((item) => item.id === String(options.exampleId || ''));
  const custom = options.prompt !== undefined && options.prompt !== null;
  if (custom && (typeof options.prompt !== 'string' || !options.prompt.trim() || options.prompt.length > 6000)) throw new Error('自动化需求必须是 1–6000 字的文本');
  if (!custom && !example) throw new Error('未知的自动化示例');
  const language = options.language === 'en' ? 'en' : 'zh';
  const paths = ensureAgentBridge(dataDir, { profileId: options.profileId });
  const timestamp = Number(options.now) || Date.now();
  const requestId = safeRequestId('agent-' + timestamp.toString(36) + '-' + crypto.randomBytes(4).toString('hex'));
  const inboxFile = path.join(paths.inboxDir, requestId + '.json');
  const resultFile = path.join(paths.resultsDir, requestId + '.json');
  const protocolPath = language === 'en' ? paths.protocolEn : paths.protocolZh;
  const taskPrompt = custom ? options.prompt.trim() : language === 'en' ? example.promptEn : example.promptZh;
  const instructions = language === 'en' ? [
    'WorkDaddy has prepared a restricted local bridge for this request.',
    '1. Read the complete automation protocol at: ' + protocolPath,
    '2. Design one declarative task using only supported capabilities. Do not include tokens, cookies, passwords, shell commands, or JavaScript.',
    '3. Use your file-writing tool to write the final task JSON object, and nothing else, to this exact path: ' + inboxFile,
    '4. Do not edit automations.json directly and do not merely paste the JSON into your reply.',
    '5. Wait for WorkDaddy to create this result file and read it: ' + resultFile,
    '6. Only report success when that result contains "ok": true. If rejected, fix the task and write it again using a new id in the task JSON.',
  ] : [
    'WorkDaddy 已为本次请求准备了受约束的本地桥接通道。',
    '1. 先读取完整自动化协议：' + protocolPath,
    '2. 只使用协议支持的声明式能力设计一个任务。不要写入 Token、Cookie、密码、Shell 命令或 JavaScript。',
    '3. 使用你的文件写入工具，把最终的单个任务 JSON 对象（不要附带 Markdown）写入这个精确路径：' + inboxFile,
    '4. 不要直接修改 automations.json，也不要只在回复中粘贴 JSON。',
    '5. 等待 WorkDaddy 生成并读取结果文件：' + resultFile,
    '6. 只有结果包含 "ok": true 才算完成；如果被拒绝，请修正任务，并在任务 JSON 中使用新的 id 后重新写入。',
  ];
  return {
    requestId,
    exampleId: custom ? '' : example.id,
    title: custom ? (language === 'en' ? 'Create automation task' : '创建自动化任务') : language === 'en' ? example.titleEn : example.titleZh,
    prompt: taskPrompt + '\n\n' + instructions.join('\n'),
    protocolPath,
    inboxFile,
    resultFile,
  };
}

function importAgentInbox(dataDir, options = {}) {
  const paths = agentBridgePaths(dataDir);
  fs.mkdirSync(paths.inboxDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(paths.resultsDir, { recursive: true, mode: 0o700 });
  const now = Number(options.now) || Date.now();
  const settleMs = options.settleMs == null ? 750 : Math.max(0, Number(options.settleMs) || 0);
  const outcomes = [];
  let entries = [];
  try { entries = fs.readdirSync(paths.inboxDir, { withFileTypes: true }); } catch (_) { return outcomes; }
  for (const entry of entries.slice(0, 50)) {
    if (!entry.isFile() || !/^([A-Za-z0-9][A-Za-z0-9_-]{0,95})\.json$/.test(entry.name)) continue;
    const requestId = entry.name.slice(0, -5);
    const inboxFile = path.join(paths.inboxDir, entry.name);
    const resultFile = path.join(paths.resultsDir, entry.name);
    try {
      const stat = fs.lstatSync(inboxFile);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      if (settleMs > 0 && now - stat.mtimeMs < settleMs) continue;
      if (fs.existsSync(resultFile)) {
        let previous = null;
        try { previous = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch (_) {}
        if (previous && previous.ok === true) { fs.unlinkSync(inboxFile); continue; }
      }
      if (stat.size <= 0 || stat.size > MAX_AGENT_FILE_BYTES) throw new Error('任务文件必须是 1 MiB 以内的非空 JSON');
      const parsed = JSON.parse(fs.readFileSync(inboxFile, 'utf8'));
      if (parsed && parsed.kind) throw new Error('外部任务包需要独立预检与安装，不能通过 Agent 收件箱自动启用');
      const task = validateTask(parsed && parsed.task ? parsed.task : parsed);
      const tasks = readAutomations(dataDir);
      if (tasks.some((item) => item.id === task.id)) throw new Error('自动化任务 ID 已存在，请使用新的 id');
      if (tasks.length >= MAX_TASKS) throw new Error('自动化任务数量已达到上限');
      writeAutomations(dataDir, [task].concat(tasks));
      const result = { ok: true, requestId, taskId: task.id, importedAt: Date.now() };
      atomicWriteText(resultFile, JSON.stringify(result, null, 2) + '\n');
      fs.unlinkSync(inboxFile);
      outcomes.push(result);
    } catch (error) {
      const result = { ok: false, requestId, error: String(error && error.message || error).slice(0, 500), rejectedAt: Date.now() };
      try { atomicWriteText(resultFile, JSON.stringify(result, null, 2) + '\n'); } catch (_) {}
      try { fs.unlinkSync(inboxFile); } catch (_) {}
      outcomes.push(result);
    }
  }
  return outcomes;
}

function locatorExpression(locator) {
  const kind = String(locator.kind || 'css');
  const value = String(locator.value || '');
  const q = JSON.stringify(value);
  if (kind === 'xpath') return `document.evaluate(${q},document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue`;
  if (kind === 'text') return `Array.from(document.querySelectorAll('button,a,[role="button"],input,textarea,[contenteditable="true"]')).find(e=>(e.innerText||e.textContent||e.value||'').trim().includes(${q}))`;
  if (kind === 'ariaLabel') return `document.querySelector('[aria-label="'+${q}+'"]')`;
  if (kind === 'placeholder') return `document.querySelector('[placeholder="'+${q}+'"]')`;
  if (kind === 'role') return `document.querySelector('[role="'+${q}+'"]')`;
  if (kind === 'attribute') return `document.querySelector('['+${q}+']')`;
  if (kind === 'coordinates') return 'null';
  return `document.querySelector(${q})`;
}

async function executeTask(taskInput, options = {}) {
  const task = validateTask(taskInput);
  if (!isTaskCompatible(task)) throw new Error('任务与当前 WorkDaddy 不兼容，请升级或使用适配版本');
  const ctx = { task, account: options.event && options.event.account ? clone(options.event.account) : null, event: clone(options.event) || null, vars: clone(task.variables) || {}, response: null, step: {}, state: {}, now: new Date().toISOString() };
  if (!ctx.account && options.currentAccount) ctx.account = await options.currentAccount();
  if (ctx.event) ctx.vars.event = clone(ctx.event);
  if (ctx.account) ctx.vars.account = clone(ctx.account);
  const getState = options.getState || (async () => undefined);
  const setState = options.setState || (async () => {});
  const log = typeof options.log === 'function' ? options.log : () => {};
  const isCancelled = typeof options.isCancelled === 'function' ? options.isCancelled : () => false;
  const assertActive = () => { if (isCancelled()) throw new Error('任务已停止'); };
  const wait = async ms => { let remaining = ms; do { assertActive(); const chunk = Math.min(100, Math.max(0,remaining)); await new Promise(r => setTimeout(r,chunk)); remaining -= chunk; } while(remaining>0); assertActive(); };
  const BREAK = Symbol('break');
  let loopDepth = 0;
  const withLoop = async fn => { loopDepth++; try { return await fn(); } finally { loopDepth--; } };
  let stepSerial = 0;
  const runSteps = async (steps) => {
    let last;
    for (const step of steps) {
      if (isCancelled()) throw new Error('任务已停止');
      const serial = ++stepSerial;
      const op = String(step && step.op || '');
      log('step:start:' + serial + ':' + op);
      try {
        last = await runStep(step);
        if (step.saveAs) ctx.vars[String(step.saveAs)] = last;
        log('step:complete:' + serial + ':' + op);
      } catch (error) {
        log('step:error:' + serial + ':' + op + ':' + String(error && error.message || error).slice(0, 300));
        throw error;
      }
      ctx.step = last == null ? {} : last;
    }
    return last;
  };
  const runStep = async (step) => {
    const op = String(step.op || '');
    if (op === 'logic.sequence') return runSteps(step.steps || []);
    if (op === 'logic.delay' || op === 'dom.wait' && step.seconds != null && !step.until && !step.locator) {
      const ms = Math.min(300000, Math.max(0, Number(step.ms != null ? step.ms : Number(step.seconds || 0) * 1000) || 0));
      await wait(ms);
      return { ok: true, waitedMs: ms };
    }
    if (op === 'logic.if') {
      const c = step.condition || {};
      const ok = compare(resolveValue(c.left, ctx), c.operator || 'truthy', resolveValue(c.right, ctx));
      return { ok, branch: ok ? 'then' : 'else', result: await runSteps(ok ? (step.then || []) : (step.else || [])) };
    }
    if (op === 'logic.switch') {
      const value = resolveValue(step.value, ctx);
      const key = String(value == null ? '' : value);
      const cases = step.cases && typeof step.cases === 'object' ? step.cases : {};
      const matched = Object.prototype.hasOwnProperty.call(cases, key);
      return { ok: true, key, matched, result: await runSteps(matched ? cases[key] : (step.default || [])) };
    }
    if (op === 'vars.set') { const key = String(step.key || ''); if (!/^[A-Za-z_][\w-]{0,79}$/.test(key) || ['__proto__','constructor','prototype'].includes(key)) throw new Error('变量名无效'); return (ctx.vars[key] = resolveValue(step.value, ctx)); }
    if (op === 'logic.break') { if (!loopDepth) throw new Error('break 只能用于循环'); throw BREAK; }
    if (op === 'logic.waitUntil') {
      const end = Date.now() + Math.min(300000, Math.max(100, Number(step.timeoutMs) || 10000));
      do {
        await runSteps(step.steps || []);
        const c = step.condition || {};
        if (compare(resolveValue(c.left,ctx), c.operator || 'truthy', resolveValue(c.right,ctx))) return {ok:true};
        if (Date.now() >= end) throw new Error('等待条件超时');
        await wait(Math.min(end-Date.now(), Math.max(100, Number(step.intervalMs)||250)));
      } while (true);
    }
    if (op === 'logic.repeat' || op === 'logic.forEach') {
      const items = op === 'logic.repeat' ? Array.from({length:Math.min(100,Math.max(0,Number(resolveValue(step.times,ctx))||0))},(_,i)=>i) : resolveValue(step.items,ctx);
      if (!Array.isArray(items) || items.length>1000) throw new Error('循环需要最多 1000 项的数组');
      const previous = {item:ctx.vars.item,index:ctx.vars.index}, results=[];
      try { await withLoop(async()=>{ for(let i=0;i<items.length;i++){ctx.vars.item=items[i];ctx.vars.index=i;results.push(await runSteps(step.steps||[]));} }); }
      catch(e){if(e!==BREAK)throw e;} finally {Object.assign(ctx.vars,previous);}
      return {ok:true,count:results.length,results};
    }
    if (op === 'logic.retry') {
      const times = Math.min(10, Math.max(1, Number(step.times) || 1));
      let error;
      for (let attempt = 1; attempt <= times; attempt++) {
        try { return await runSteps(step.steps || []); } catch (e) { if (e === BREAK) throw e; assertActive(); error = e; if (attempt < times) await wait(Math.min(60000, (Number(step.delayMs) || 500) * Math.pow(Math.max(1,Number(step.backoff)||1),attempt-1))); }
      }
      throw error;
    }
    if (op === 'logic.catch') {
      try {
        return { ok: true, result: await runSteps(step.steps || []) };
      } catch (error) {
        if (error === BREAK) throw error; assertActive();
        ctx.vars.error = { message: String(error && error.message || error) };
        return { ok: false, error: ctx.vars.error.message, result: await runSteps(step.onError || []) };
      }
    }
    if (op === 'account.list') return options.listAccounts ? options.listAccounts() : [];
    if (op === 'account.getPrimary') return options.primaryAccount ? options.primaryAccount() : null;
    if (op === 'account.getCurrent') { ctx.account = options.currentAccount ? await options.currentAccount() : null; ctx.vars.account = ctx.account; return ctx.account; }
    if (op === 'account.forEach') {
      const all = typeof options.listAccounts === 'function' ? await options.listAccounts() : [];
      const wanted = step.accounts === 'all' || !step.accounts ? all : all.filter((account) => (Array.isArray(step.accounts) ? step.accounts : [step.accounts]).includes(account.uid));
      const results = [];
      const physicallySwitch = step.switch === true || step.switchAccounts === true;
      const original = physicallySwitch && typeof options.currentAccount === 'function' ? await options.currentAccount() : null;
      if (physicallySwitch && (!original || !original.uid || typeof options.accountSwitch !== 'function')) throw new Error('账号切换循环不可用：无法确定当前账号或切换能力未启用');
      let failure = null;
      const previousAccount = ctx.account, previousVar = ctx.vars.account;
      loopDepth++;
      try {
        for (const account of wanted) {
          assertActive();
          ctx.account = account;
          ctx.vars.account = account;
          if (physicallySwitch) await options.accountSwitch(account);
          results.push(await runSteps(step.steps || []));
        }
      } catch (error) {
        failure = error;
        if (error !== BREAK) throw error;
      } finally {
        loopDepth--; ctx.account = previousAccount; ctx.vars.account = previousVar;
        if (physicallySwitch && original && original.uid) {
          try {
            const active = typeof options.currentAccount === 'function' ? await options.currentAccount() : null;
            if (!active || active.uid !== original.uid) await options.accountSwitch(original, { restore: true });
          } catch (restoreError) {
            if (!failure) throw restoreError;
            log('account:restore:error:' + String(restoreError && restoreError.message || restoreError).slice(0, 300));
          }
        }
      }
      return { ok: true, count: results.length, results };
    }
    if (op === 'account.checkin') {
      if (typeof options.accountCheckin !== 'function') throw new Error('账号签到能力不可用');
      const account = ctx.account || (typeof options.currentAccount === 'function' ? await options.currentAccount() : null);
      const result = await options.accountCheckin(account);
      if (step.saveAs) ctx.vars[String(step.saveAs)] = result;
      return result;
    }
    if (op === 'account.status') {
      if (typeof options.accountStatus !== 'function') throw new Error('账号状态能力不可用');
      const account = ctx.account || (typeof options.currentAccount === 'function' ? await options.currentAccount() : null);
      const result = await options.accountStatus(account, step.fields || []);
      ctx.accountStatus = result;
      return result;
    }
    if (op === 'http.request' || op === 'http.requestAsAccount') {
      if (typeof options.httpRequest !== 'function') throw new Error('HTTP 能力不可用');
      const req = { method: String(step.method || 'GET').toUpperCase(), url: interpolate(step.url, ctx), query: resolveValue(step.query,ctx), headers: resolveValue(step.headers,ctx), body: resolveValue(step.body,ctx), timeoutMs: step.timeoutMs, isCancelled };
      const account = op === 'http.requestAsAccount' ? ctx.account || (options.currentAccount ? await options.currentAccount() : null) : null;
      if (op === 'http.requestAsAccount' && (!account || !account.uid)) throw new Error('没有可用账号');
      const result = await options.httpRequest(req, account);
      if (step.throwOnHttpError === true && !result.ok) throw new Error('HTTP ' + result.status);
      ctx.response = result;
      if (step.saveAs) ctx.vars[String(step.saveAs)] = result;
      return result;
    }
    if (op === 'dom.find' || op === 'dom.click' || op === 'dom.type' || op === 'dom.clear' || op === 'dom.press' || op === 'dom.readText' || op === 'dom.readAttribute' || op === 'dom.wait') {
      if (typeof options.domAction !== 'function') throw new Error('DOM 能力不可用');
      const locator = resolveValue(step.locators || step.locator,ctx);
      const result = await options.domAction(op, locator, { text: interpolate(step.text || '', ctx), attribute: step.attribute, key: step.key, timeoutMs: step.timeoutMs, seconds: step.seconds, until: resolveValue(step.until,ctx) });
      if (step.saveAs) ctx.vars[String(step.saveAs)] = result;
      return result;
    }
    if (op === 'session.create' || op === 'session.send') {
      if (typeof options.sessionAction !== 'function') throw new Error('会话能力不可用');
      const receipt = await options.sessionAction(op, resolveValue(step,ctx)); ctx.vars.session = receipt; return receipt;
    }
    if (op === 'session.wait') { if (typeof options.sessionAction !== 'function') throw new Error('会话能力不可用'); return options.sessionAction(op, {...resolveValue(step,ctx),receipt:resolveValue(step.receipt,ctx)||ctx.vars.session}); }
    if (op === 'session.sendCurrent') {
      if (typeof options.sessionSendCurrent !== 'function') throw new Error('当前会话发送能力不可用');
      return options.sessionSendCurrent(interpolate(step.message || '', ctx));
    }
    if (op === 'session.waitReply') {
      if (typeof options.sessionWaitReply !== 'function') throw new Error('会话回复监听能力不可用');
      return options.sessionWaitReply({ timeoutMs: step.timeoutMs, contains: interpolate(step.contains || '', ctx) });
    }
    if (op === 'state.get') { const result = await getState(step.scope || 'task', ctx.account && ctx.account.uid, String(step.key || '')); if (step.saveAs) ctx.vars[String(step.saveAs)] = result; return result; }
    if (op === 'state.set' || op === 'state.checkpoint') { const value = resolveValue(step.value, ctx); await setState(step.scope || 'task', ctx.account && ctx.account.uid, String(step.key || ''), value); return { ok: true, value }; }
    if (op === 'notify.toast') {
      if (typeof options.notifyToast !== 'function') throw new Error('通知能力不可用');
      const detail = normalizeToastOptions({ ...step, id: step.id == null ? undefined : interpolate(step.id, ctx) });
      const result = await options.notifyToast(detail.level, interpolate(step.message || '', ctx), detail);
      if (step.saveAs) ctx.vars[String(step.saveAs)] = result;
      return result || { ok: true };
    }
    if (op === 'notify.dismiss') {
      if (typeof options.dismissToast !== 'function') throw new Error('关闭通知能力不可用');
      const detail = normalizeToastOptions({ id: interpolate(step.id || '', ctx) }, true);
      return options.dismissToast(detail.id);
    }
    if (op === 'notify.afterAllTasks') {
      if (typeof options.completionReport !== 'function') throw new Error('完成汇报能力不可用');
      return options.completionReport({ timeoutMs: step.timeoutMs });
    }
    if (op === 'notify.session') { if (typeof options.notifySession !== 'function') throw new Error('会话通知能力不可用'); return options.notifySession(interpolate(step.message || '', ctx), ctx.account); }
    if (op === 'logic.assert') { const c = step.condition || {}; if (!compare(resolveValue(c.left, ctx), c.operator || 'truthy', resolveValue(c.right, ctx))) throw new Error(String(step.message || '任务断言失败')); return { ok: true }; }
    throw new Error('不支持的能力: ' + op);
  };
  log('task:start:' + task.id);
  try {
    const result = await runSteps(task.steps);
    if (task.onSuccess.length) await runSteps(task.onSuccess);
    log('task:complete:' + task.id);
    return { ok: true, result, context: { account: ctx.account ? { uid: ctx.account.uid, nickname: ctx.account.nickname } : null, vars: ctx.vars } };
  } catch (error) {
    ctx.vars.error = { message: String(error && error.message || error) };
    if (task.onFailure.length) {
      try { await runSteps(task.onFailure); } catch (handlerError) { log('task:onFailure:' + String(handlerError && handlerError.message || handlerError)); }
    }
    throw error;
  }
}

module.exports = {
  isSupportedTaskSchema,
  isTaskCompatible,
  configureAutomationRuntime,
  canManuallyRunTask,
  taskMatchesEvent,
  createScheduleTicker,
  validateSchedule,
  taskNeedsPanelClosed,
  taskIsPassiveCleanup,
  installBuiltinTask,
  SCHEMA_VERSION,
  CAPABILITIES,
  SUPPORTED_OPS,
  AGENT_EXAMPLES,
  capabilityText,
  agentBridgePaths,
  ensureAgentBridge,
  createAgentRequest,
  importAgentInbox,
  storePath,
  readAutomations,
  writeAutomations,
  normalizeTask,
  validateTask,
  executeTask,
};
