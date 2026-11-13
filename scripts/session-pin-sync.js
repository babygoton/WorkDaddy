'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Only IDs are retained, never conversation contents or account credentials.
// Separate from official storage: this is a delivery queue, not a pin authority.
function createSessionPinSync({ file, read, resolve, apply }) {
  let state = { snapshots: {}, pending: {}, delivered: {} };
  try { const saved = JSON.parse(fs.readFileSync(file, 'utf8')); if (saved.version === 1) state = saved; } catch (_) {}
  let tail = Promise.resolve();
  const serial = fn => { const task=tail.then(fn); tail=task.catch(()=>{}); return task; };
  const clean = ids => [...new Set((Array.isArray(ids) ? ids : []).filter(id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)))];
  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive:true, mode:0o700 });
    const temp=file+'.tmp'; fs.writeFileSync(temp, JSON.stringify({ ...state, version:1 }), {mode:0o600}); fs.renameSync(temp,file);
  };
  const key = (source, target, sourceId, targetId) => JSON.stringify([source,target,sourceId,targetId]);
  async function capture(uid) {
    const ids=await read(uid);
    if (!Array.isArray(ids)) return false;
    const pins=clean(ids); state.snapshots[uid]=pins;
    // Fresh official unpins invalidate undelivered copies and allow a future
    // explicit repin to be propagated again. Never unpin another account.
    for (const target of Object.keys(state.pending)) state.pending[target]=state.pending[target].filter(item=>item.source!==uid || pins.includes(item.sourceId));
    for (const id of Object.keys(state.delivered)) { const [source,,sourceId]=JSON.parse(id); if (source===uid&&!pins.includes(sourceId)) delete state.delivered[id]; }
    save(); return true;
  }
  async function flush(uid) {
    const pending=state.pending[uid]||[];
    if (!pending.length) return false;
    // Revalidate mappings at delivery time: a copied session may have been
    // deleted or remapped while this account was inactive.
    const valid=[];
    for (const source of new Set(pending.map(item=>item.source))) {
      const group=pending.filter(item=>item.source===source);
      const mappings=await resolve(source,uid,group.map(item=>item.sourceId));
      valid.push(...group.filter(item=>mappings.some(m=>m.sourceId===item.sourceId&&m.targetId===item.targetId)));
    }
    const ordered=pending.filter(item=>valid.includes(item));
    if (ordered.length && !await apply(uid,clean(ordered.map(item=>item.targetId)))) return false;
    for (const item of ordered) state.delivered[key(item.source,uid,item.sourceId,item.targetId)]=true;
    delete state.pending[uid]; save(); return ordered.length>0;
  }
  return {
    capture: uid => serial(()=>capture(uid)),
    flush: uid => serial(()=>flush(uid)),
    sync: (source,target) => serial(async()=>{
      if (!source||!target||source===target) return false;
      // Include incoming pending pins for rapid A -> B -> C rotations, where
      // B's renderer has not mounted yet but the copy queue has completed.
      const ids=clean([...(state.pending[source]||[]).map(item=>item.targetId),...(state.snapshots[source]||[])]);
      if (!ids.length) return false;
      const mappings=await resolve(source,target,ids);
      const queue=state.pending[target]||[];
      for (const sourceId of ids) {
        const targetId=mappings.find(item=>item.sourceId===sourceId)?.targetId;
        if (!clean([targetId]).length || targetId===sourceId || state.delivered[key(source,target,sourceId,targetId)]) continue;
        if (!queue.some(item=>item.source===source&&item.sourceId===sourceId&&item.targetId===targetId)) queue.push({source,sourceId,targetId});
      }
      if (!queue.length) return false;
      state.pending[target]=queue; save(); return flush(target);
    }),
  };
}

// These self-contained functions run through CDP. Use the public SDK, never
// React state or storage RPCs. Compare raw UID plus login context on each step.
async function readPinsInRenderer(expected) {
  const wb=window.wb;
  if (!wb?.account?.profile || !wb?.conversations?.listPinned) return null;
  const matches=p=>p&&String(p.uid||'')===String(expected.uid||'')&&String(p.type||'')===String(expected.type||'')&&String(p.enterpriseId||'')===String(expected.enterpriseId||'');
  if (!matches(await wb.account.profile())) return null;
  const items=await wb.conversations.listPinned();
  if (!Array.isArray(items)||!matches(await wb.account.profile())) return null;
  return items.map(item=>item.id).filter(id=>typeof id==='string');
}
async function applyPinsInRenderer(expected, ids) {
  const wb=window.wb, c=wb?.conversations;
  if (!wb?.account?.profile || !c?.listPinned || !c?.pin) return false;
  const matches=p=>p&&String(p.uid||'')===String(expected.uid||'')&&String(p.type||'')===String(expected.type||'')&&String(p.enterpriseId||'')===String(expected.enterpriseId||'');
  if (!matches(await wb.account.profile())) return false;
  const before=await c.listPinned(); if (!Array.isArray(before)) return false;
  const existing=new Set(before.map(item=>item.id));
  // Official pin inserts at the front. Reverse the source order once, and
  // leave existing target pins (and their relative order) untouched.
  for (const id of ids.slice().reverse()) {
    if (existing.has(id)) continue;
    if (!matches(await wb.account.profile())) return false;
    const result=await c.pin(id); if (result?.errorCode) return false;
  }
  if (!matches(await wb.account.profile())) return false;
  const after=await c.listPinned();
  return Array.isArray(after)&&ids.every(id=>after.some(item=>item.id===id));
}
module.exports={createSessionPinSync,readPinsInRenderer,applyPinsInRenderer};
