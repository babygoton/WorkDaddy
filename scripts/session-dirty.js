'use strict';

const VERSION = 1;

function createDirtyIndex(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const state = { version: VERSION, accounts: {} };
  const accounts = source.accounts && typeof source.accounts === 'object' && !Array.isArray(source.accounts)
    ? source.accounts : {};
  for (const [uid, value] of Object.entries(accounts)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const sessions = value.sessions && typeof value.sessions === 'object' && !Array.isArray(value.sessions)
      ? value.sessions : {};
    state.accounts[String(uid)] = {
      initialized: value.initialized === true,
      sessions: {},
    };
    for (const [id, marker] of Object.entries(sessions)) {
      if (!marker || typeof marker !== 'object') continue;
      const at = Number(marker.at);
      if (!Number.isFinite(at) || at <= 0) continue;
      state.accounts[String(uid)].sessions[String(id)] = {
        at,
        event: String(marker.event || 'sessionUpdated').slice(0, 40),
      };
    }
  }

  function account(uid, create) {
    const key = String(uid || '').trim();
    if (!key) return null;
    if (!state.accounts[key] && create) state.accounts[key] = { initialized: false, sessions: {} };
    return state.accounts[key] || null;
  }

  return {
    state,
    isInitialized(uid) {
      const item = account(uid, false);
      return !!(item && item.initialized);
    },
    markBaseline(uid) {
      const item = account(uid, true);
      if (!item) return false;
      const changed = item.initialized !== true;
      item.initialized = true;
      return changed;
    },
    mark(uid, sessionId, event, at = Date.now()) {
      const item = account(uid, true);
      const id = String(sessionId || '').trim();
      const timestamp = Number(at);
      if (!item || !id || !Number.isFinite(timestamp) || timestamp <= 0) return null;
      const previous = item.sessions[id];
      const marker = { at: timestamp, event: String(event || 'sessionUpdated').slice(0, 40) };
      item.sessions[id] = marker;
      return previous && previous.at === marker.at ? previous : marker;
    },
    get(uid, sessionId) {
      const item = account(uid, false);
      return item && item.sessions[String(sessionId || '').trim()] || null;
    },
    shouldSync(uid, sessionId) {
      const item = account(uid, false);
      if (!item || item.initialized !== true) return true;
      return !!item.sessions[String(sessionId || '').trim()];
    },
    clear(uid, sessionId, expectedAt) {
      const item = account(uid, false);
      const id = String(sessionId || '').trim();
      if (!item || !id || !item.sessions[id]) return false;
      if (expectedAt !== undefined && Number(item.sessions[id].at) !== Number(expectedAt)) return false;
      delete item.sessions[id];
      return true;
    },
    prune(uid, validIds) {
      const item = account(uid, false);
      if (!item || !validIds || typeof validIds.has !== 'function') return false;
      let changed = false;
      for (const id of Object.keys(item.sessions)) {
        if (!validIds.has(id)) { delete item.sessions[id]; changed = true; }
      }
      return changed;
    },
  };
}

module.exports = { VERSION, createDirtyIndex };
