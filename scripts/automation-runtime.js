'use strict';

// No credential is read until this policy has accepted the final request URL.
function assertAccountRequestUrl(url, apiHost) {
  const base = new URL(apiHost);
  const allowed = new Set([base.origin]);
  if (base.hostname === 'www.codebuddy.cn') {
    allowed.add('https://www.workbuddy.cn');
    allowed.add('https://workbuddy.cn');
    allowed.add('https://codebuddy.cn');
  }
  if (url.protocol !== 'https:' || url.username || url.password || !allowed.has(url.origin)) {
    throw new Error('账号请求仅允许当前客户端的官方 HTTPS 接口');
  }
}
function createTaskState(taskId, read, write) {
  const keyFor = (scope, uid, key) => {
    if (!['task','account'].includes(scope) || !String(key || '').trim()) throw new Error('状态 scope 或 key 无效');
    if (scope === 'account' && !uid) throw new Error('账号状态需要账号上下文');
    return JSON.stringify(['v2', taskId, scope, scope === 'account' ? String(uid) : '', key]);
  };
  return {
    get: async (scope,uid,key) => read()[keyFor(scope,uid,key)],
    set: async (scope,uid,key,value) => {
      // Each synchronous read/merge/write sees other runs' latest changes.
      const state = read(); state[keyFor(scope,uid,key)] = value; write(state);
    },
  };
}
async function cancellableWait(ms, isCancelled = () => false) {
  const end = Date.now() + ms;
  do {
    if (isCancelled()) throw new Error('任务已停止');
    await new Promise(resolve => setTimeout(resolve, Math.min(100,Math.max(0,end-Date.now()))));
  } while (Date.now() < end);
  if (isCancelled()) throw new Error('任务已停止');
}
function createRendererGate() {
  let busy = false;
  const queue = [];
  return async isCancelled => {
    const ticket = {}; queue.push(ticket);
    try {
      while (busy || queue[0] !== ticket) await cancellableWait(50,isCancelled);
      if (isCancelled()) throw new Error('任务已停止');
      queue.shift(); busy = true;
      let released = false;
      return () => { if (!released) { released = true; busy = false; } };
    } catch (error) { const index = queue.indexOf(ticket); if (index >= 0) queue.splice(index,1); throw error; }
  };
}

// Executed read-only inside the renderer. Never returns composer or message text.
function probeSessionReceipt() {
  const compat = window.__wbsWorkBuddyCompat;
  if (!compat) return null;
  const selected = compat.getSelectedConversationId(document);
  const controller = (compat.findConversationControllers(document) || []).find(c => String(c.conversationId) === String(selected));
  if (!controller) return null;
  try {
    const state = controller.messageStore.getState();
    const session = controller.getSessionViewState();
    const messages = Array.isArray(state.messages) ? state.messages : [];
    const users = messages.filter(m => (m.messageType || m.role) === 'user');
    const user = users[users.length-1];
    const last = [...messages].reverse().find(m => (m.messageType || m.role) === 'assistant' && !/^timeline:/.test(String(m.id || '')));
    const error = typeof controller.getErrorViewState === 'function' ? controller.getErrorViewState() : {};
    const extra = last && last.extra || {};
    return {
      conversationId:String(selected || ''),
      userMessageId:String(user && (user.id || user.requestId) || ''),
      requestId:String(state.streamingRequestId || user && user.requestId || ''),
      assistantId:String(last && (last.id || last.requestId) || ''),
      assistantRequestId:String(last && last.requestId || ''),
      complete:!!(last && (Object.prototype.hasOwnProperty.call(extra,'isRequestTerminal') ? extra.isRequestTerminal === true : last.complete === true)),
      cancelled:extra.isCancelled === true,
      error:!!(error && (error.error || error.hasError)),
      busy:!!(state.streamingRequestId || state.streamingMessageId || session && (session.isBusy || session.isRunActive || session.isTurnActive || session.isSending || session.isPending || session.isHydrating)),
    };
  } catch (_) { return null; }
}
function receiptComplete(receipt, snapshot) {
  if (!snapshot || snapshot.conversationId !== receipt.conversationId) throw new Error('目标会话不再可见，已停止等待');
  if (snapshot.userMessageId !== receipt.userMessageId) throw new Error('会话已有其他请求，已停止等待');
  if (snapshot.error || snapshot.cancelled) throw new Error('会话回复失败或已取消');
  if (receipt.requestId && snapshot.assistantRequestId && snapshot.assistantRequestId !== receipt.requestId) return false;
  return !!snapshot.assistantId && snapshot.assistantId !== receipt.baselineAssistantId && snapshot.complete && !snapshot.busy;
}
module.exports = {assertAccountRequestUrl,createTaskState,cancellableWait,createRendererGate,probeSessionReceipt,receiptComplete};
