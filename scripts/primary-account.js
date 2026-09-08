'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Profile-local preference, separate from the account backup format.
function createPrimaryAccountStore(dataDir, accountExists) {
  const file = path.join(dataDir, 'primary-account.json');
  function set(uid) {
    if (typeof uid !== 'string' || (uid && !/^[A-Za-z0-9_-]{1,128}$/.test(uid))) throw new Error('账号 uid 无效');
    if (uid && !accountExists(uid)) throw new Error('账号备份不存在');
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ uid }) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
    return uid;
  }
  function get() {
    let uid;
    try { uid = JSON.parse(fs.readFileSync(file, 'utf8')).uid; } catch (_) { return ''; }
    if (typeof uid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(uid)) return '';
    if (!accountExists(uid)) { set(''); return ''; }
    return uid;
  }
  return { get, set };
}
module.exports = { createPrimaryAccountStore };
