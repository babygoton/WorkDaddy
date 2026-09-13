'use strict';

const fs = require('fs');
const path = require('path');
const { createSessionDb } = require('./session-db.js');

const INSERT_USAGE_SQL = `
  INSERT INTO credit_usage_records
    (profile_id, uid, request_id, request_time, usage_date, credit, model, client, agent_purpose)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(profile_id, uid, request_id) DO UPDATE SET
    request_time = excluded.request_time,
    usage_date = excluded.usage_date,
    credit = excluded.credit,
    model = excluded.model,
    client = excluded.client,
    agent_purpose = excluded.agent_purpose
`;

function validIdentity(value, label) {
  const text = String(value || '').trim();
  if (!text || text.length > 512 || text.includes('\0')) throw new Error(`${label} 无效`);
  return text;
}

function localDayRange(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  if (!match) throw new Error('用量日期无效');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const start = new Date(year, month - 1, day, 0, 0, 0, 0);
  if (start.getFullYear() !== year || start.getMonth() !== month - 1 || start.getDate() !== day) {
    throw new Error('用量日期无效');
  }
  const end = new Date(year, month - 1, day + 1, 0, 0, 0, 0);
  return { start: start.getTime(), end: end.getTime() };
}

function validDate(value) {
  const text = String(value || '');
  localDayRange(text);
  return text;
}

