'use strict';

const GROWTH_ACTIVE_TIMEOUT_MS = 12000;
const GROWTH_SESSION_TIMEOUT_MS = 30000;
const DEFAULT_GROWTH_PROMPT = '你好';
const DEFAULT_GROWTH_MODEL = 'deepseek-r1';

function responseData(payload) {
  if (payload && typeof payload === 'object' && payload.data && typeof payload.data === 'object') {
    return payload.data;
  }
  return payload;
}

async function readJsonResponse(response, label) {
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (_) {
    throw new Error(`${label}接口返回了无法解析的数据`);
  }
  if (!response.ok) {
    const message = payload && (payload.msg || payload.message || payload.error);
    throw new Error(`${label}接口 HTTP ${response.status}${message ? `: ${message}` : ''}`);
  }
  if (payload && payload.code !== undefined && payload.code !== null && payload.code !== 0) {
    throw new Error(payload.msg || payload.message || `${label}接口 code=${payload.code}`);
  }
  return responseData(payload);
}

function requestHeaders(apiHost, accessToken, extra = {}) {
  return Object.assign({
    accept: 'application/json, text/plain, */*',
    'content-type': 'application/json',
    'x-codebuddy-request': '1',
    'x-client-platform': 'web',
    origin: apiHost,
    referer: `${apiHost}/`,
    authorization: `Bearer ${accessToken}`,
  }, extra);
}

function resolveAcpEndpoint(link) {
  const value = String(link || '').trim().replace(/^http:\/\//, 'https://').replace(/\/+$/, '');
  if (!value) return '';
  try {
    const url = new URL(value);
    if (!/\/api\/v1\/acp$/.test(url.pathname) && !/\/acp$/.test(url.pathname)) {
      url.pathname = `${url.pathname.replace(/\/+$/, '')}/api/v1/acp`;
    }
    return url.toString().replace(/\/+$/, '');
  } catch (_) {
    return value;
  }
}

function timeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { controller, timer };
}

function sseEventParser(onMessage) {
  let buffer = '';
  let event = {};
  return (chunk, flush = false) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    const remainder = lines.pop() || '';
    buffer = flush ? '' : remainder;
    if (flush && remainder) lines.push(remainder);
    for (const line of lines) {
      if (!line) {
        if (event.data) {
          try { onMessage(JSON.parse(event.data)); } catch (_) {}
        }
        event = {};
        continue;
      }
      if (line.startsWith(':')) continue;
      const separator = line.indexOf(':');
      const field = separator >= 0 ? line.slice(0, separator) : line;
      const value = separator >= 0 ? line.slice(separator + 1).replace(/^ /, '') : '';
      if (field === 'data') event.data = event.data ? `${event.data}\n${value}` : value;
    }
  };
}

/**
 * 通过指定备份账号的 token 发起一次独立 cloud conversation。
 * 该流程只使用云端 conversation/ACP 凭证，不写当前 auth 文件，也不触碰 renderer。
 */
