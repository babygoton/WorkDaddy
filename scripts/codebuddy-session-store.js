'use strict';

// Present the existing sessions contract to shared handlers. SQL runs against
// an in-memory view, never against CodeBuddy's incompatible ItemTable schema.
// Writes go through its main-process service so the official cache/UI update.
const fields = {
  id:'conversationId',cwd:'cwd',user_id:'userId',title:'title',custom_title:'customTitle',status:'status',
  created_at:'createdAt',updated_at:'updatedAt',last_activity_at:'updatedAt',deleted_at:'deletedAt',
  is_playground:'isPlayground',source_mode:'sourceMode',is_background_automation:'isBackgroundAutomation',
  mode:'mode',model:'model',expert_id:'expertId',expert_locale:'expertLocale',expert_runtime_identity:'expertRuntimeIdentity',
  expert_marketplace:'expertMarketplace',permission_mode:'permissionMode',use_sandbox_cli:'useSandboxCli',project_id:'projectId',
};
const numeric = new Set(['created_at','updated_at','last_activity_at','deleted_at','is_playground','is_background_automation','use_sandbox_cli']);
function sessionRow(value) {
  const row = {};
  for (const [key, source] of Object.entries(fields)) {
    const cell = value[source];
    row[key] = cell == null ? (key === 'deleted_at' || numeric.has(key) ? null : '') :
      numeric.has(key) ? Number(cell) : String(cell);
  }
  return row;
}
function createCodeBuddySessionStore({readItems, writeChanges}) {
  async function view() {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE TABLE sessions (' + Object.keys(fields).map(key => key + (numeric.has(key) ? ' NUMERIC' : ' TEXT') + (key==='id' ? ' PRIMARY KEY' : '')).join(',') + ')');
      const insert = db.prepare('INSERT INTO sessions VALUES (' + Object.keys(fields).map(() => '?').join(',') + ')');
      const originals = new Map();
      for (const item of await readItems()) {
        let value;
        try { value = JSON.parse(item.value); } catch (_) { continue; }
        if (!value || typeof value !== 'object') continue;
        value.conversationId = value.conversationId || String(item.key).slice('session:'.length);
        originals.set(value.conversationId, value);
        insert.run(...Object.values(sessionRow(value)));
      }
      db.originals = originals;
      return db;
    } catch (error) { db.close(); throw error; }
  }
  let writes = Promise.resolve();
  return {
    async all(sql, params=[]) {
      await writes.catch(() => {});
      const db=await view();
      try { return db.prepare(sql).all(...params).map(row=>({...row})); }
      finally { db.close(); }
    },
    run(sql, params=[]) {
      const work = writes.catch(() => {}).then(async () => {
        const db=await view();
        try {
          const before=new Map(db.prepare('SELECT * FROM sessions').all().map(row=>[row.id,row]));
          const result=db.prepare(sql).run(...params);
          const after=new Map(db.prepare('SELECT * FROM sessions').all().map(row=>[row.id,row]));
          const changes=[];
          for (const [id, row] of after) {
            const old=before.get(id);
            if (old && JSON.stringify(old)===JSON.stringify(row)) continue;
            const update={...db.originals.get(id)};
            for (const [key, target] of Object.entries(fields)) if(key!=='last_activity_at') {
              if (row[key] == null) delete update[target]; else update[target]=row[key];
            }
            changes.push({id,before:db.originals.get(id) || null,after:update});
          }
          for (const id of before.keys()) if(!after.has(id)) changes.push({id,before:db.originals.get(id),after:null});
          if(changes.length) {
            const saved=await writeChanges(changes);
            if(saved?.changed!==changes.length) throw new Error('CodeBuddy 未确认会话写入');
          }
          return result;
        } finally { db.close(); }
      });
      writes=work; return work;
    },
  };
}
module.exports={createCodeBuddySessionStore,sessionRow};
