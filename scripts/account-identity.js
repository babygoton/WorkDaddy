'use strict';
const crypto = require('crypto');

// WorkDaddy ids identify a login context; official auth/session uids stay intact.
function accountIdentity(account = {}) {
  const rawUid = String(account.rawUid || account.uid || '').trim();
  const type = String(account.type || '').trim();
  const enterpriseId = String(account.enterpriseId || '').trim();
  if (!enterpriseId && !['ultimate', 'exclusive'].includes(type)) return rawUid;
  // Edition upgrades within the same enterprise must not create another account.
  const scope = enterpriseId ? ['enterprise', enterpriseId] : ['edition', type];
  return 'wdent_' + crypto.createHash('sha256').update(JSON.stringify([rawUid, scope])).digest('hex');
}

const AMBIGUOUS_SESSION_ACCOUNT = '个人版与企业版共用官方会话 UID，无法可靠区分会话归属，已停止同步；账号备份和切换仍可使用';
function createSessionAccountResolver(accounts) {
  const byId = new Map(), byUid = new Map();
  for (const account of accounts) {
    const id = String(account.uid || '');
    const rawUid = String(account.rawUid || id);
    byId.set(id, rawUid);
    if (!byUid.has(rawUid)) byUid.set(rawUid, new Set());
    byUid.get(rawUid).add(id);
  }
  function raw(uid) { return byId.get(String(uid)) || String(uid); }
  function assertUnambiguous(uid) {
    if ((byUid.get(raw(uid)) || new Set()).size > 1) {
      const error = new Error(AMBIGUOUS_SESSION_ACCOUNT);
      error.code = 'WBS_AMBIGUOUS_SESSION_ACCOUNT';
      throw error;
    }
    return raw(uid);
  }
  function identity(uid) {
    const ids = byUid.get(String(uid));
    if (ids && ids.size > 1) return String(uid); // Ownership is unknown; never guess an enterprise.
    return ids && ids.size === 1 ? ids.values().next().value : String(uid);
  }
  return { raw, identity, assertUnambiguous };
}
module.exports = { accountIdentity, createSessionAccountResolver, AMBIGUOUS_SESSION_ACCOUNT };
