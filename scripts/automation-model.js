'use strict';
/* ===== 自动化指定模型（session.create 的 model / thoughtLevel）=====
 *
 * WorkBuddy 的「新建任务」模型偏好存放在渲染进程 localStorage：
 *   cb-newtask:model:<uid> = { id, isThinking, reasoningEffort, contextWindow }
 *
 * 实测结论（2026-09-17，见 docs/automation-model-selection.md）：
 *   1. 该键就是新建任务所用模型的权威来源——写入后进入「新建任务」视图，
 *      会话落库的 sessions.model 等于写入的 id；
 *   2. 它是「进入视图时读取一次、之后非响应式」，因此必须在新建任务视图挂载
 *      **之前**写入，且任务结束后必须还原用户原值；
 *   3. models.json 里的本地自定义模型在 WorkBuddy 侧使用 `custom-local:` 前缀，
 *      且保留 models.json 中 id 的原始大小写。
 *
 * 本模块只做纯数据决策（键解析 / 偏好合并 / 静态校验），便于单元测试；
 * 真正的 localStorage 读写与 CDP 交互在 scripts/daemon.js。
 */

// 渲染进程里新建任务模型偏好的键前缀。
const NEW_TASK_MODEL_KEY_PREFIX = 'cb-newtask:model:';
// WorkBuddy 给 models.json 里本地自定义模型加的前缀（大小写敏感，原样保留 id）。
const CUSTOM_MODEL_KEY_PREFIX = 'custom-local:';
// 思考档位；与偏好对象里的 reasoningEffort 取值一致。
const THOUGHT_LEVELS = ['low', 'medium', 'high'];
// 模型键长度上限（含 custom-local: 前缀）。
const MODEL_KEY_MAX_LENGTH = 120;
// contextWindow 允许范围。
const CONTEXT_WINDOW_MIN = 1000;
const CONTEXT_WINDOW_MAX = 10000000;
// 会触发"指定模型"的步骤字段。
const AUTOMATION_MODEL_FIELDS = ['model', 'thoughtLevel', 'isThinking', 'contextWindow'];

/** 整个值就是模板（{{vars.x}}）时才允许延迟到运行时解析。 */
function isTemplateValue(value) {
  return typeof value === 'string' && /^\{\{\s*[\w.-]+\s*\}\}$/.test(value.trim());
}

function newTaskModelStorageKey(uid) {
  const id = String(uid == null ? '' : uid).trim();
  if (!id) throw new Error('缺少账号 uid，无法写入模型偏好');
  return NEW_TASK_MODEL_KEY_PREFIX + id;
}

/** 步骤里是否请求了模型相关字段（静态校验与 session.send 拒绝共用）。 */
function hasAutomationModelRequest(detail) {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return false;
  return AUTOMATION_MODEL_FIELDS.some((key) => detail[key] != null && detail[key] !== '');
}

/**
 * 归一化已解析（模板已替换）的模型请求。
 * 没有相关字段返回 null；有字段但非法时抛错，绝不静默忽略。
 * options.thoughtLevels 传 null 表示不做静态档位白名单——session.send 走模型自己的
 * supportedEfforts，在运行时校验；缺省仍用固定的 low/medium/high。
 */