function createCreditUsageStore(options = {}) {
  const dbPath = path.resolve(String(options.dbPath || ''));
  const profileId = validIdentity(options.profileId, 'profile id');
  const db = options.adapter || createSessionDb({ dbPath });
  let initPromise = null;

  function initialize() {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
      await db.run(`
        CREATE TABLE IF NOT EXISTS credit_usage_records (
          profile_id TEXT NOT NULL,
          uid TEXT NOT NULL,
          request_id TEXT NOT NULL,
          request_time INTEGER NOT NULL,
          usage_date TEXT NOT NULL,
          credit REAL NOT NULL,
          model TEXT NOT NULL DEFAULT '',
          client TEXT NOT NULL DEFAULT '',
          agent_purpose TEXT NOT NULL DEFAULT '',
          PRIMARY KEY (profile_id, uid, request_id)
        )
      `);
      await db.run(`
        CREATE INDEX IF NOT EXISTS idx_credit_usage_uid_date
        ON credit_usage_records (profile_id, uid, usage_date, request_time)
      `);
      await db.run(`
        CREATE TABLE IF NOT EXISTS credit_usage_sync_state (
          profile_id TEXT NOT NULL,
          uid TEXT NOT NULL,
          anchor_request_id TEXT,
          last_success_at INTEGER NOT NULL,
          PRIMARY KEY (profile_id, uid)
        )
      `);
      await db.run(`
        CREATE TABLE IF NOT EXISTS credit_history_days (
          profile_id TEXT NOT NULL, uid TEXT NOT NULL, usage_date TEXT NOT NULL,
          synced_at INTEGER NOT NULL, PRIMARY KEY (profile_id, uid, usage_date)
        )
      `);
      await db.run(`
        CREATE TABLE IF NOT EXISTS daily_checkin_records (
          profile_id TEXT NOT NULL,
          uid TEXT NOT NULL,
          checkin_date TEXT NOT NULL,
          checked_at INTEGER NOT NULL,
          response_code INTEGER,
          message TEXT NOT NULL DEFAULT '',
          PRIMARY KEY (profile_id, uid, checkin_date)
        )
      `);
      await db.run(`
        CREATE INDEX IF NOT EXISTS idx_daily_checkin_uid_date
        ON daily_checkin_records (profile_id, uid, checkin_date)
      `);
      try { fs.chmodSync(dbPath, 0o600); } catch (_) {}
    })().catch((error) => {
      initPromise = null;
      throw error;
    });
    return initPromise;
  }

  async function getSyncState(uid) {
    await initialize();
    const accountUid = validIdentity(uid, 'uid');
    const rows = await db.all(
      `SELECT anchor_request_id, last_success_at
       FROM credit_usage_sync_state
       WHERE profile_id = ? AND uid = ?
       LIMIT 1`,
      [profileId, accountUid]
    );
    if (!rows.length) return null;
    return {
      anchorRequestId: rows[0].anchor_request_id || '',
      lastSuccessAt: Number(rows[0].last_success_at),
    };
  }

  async function saveRecords(accountUid, records) {
    const list = Array.isArray(records) ? records : [];
    for (let offset = 0; offset < list.length; offset += 200) {
      const statements = list.slice(offset, offset + 200).map((record) => ({
        sql: INSERT_USAGE_SQL,
        params: [
          profileId,
          accountUid,
          validIdentity(record.requestId, 'request id'),
          Number(record.requestTime),
          String(record.usageDate || ''),
          Number(record.credit),
          String(record.model || ''),
          String(record.client || ''),
          String(record.agentPurpose || ''),
        ],
      }));
      if (statements.length) await db.transaction(statements);
    }
  }

  async function saveHistoryUsage({ uid, records, from, to, syncedAt }) {
    await initialize();
    const accountUid = validIdentity(uid, 'uid');
    const start = localDayRange(validDate(from)).start;
    const end = localDayRange(validDate(to)).start;
    if (start > end || end - start > 90 * 86400000) throw new Error('用量日期范围无效');
    if (!Number.isSafeInteger(syncedAt) || syncedAt < 0) throw new Error('同步时间无效');
    await saveRecords(accountUid, records);
    const days = [];
    for (const date = new Date(start); date.getTime() <= end; date.setDate(date.getDate() + 1)) {
      const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      days.push({ sql: `INSERT INTO credit_history_days (profile_id, uid, usage_date, synced_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(profile_id, uid, usage_date) DO UPDATE SET synced_at = excluded.synced_at`,
        params: [profileId, accountUid, day, syncedAt] });
    }
    await db.transaction(days);
    try { fs.chmodSync(dbPath, 0o600); } catch (_) {}
  }

  async function saveSuccessfulSync({ uid, records, anchorRequestId, syncedAt }) {
    await initialize();
    const accountUid = validIdentity(uid, 'uid');
    const timestamp = Number(syncedAt);
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('同步时间无效');
    await saveRecords(accountUid, records);
    await db.run(
      `INSERT INTO credit_usage_sync_state
         (profile_id, uid, anchor_request_id, last_success_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(profile_id, uid) DO UPDATE SET
         anchor_request_id = excluded.anchor_request_id,
         last_success_at = excluded.last_success_at`,
      [profileId, accountUid, anchorRequestId ? validIdentity(anchorRequestId, 'anchor request id') : null, timestamp]
    );
    try { fs.chmodSync(dbPath, 0o600); } catch (_) {}
  }

  async function listDailyUsage(uids, date) {
    await initialize();
    const accountUids = Array.from(new Set((Array.isArray(uids) ? uids : []).map((uid) => validIdentity(uid, 'uid'))));
    if (!accountUids.length) return {};
    const usageDate = String(date || '');
    const dayRange = localDayRange(usageDate);
    const placeholders = accountUids.map(() => '?').join(',');
    const rows = await db.all(
      `SELECT uid, ROUND(SUM(credit), 2) AS used, COUNT(*) AS count
       FROM credit_usage_records
       WHERE profile_id = ? AND usage_date = ? AND uid IN (${placeholders})
       GROUP BY uid`,
      [profileId, usageDate, ...accountUids]
    );
    const result = {};
    for (const row of rows) {
      const count = Number(row.count);
      const used = Number(row.used);
      if (!accountUids.includes(row.uid) || !Number.isFinite(used) || !Number.isSafeInteger(count) || count <= 0) continue;
      result[row.uid] = { date: usageDate, used, count, synced: true };
    }
    const syncedRows = await db.all(
      `SELECT uid
       FROM credit_usage_sync_state
       WHERE profile_id = ? AND uid IN (${placeholders})
         AND last_success_at >= ? AND last_success_at < ?`,
      [profileId, ...accountUids, dayRange.start, dayRange.end]
    );
    for (const row of syncedRows) {
      if (!accountUids.includes(row.uid) || result[row.uid]) continue;
      result[row.uid] = { date: usageDate, used: 0, count: 0, synced: true };
    }
    return result;
  }

  async function dailyUsageForUid(uid, date) {
    const accountUid = validIdentity(uid, 'uid');
    const summaries = await listDailyUsage([accountUid], date);
    return summaries[accountUid] || null;
  }

  async function listDailyUsageRange(uids, fromDate, toDate) {
    await initialize();
    const accountUids = Array.from(new Set((Array.isArray(uids) ? uids : []).map((uid) => validIdentity(uid, 'uid'))));
    if (!accountUids.length) return [];
    const from = validDate(fromDate);
    const to = validDate(toDate);
    if (from > to) throw new Error('用量日期范围无效');
    const placeholders = accountUids.map(() => '?').join(',');
    const rows = await db.all(
      `SELECT uid, usage_date AS date, ROUND(SUM(credit), 2) AS used, COUNT(*) AS count
       FROM credit_usage_records
       WHERE profile_id = ? AND usage_date >= ? AND usage_date <= ? AND uid IN (${placeholders})
       GROUP BY uid, usage_date ORDER BY usage_date ASC, uid ASC`,
      [profileId, from, to, ...accountUids]
    );
    const result = new Map(rows.map(row => [row.uid + ':' + row.date,
      { uid: String(row.uid), date: String(row.date), used: Number(row.used) || 0, count: Number(row.count) || 0, cached: true, complete: false }]));
    const coverage = await db.all(`SELECT uid, usage_date, synced_at FROM credit_history_days
      WHERE profile_id = ? AND usage_date >= ? AND usage_date <= ? AND uid IN (${placeholders})`,
      [profileId, from, to, ...accountUids]);
    for (const row of coverage) {
      const key = row.uid + ':' + row.usage_date;
      const item = result.get(key) || { uid: row.uid, date: row.usage_date, used: 0, count: 0, cached: true };
      item.complete = true; item.syncedAt = Number(row.synced_at);
      result.set(key, item);
    }
    return Array.from(result.values()).sort((a, b) => a.date.localeCompare(b.date) || a.uid.localeCompare(b.uid));
  }

  async function getDailyCheckin(uid, date) {
    await initialize();
    const accountUid = validIdentity(uid, 'uid');
    const checkinDate = validDate(date);
    const rows = await db.all(
      `SELECT checkin_date, checked_at, response_code, message
       FROM daily_checkin_records
       WHERE profile_id = ? AND uid = ? AND checkin_date = ?
       LIMIT 1`,
      [profileId, accountUid, checkinDate]
    );
    if (!rows.length) return null;
    return {
      date: rows[0].checkin_date,
      ok: true,
      already: Number(rows[0].response_code) === 10001,
      code: rows[0].response_code === null ? null : Number(rows[0].response_code),
      message: String(rows[0].message || ''),
      at: Number(rows[0].checked_at),
      verified: true,
    };
  }

  async function listDailyCheckins(uids, date) {
    await initialize();
    const accountUids = Array.from(new Set((Array.isArray(uids) ? uids : []).map((uid) => validIdentity(uid, 'uid'))));
    const checkinDate = validDate(date);
    if (!accountUids.length) return {};
    const placeholders = accountUids.map(() => '?').join(',');
    const rows = await db.all(
      `SELECT uid, checkin_date, checked_at, response_code, message
       FROM daily_checkin_records
       WHERE profile_id = ? AND checkin_date = ? AND uid IN (${placeholders})`,
      [profileId, checkinDate, ...accountUids]
    );
    const result = {};
    for (const row of rows) {
      if (!accountUids.includes(row.uid)) continue;
      result[row.uid] = {
        date: row.checkin_date,
        ok: true,
        already: Number(row.response_code) === 10001,
        code: row.response_code === null ? null : Number(row.response_code),
        message: String(row.message || ''),
        at: Number(row.checked_at),
        verified: true,
      };
    }
    return result;
  }

  async function saveDailyCheckin({ uid, date, checkedAt, code, message }) {
    await initialize();
    const accountUid = validIdentity(uid, 'uid');
    const checkinDate = validDate(date);
    const timestamp = Number(checkedAt);
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('签到时间无效');
    const responseCode = code === null || code === undefined ? null : Number(code);
    if (responseCode !== null && !Number.isSafeInteger(responseCode)) throw new Error('签到响应 code 无效');
    await db.run(
      `INSERT INTO daily_checkin_records
         (profile_id, uid, checkin_date, checked_at, response_code, message)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(profile_id, uid, checkin_date) DO UPDATE SET
         checked_at = excluded.checked_at,
         response_code = excluded.response_code,
         message = excluded.message`,
      [profileId, accountUid, checkinDate, timestamp, responseCode, String(message || '')]
    );
    try { fs.chmodSync(dbPath, 0o600); } catch (_) {}
  }

  return {
    dailyUsageForUid,
    listDailyUsageRange,
    getDailyCheckin,
    listDailyCheckins,
    getSyncState,
    initialize,
    listDailyUsage,
    saveSuccessfulSync,
    saveHistoryUsage,
    saveDailyCheckin,
  };
}

module.exports = { createCreditUsageStore };
