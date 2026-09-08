'use strict';
const TOAST_LEVELS = ['info', 'success', 'warning', 'error', 'loading'];
function normalizeToastOptions(input = {}, dismiss = false) {
  const result = {};
  if (input.id != null) {
    if (typeof input.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(input.id)) throw new Error('通知 id 格式无效');
    result.id = input.id;
  }
  if (dismiss && !result.id) throw new Error('关闭通知需要 id');
  if (!dismiss) {
    result.level = input.level == null ? 'info' : input.level;
    if (!TOAST_LEVELS.includes(result.level)) throw new Error('不支持的通知类型');
    if (input.duration != null) {
      if (!Number.isInteger(input.duration) || input.duration < 1000 || input.duration > 60000) throw new Error('通知 duration 必须是 1000–60000 毫秒的整数');
      result.duration = input.duration;
    }
  }
  return result;
}
module.exports = { normalizeToastOptions };

// Each run owns a namespace: identical task ids cannot update/dismiss another
// run's notifications or ordinary WorkDaddy UI notifications.
function createAutomationNotifier(send, namespace) {
  const active = new Map();
  let nextId = 0;
  let closed = false;
  const dismiss = async (id) => {
    const value = normalizeToastOptions({ id }, true);
    await send({ action: 'dismiss', id: namespace + ':' + value.id });
    active.delete(value.id);
    return { ok: true, id: value.id };
  };
  const show = async (level, message, options = {}) => {
    if (closed) throw new Error('通知所属任务已结束');
    const value = normalizeToastOptions({ ...options, level });
    const id = value.id || 'notice-' + (++nextId);
    await send({ ...value, message: String(message || '').slice(0, 2000), id: namespace + ':' + id });
    active.set(id, value.level);
    if (closed) await dismiss(id);
    return { ok: true, id };
  };
  const cleanup = async () => {
    closed = true;
    await Promise.allSettled([...active].filter(([, level]) => level === 'loading').map(([id]) => dismiss(id)));
    active.clear();
  };
  return { show, dismiss, cleanup };
}
module.exports.createAutomationNotifier = createAutomationNotifier;
