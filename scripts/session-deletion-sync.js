'use strict';

// Official deletion is soft deletion in the session database. Reuse those
// durable markers instead of inferring deletion from missing files/cache entries.
// Only persisted provenance links accounts; titles and working directories do not.
function createSessionDeletionSync({ query, run, members, locks }) {
  const isDeleted = row => row && row.deleted_at !== null && row.deleted_at !== undefined && row.deleted_at !== '';
  const group = ids => members(ids).filter(member => member && member.id && member.uid);
  async function rowsFor(links) {
    const rows = [];
    for (let start = 0; start < links.length; start += 100) {
      const batch = links.slice(start, start + 100);
      rows.push(...await query('SELECT id, user_id, deleted_at FROM sessions WHERE COALESCE(is_background_automation, 0) = 0 AND (' +
        batch.map(() => '(id = ? AND user_id = ?)').join(' OR ') + ');', batch.flatMap(member => [member.id, member.uid])));
    }
    return rows;
  }
  async function withLocks(ids, task) {
    const keys = [...new Set(group(ids).map(member => member.lineageId).filter(Boolean))].sort();
    const previous = keys.map(key => locks.get(key)).filter(Boolean);
    const current = Promise.all(previous.map(promise => Promise.resolve(promise).catch(() => {}))).then(task);
    // Reserve synchronously: subsequent copy workers must queue behind this
    // deletion. Re-read membership after waiting to include just-published copies.
    keys.forEach(key => locks.set(key, current));
    try { return await current; }
    finally { keys.forEach(key => { if (locks.get(key) === current) locks.delete(key); }); }
  }
  async function hasDeletion(id, uid) {
    const links = group([id]);
    if (!links.some(member => member.id === id && member.uid === uid)) return false;
    return (await rowsFor(links)).some(isDeleted);
  }
  async function propagate(id, uid, explicit) {
    return withLocks([id], async () => {
      const links = group([id]);
      if (!links.some(member => member.id === id && member.uid === uid)) return 0;
      const rows = await rowsFor(links);
      const seed = rows.find(row => row.id === id && row.user_id === uid);
      let deletedAt = rows.find(isDeleted)?.deleted_at;
      if (deletedAt === undefined) {
        if (!explicit || seed) return 0;
        // An explicit renderer deletion may follow a hard delete. Confirm the
        // known record really is absent, not reassigned or a background task.
        if ((await query('SELECT id FROM sessions WHERE id = ?;', [id])).length) return 0;
        deletedAt = Date.now();
      }
      let changed = 0;
      for (let start = 0; start < rows.length; start += 100) {
        const live = rows.slice(start, start + 100).filter(row => !isDeleted(row));
        if (!live.length) continue;
        const result = await run('UPDATE sessions SET deleted_at = ?, updated_at = ? WHERE deleted_at IS NULL AND COALESCE(is_background_automation, 0) = 0 AND (' +
          live.map(() => '(id = ? AND user_id = ?)').join(' OR ') + ');',
        [deletedAt, Date.now(), ...live.flatMap(row => [row.id, row.user_id])]);
        changed += Number(result && result.changes) || 0;
      }
      return changed;
    });
  }
  async function reconcileAll() {
    const deleted = await query('SELECT id, user_id FROM sessions WHERE deleted_at IS NOT NULL AND COALESCE(is_background_automation, 0) = 0;');
    const seen = new Set();
    let changed = 0;
    for (const row of deleted) {
      if (seen.has(row.id)) continue;
      const links = group([row.id]);
      if (!links.some(member => member.id === row.id && member.uid === row.user_id)) continue;
      links.forEach(member => seen.add(member.id));
      changed += await propagate(row.id, row.user_id, false);
    }
    return changed;
  }
  async function observeDeleted(uid, ids) {
    let changed = 0;
    for (const id of new Set(ids)) changed += await propagate(id, uid, true);
    return changed;
  }
  async function restore(ids) {
    return withLocks(ids, async () => {
      const links = group(ids);
      const rows = await rowsFor(links);
      // Standalone sessions have no lineage; retain the old restore behavior.
      const known = new Set(links.map(member => member.id));
      for (const id of ids) if (!known.has(id)) {
        rows.push(...await query('SELECT id, user_id, deleted_at FROM sessions WHERE id = ? AND COALESCE(is_background_automation, 0) = 0;', [id]));
      }
      for (let start = 0; start < rows.length; start += 100) {
        const batch = rows.slice(start, start + 100);
        await run('UPDATE sessions SET deleted_at = NULL, updated_at = ? WHERE COALESCE(is_background_automation, 0) = 0 AND (' +
          batch.map(() => '(id = ? AND user_id = ?)').join(' OR ') + ');',
        [Date.now(), ...batch.flatMap(row => [row.id, row.user_id])]);
      }
    });
  }
  return { hasDeletion, reconcileAll, observeDeleted, restore };
}

module.exports = { createSessionDeletionSync };
