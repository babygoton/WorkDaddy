'use strict';

// Runs in the renderer through CDP. Read the official, account-scoped list rather
// than the virtualized sidebar or visible stop button. This does not load/switch
// sessions or mutate their state. The list requires userId (5.5 desktop adapter).
async function probeAccountCompletion(userId) {
  const compat = window.__wbsWorkBuddyCompat;
  const found = compat && compat.findQueueAdapter(document);
  const adapter = found && found.adapter;
  const resource = adapter && adapter.sessionsResource;
  if (!userId || !resource || typeof resource.list !== 'function') return { known: false };
  const result = await resource.list({ userId });
  if (!result || !Array.isArray(result.agents) || !result.agents.length || result.pagination && (result.pagination.hasNext || Number(result.pagination.total) > result.agents.length)) return { known: false };
  const sessions = result.agents.map(record => ({ id: String(record.id || ''), status: String(record.status || '').toLowerCase(), busy: false }));
  // Inspect mounted controllers too: list status can lag behind a just-started
  // turn. Return only lifecycle flags; message contents never cross CDP here.
  const controllers = compat.findConversationControllers(document) || [];
  for (const controller of controllers) {
    const id = String(controller.conversationId || '');
    let record = sessions.find(item => item.id === id);
    if (!record) { record = { id, status: '', busy: false }; sessions.push(record); }
    try {
      const state = controller.getSessionViewState();
      const messages = controller.messageStore.getState();
      record.busy = !!(state.isBusy || state.isRunActive || state.isTurnActive || state.isSending || state.isPending || state.isHydrating || messages.streamingRequestId || messages.streamingMessageId);
    } catch (_) { return { known: false }; }
  }
  // Queue snapshots are optional for sessions with no persisted queue. A queued
  // item, even paused, prevents claiming that every task has completed.
  if (typeof resource.getConversationMessageQueue === 'function') {
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(4, sessions.length) }, async () => {
      while (cursor < sessions.length) {
        const record = sessions[cursor++];
        const queue = await resource.getConversationMessageQueue(record.id);
        if (queue && (Array.isArray(queue.items) && queue.items.length || queue.inflightItemId || queue.runtime && (queue.runtime.inflightItemId || queue.runtime.pendingItemCount || queue.runtime.sendingItemCount))) record.busy = true;
      }
    }));
  }
  return { known: sessions.every(record => !!record.id && !!record.status), sessions };
}

async function runCompletionReport(options) {
  const source = options.currentAccount();
  const primary = options.primaryUid();
  if (!primary) return { ok: true, skipped: true, reason: '未设置主账号' };
  if (!source || !source.uid) throw new Error('当前没有登录账号');
  if (primary === source.uid) return { ok: true, skipped: true, reason: '当前账号就是主账号' };
  const now = options.now || Date.now;
  const wait = options.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const started = now();
  const timeout = Math.min(86400000, Math.max(1000, Number(options.timeoutMs) || 86400000));
  const observed = new Set();
  let idleSince = null;
  const check = () => {
    if (options.isCancelled && options.isCancelled()) throw new Error('用户停止任务');
    if (options.primaryUid() !== primary || (options.currentAccount() || {}).uid !== source.uid) throw new Error('账号已变化，本次完成汇报已终止');
  };
  const done = new Set(['completed', 'done']);
  const ended = new Set([...done, 'terminated', 'cancelled', 'canceled', 'failed', 'error', 'archived', 'deleted', 'killed']);
  if (options.log) options.log('等待当前账号的全部 WorkBuddy 会话完成（待确认和队列未清空时继续等待）');
  while (now() - started < timeout) {
    check();
    const snapshot = await options.snapshot(source.uid);
    check();
    if (!snapshot || !snapshot.known || !Array.isArray(snapshot.sessions) || !snapshot.sessions.length) throw new Error('无法确认全部会话状态，未发送汇报');
    let busy = false;
    const present = new Set();
    for (const record of snapshot.sessions) {
      present.add(record.id);
      if (observed.has(record.id) && ended.has(record.status) && !done.has(record.status)) throw new Error('监听中的会话被停止或失败，未发送完成汇报');
      if (record.busy || !ended.has(record.status)) { busy = true; observed.add(record.id); }
    }
    if ([...observed].some(id => !present.has(id))) throw new Error('监听中的会话状态丢失，未发送汇报');
    if (busy) idleSince = null;
    else if (idleSince === null) idleSince = now();
    else if (now() - idleSince >= 2000) {
      check();
      const timestamp = new Date(now()).toLocaleString('zh-CN', { hour12: false });
      const name = String(source.nickname || source.uid).replace(/[\r\n\t]/g, ' ').slice(0, 120);
      const delivery = await options.send(primary, `${name} 账号于 ${timestamp} 完成所有任务`);
      return { ok: true, conversationId: delivery.conversationId };
    }
    await wait(1000);
  }
  throw new Error('等待全部会话完成超时，未发送汇报');
}
module.exports = { runCompletionReport, probeAccountCompletion };