function normalizeAutomationModelRequest(detail, options = {}) {
  if (!hasAutomationModelRequest(detail)) return null;
  const thoughtLevels = options.thoughtLevels === undefined ? THOUGHT_LEVELS : options.thoughtLevels;
  const request = {};

  if (detail.model != null && detail.model !== '') {
    if (typeof detail.model !== 'string') throw new Error('model 必须是字符串');
    const key = detail.model.trim();
    if (!key) throw new Error('model 不能为空');
    if (key.length > MODEL_KEY_MAX_LENGTH) throw new Error('model 过长（最多 ' + MODEL_KEY_MAX_LENGTH + ' 字符）');
    request.model = key;
  }

  if (detail.thoughtLevel != null && detail.thoughtLevel !== '') {
    if (typeof detail.thoughtLevel !== 'string' || !detail.thoughtLevel.trim()) throw new Error('thoughtLevel 必须是非空字符串');
    const level = detail.thoughtLevel.trim();
    if (thoughtLevels && !thoughtLevels.includes(level)) throw new Error('thoughtLevel 只支持 ' + thoughtLevels.join('/'));
    request.thoughtLevel = level;
  }

  if (detail.isThinking != null && detail.isThinking !== '') {
    if (typeof detail.isThinking !== 'boolean') throw new Error('isThinking 必须是布尔值');
    request.isThinking = detail.isThinking;
  }

  if (detail.contextWindow != null && detail.contextWindow !== '') {
    const size = Number(detail.contextWindow);
    if (!Number.isInteger(size) || size < CONTEXT_WINDOW_MIN || size > CONTEXT_WINDOW_MAX) {
      throw new Error('contextWindow 必须是 ' + CONTEXT_WINDOW_MIN + '–' + CONTEXT_WINDOW_MAX + ' 之间的整数');
    }
    request.contextWindow = size;
  }

  if (!request.model) throw new Error('指定 thoughtLevel/isThinking/contextWindow 时必须同时指定 model');
  return request;
}

function formatModelCandidates(models, limit = 12) {
  return models.slice(0, limit).map((item) => item.key || item.id || item.name).filter(Boolean).join('、');
}

/**
 * 把任务里写的模型（键或显示名）解析成 WorkBuddy 认识的真实键。
 *   - 已带前缀的值原样使用（自定义模型大小写敏感，不做改写）；
 *   - 优先用权威键清单 knownModels 匹配 id 或显示名；
 *   - 再退回 models.json（此时必须补 custom-local: 前缀）；
 *   - 拿到过键清单却没命中 → 报错并列出候选，不静默忽略。
 */
function resolveAutomationModelKey(requested, options = {}) {
  const raw = String(requested == null ? '' : requested).trim();
  if (!raw) throw new Error('model 不能为空');
  if (raw.length > MODEL_KEY_MAX_LENGTH) throw new Error('model 过长（最多 ' + MODEL_KEY_MAX_LENGTH + ' 字符）');
  const knownModels = (Array.isArray(options.knownModels) ? options.knownModels : []).filter((m) => m && (m.key || m.id));
  const customModels = Array.isArray(options.customModels) ? options.customModels : [];
  const lower = raw.toLowerCase();

  if (raw.includes(':')) {
    const hit = knownModels.find((m) => String(m.key || m.id).toLowerCase() === lower);
    return { key: raw, custom: raw.startsWith(CUSTOM_MODEL_KEY_PREFIX), name: (hit && hit.name) || '' };
  }

  const known = knownModels.find((m) => String(m.key || m.id).toLowerCase() === lower)
    || knownModels.find((m) => m.name && String(m.name).toLowerCase() === lower);
  if (known) {
    const key = String(known.key || known.id);
    return { key, custom: key.startsWith(CUSTOM_MODEL_KEY_PREFIX), name: String(known.name || '') };
  }

  const custom = customModels.find((m) => String((m && m.id) || '').toLowerCase() === lower);
  if (custom) {
    const id = String(custom.id);
    return { key: CUSTOM_MODEL_KEY_PREFIX + id, custom: true, name: String(custom.name || '') };
  }

  if (knownModels.length) {
    throw new Error('未知模型 ' + raw + '；可用模型：' + formatModelCandidates(knownModels));
  }
  // 拿不到权威键清单（例如新建任务页没有会话控制器）→ 沿用裸键，交由写入后的回读校验兜底。
  return { key: raw, custom: false, name: '', unverified: true };
}