async function activateGrowthAccount(accessToken, options = {}) {
  const apiHost = String(options.apiHost || 'https://www.workbuddy.cn').replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : GROWTH_SESSION_TIMEOUT_MS;
  if (!accessToken || typeof fetchImpl !== 'function') throw new Error('成长活跃发起参数不完整');

  const prompt = typeof options.prompt === 'string' && options.prompt.trim()
    ? options.prompt.trim().slice(0, 100)
    : DEFAULT_GROWTH_PROMPT;
  const model = typeof options.model === 'string' && options.model.trim()
    ? options.model.trim()
    : DEFAULT_GROWTH_MODEL;
  const signalState = timeoutSignal(timeoutMs);
  let connectionId = '';
  let endpoint = '';
  let sseController;
  let sseTask;
  const pending = new Map();
  let nextRpcId = 1;
  const deliverRpc = (payload) => {
    const entry = pending.get(payload && payload.id);
    if (!entry) return;
    pending.delete(payload.id);
    clearTimeout(entry.timer);
    if (payload.error) entry.reject(new Error(payload.error.message || 'ACP 请求失败'));
    else entry.resolve(payload.result);
  };

  const requestJson = async (url, init = {}) => {
    try {
      const response = await fetchImpl(url, Object.assign({ signal: signalState.controller.signal }, init));
      return await readJsonResponse(response, '会话');
    } catch (error) {
      if (error && error.name === 'AbortError') throw new Error('成长会话请求超时');
      throw error;
    }
  };

  const sendRpc = async (endpoint, message) => {
    if (!connectionId) throw new Error('ACP 连接未建立');
    const responsePromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(message.id);
        reject(new Error(`ACP ${message.method} 响应超时`));
      }, timeoutMs);
      pending.set(message.id, { resolve, reject, timer });
    });
    // A transport error may happen before the caller reaches the await below.
    // Attach a sink so the timeout/rejection cannot become an unhandled rejection.
    responsePromise.catch(() => {});
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: requestHeaders(apiHost, runtimeToken, {
        accept: 'application/json, text/event-stream',
        'acp-connection-id': connectionId,
      }),
      body: JSON.stringify(message),
      signal: signalState.controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`ACP 请求 HTTP ${response.status}${body ? `: ${body.slice(0, 160)}` : ''}`);
    }
    const contentType = String(response.headers.get('content-type') || '');
    if (contentType.includes('application/json')) {
      const payload = await response.json().catch(() => null);
      if (payload && payload.jsonrpc) deliverRpc(payload);
    } else if (contentType.includes('text/event-stream') && response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parse = sseEventParser((payload) => {
        deliverRpc(payload);
      });
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          parse(decoder.decode(part.value, { stream: true }));
        }
        parse(decoder.decode(), true);
      } finally {
        reader.releaseLock();
      }
    }
    return await responsePromise;
  };

  let runtimeToken = '';
  let conversationId = '';
  try {
    const created = await requestJson(`${apiHost}/console/as/conversations/`, {
      method: 'POST',
      headers: requestHeaders(apiHost, accessToken),
      body: JSON.stringify({
        prompt,
        model,
        plugins: [{ name: 'weixinpay', marketplace: 'codebuddy-builtin' }],
      }),
    });
    const createdSession = created && created.session && typeof created.session === 'object' ? created.session : null;
    conversationId = String((created && (created.id || created.conversationId || (created.info && created.info.id))) || '');
    if (!conversationId) throw new Error('创建会话响应缺少 conversation id');
    let session = createdSession;
    if (!session || !session.link || !session.token) {
      session = await requestJson(`${apiHost}/console/as/conversations/${encodeURIComponent(conversationId)}/session`, {
        method: 'GET',
        headers: requestHeaders(apiHost, accessToken),
      });
    }
    endpoint = resolveAcpEndpoint(session && (session.link || session.endpoint));
    runtimeToken = String(session && (session.token || session.accessToken) || '');
    const sessionId = String(session && (session.sessionId || session.session_id) || '');
    if (!endpoint || !runtimeToken || !sessionId) throw new Error('会话响应缺少 ACP 连接凭证');

    sseController = new AbortController();
    signalState.controller.signal.addEventListener('abort', () => sseController.abort(), { once: true });
    const connectResponse = await fetchImpl(endpoint, {
      method: 'GET',
      headers: requestHeaders(apiHost, runtimeToken, { accept: 'text/event-stream' }),
      signal: sseController.signal,
    });
    if (!connectResponse.ok) throw new Error(`ACP 连接 HTTP ${connectResponse.status}`);
    connectionId = String(connectResponse.headers.get('acp-connection-id') || '');
    if (!connectionId) throw new Error('ACP 连接响应缺少 connection id');
    if (connectResponse.body) {
      const reader = connectResponse.body.getReader();
      sseTask = (async () => {
        const decoder = new TextDecoder();
        const parse = sseEventParser((payload) => {
          deliverRpc(payload);
        });
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            parse(decoder.decode(part.value, { stream: true }));
          }
          parse(decoder.decode(), true);
        } catch (_) {
          // The one-shot activation only needs the RPC response; stream closure is expected afterwards.
        } finally {
          reader.releaseLock();
        }
      })();
    }
    await sendRpc(endpoint, { jsonrpc: '2.0', id: nextRpcId++, method: 'initialize', params: {
      protocolVersion: 1,
      clientInfo: { name: 'workdaddy-growth', version: '1.1.31' },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        _meta: { 'codebuddy.ai': { question: false, terminalOutput: false } },
      },
    } });
    const result = await sendRpc(endpoint, { jsonrpc: '2.0', id: nextRpcId++, method: 'session/prompt', params: {
      sessionId,
      prompt: [{ type: 'text', text: prompt }],
    } });
    return { conversationId, sessionId, stopReason: result && result.stopReason ? result.stopReason : null };
  } finally {
    clearTimeout(signalState.timer);
    if (sseController) sseController.abort();
    if (sseTask) await sseTask.catch(() => {});
    if (connectionId && runtimeToken) {
      await fetchImpl(endpoint, {
        method: 'DELETE',
        headers: requestHeaders(apiHost, runtimeToken, { 'acp-connection-id': connectionId }),
      }).catch(() => {});
    }
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.reject(new Error('ACP 连接已关闭'));
    }
  }
}

/**
 * 查询指定账号今日是否活跃（WorkBuddy 成长中心活跃地图）。
 * 复用签到/积分的 Bearer 鉴权与 profile 归属域名（国内 www.workbuddy.cn / 国际 www.workbuddy.ai）。
 * 返回 { is_active, date, score, status_text }；失败抛 Error。
 */
async function fetchGrowthTodayActive(accessToken, options = {}) {
  const apiHost = String(options.apiHost || 'https://www.workbuddy.cn').replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : GROWTH_ACTIVE_TIMEOUT_MS;
  if (!accessToken || typeof fetchImpl !== 'function') {
    throw new Error('成长活跃查询参数不完整');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${apiHost}/activity/growth/heatmap`, {
      method: 'GET',
      headers: {
        accept: 'application/json, text/plain, */*',
        'x-client-platform': 'web',
        origin: apiHost,
        referer: `${apiHost}/profile/growth-center`,
        authorization: `Bearer ${accessToken}`,
      },
      signal: controller.signal,
    });
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (_) {
      throw new Error('成长活跃接口返回了无法解析的数据');
    }
    if (!response.ok) throw new Error(`成长活跃接口 HTTP ${response.status}`);
    if (payload.code !== 0 && payload.code !== undefined && payload.code !== null) {
      throw new Error(payload.msg || `成长活跃接口 code=${payload.code}`);
    }
    const today = payload.data && typeof payload.data === 'object' ? payload.data.today : null;
    if (!today || typeof today !== 'object') throw new Error('成长活跃接口缺少 data.today');
    return {
      is_active: today.is_active === true,
      date: typeof today.date === 'string' ? today.date : null,
      score: Number.isFinite(Number(today.score)) ? Number(today.score) : null,
      status_text: typeof today.status_text === 'string' ? today.status_text : '',
    };
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('成长活跃接口请求超时');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchGrowthTodayActive, activateGrowthAccount };