/** 安全解析偏好值里的 id（损坏或非对象一律返回空串）。 */
function readNewTaskModelId(raw) {
  if (typeof raw !== 'string' || !raw) return '';
  let parsed;
  try { parsed = JSON.parse(raw); } catch (_) { return ''; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '';
  return String(parsed.id == null ? '' : parsed.id).trim();
}

/**
 * 在用户原偏好上叠加本次请求，保留其余字段（isThinking / reasoningEffort / contextWindow）。
 * previousRaw 缺失、损坏或不是对象时以空对象为底，不阻塞任务。
 */
function buildNewTaskModelValue(previousRaw, resolved, request = {}) {
  if (!resolved || !resolved.key) throw new Error('缺少已解析的模型键');
  let base = {};
  if (typeof previousRaw === 'string' && previousRaw) {
    try {
      const parsed = JSON.parse(previousRaw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) base = parsed;
    } catch (_) { /* 损坏的原值不参与合并 */ }
  }
  const value = Object.assign({}, base, { id: resolved.key });
  if (request.thoughtLevel != null) value.reasoningEffort = request.thoughtLevel;
  if (request.isThinking != null) value.isThinking = request.isThinking;
  if (request.contextWindow != null) value.contextWindow = request.contextWindow;
  return { value, raw: JSON.stringify(value) };
}

/* ===== session.send：会话内切换模型 =====
 * 会话内换模型不能改 sessionStore（那只是运行时状态的镜像 setter，实测不生效），
 * 唯一路径是 composer 的模型下拉。下拉候选与它们的 React 处理器挂在渲染器的 fiber 上，
 * 所以 daemon 侧分两步：先读候选（据此解析模型键与思考档位），再点击选项并回读校验。
 * 本模块只做纯数据决策，CDP 交互在 scripts/daemon.js。
 */

/** session.send 允许的模型字段。contextWindow 不支持，见 normalizeSessionModelRequest。 */
const SESSION_MODEL_FIELDS = ['model', 'thoughtLevel', 'isThinking'];

/**
 * session.send 的模型请求归一化：复用 session.create 的字段校验，但拒绝 contextWindow。
 * 会话内切换只能改「用哪个模型」，上下文窗口由会话自身决定；静默忽略会让任务以为改了却没改。
 */
function normalizeSessionModelRequest(detail) {
  // 档位白名单交给运行时按目标模型的 supportedEfforts 判定（每个模型不同），
  // 静态期只校验形状，避免把 glm-5.3-flash 支持的 max 误判为非法。
  const request = normalizeAutomationModelRequest(detail, { thoughtLevels: null });
  if (!request) return null;
  if (request.contextWindow != null) throw new Error('session.send 不支持 contextWindow，需要设置上下文窗口请使用 session.create');
  return request;
}

/**
 * 把请求的思考档位对齐到目标模型真正支持的档位。
 * supportedEfforts 来自渲染器下拉，每个模型不同（例如 glm-5.3-flash 是 low/high/max）。
 * 清单为空时先放行并标记 unverified，由切换后的回读校验兜底。
 */
function pickEffortLevel(requested, supportedEfforts) {
  const raw = String(requested == null ? '' : requested).trim();
  if (!raw) return { ok: false, reason: 'empty', supported: [] };
  const list = (Array.isArray(supportedEfforts) ? supportedEfforts : []).map((value) => String(value)).filter(Boolean);
  if (!list.length) return { ok: true, effort: raw, supported: [], unverified: true };
  const hit = list.find((value) => value.toLowerCase() === raw.toLowerCase());
  if (hit) return { ok: true, effort: hit, supported: list };
  return { ok: false, reason: 'unsupported', supported: list };
}

/** 布尔开关（如 keepModel）解析：缺省/空串取默认值，其他非布尔一律报错，不静默取真。 */
function readBooleanFlag(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string' && ['true', 'false'].includes(value.trim().toLowerCase())) return value.trim().toLowerCase() === 'true';
  throw new Error('布尔字段只支持 true/false');
}

module.exports = {
  NEW_TASK_MODEL_KEY_PREFIX,
  CUSTOM_MODEL_KEY_PREFIX,
  THOUGHT_LEVELS,
  MODEL_KEY_MAX_LENGTH,
  CONTEXT_WINDOW_MIN,
  CONTEXT_WINDOW_MAX,
  AUTOMATION_MODEL_FIELDS,
  SESSION_MODEL_FIELDS,
  isTemplateValue,
  normalizeSessionModelRequest,
  pickEffortLevel,
  readBooleanFlag,
  newTaskModelStorageKey,
  hasAutomationModelRequest,
  normalizeAutomationModelRequest,
  resolveAutomationModelKey,
  readNewTaskModelId,
  buildNewTaskModelValue,
  formatModelCandidates,
};
