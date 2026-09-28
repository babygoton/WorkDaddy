'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createCodeBuddySessionStore}=require('../scripts/codebuddy-session-store.js');
function harness() {
  const rows=new Map([['a',{conversationId:'a',userId:'u1',cwd:'/workspace',title:'title',customTitle:'custom',createdAt:1,updatedAt:10}],['b',{conversationId:'b',userId:'u2',cwd:'/other',updatedAt:20,deletedAt:21}]]);
  const calls=[];
  const store=createCodeBuddySessionStore({readItems:async()=>Array.from(rows,([id,row])=>({key:'session:'+id,value:JSON.stringify(row)})),writeChanges:async changes=>{
    for(const c of changes) {calls.push(c);rows.set(c.id,c.after || {...rows.get(c.id),deletedAt:30});}
    return {changed:changes.length};
  }});
  return {rows,calls,store};
}
test('shared SQL filters, sorting, custom titles and tombstones remain correct',async()=>{
  const {store}=harness();
  assert.deepEqual(await store.all('SELECT id, custom_title FROM sessions WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC',['u1']),[{id:'a',custom_title:'custom'}]);
  assert.deepEqual(await store.all('SELECT COUNT(*) AS count FROM sessions WHERE deleted_at IS NULL'),[{count:1}]);
  assert.deepEqual(await store.all('SELECT id FROM sessions WHERE updated_at > ? AND deleted_at IS NULL',[11]),[]);
});
test('copy, migrate and delete update native service instead of writing its database',async()=>{
  const {store,rows,calls}=harness();
  await store.run('INSERT INTO sessions (id,user_id,cwd,title) VALUES (?,?,?,?)',['new','u2','/workspace','copy']);
  assert.equal(rows.get('new').userId,'u2');
  assert.equal(calls[0].before,null);
  await store.run('UPDATE sessions SET user_id = ? WHERE id IN (?)',['u3','a']);
  assert.equal(rows.get('a').userId,'u3');
  await store.run('DELETE FROM sessions WHERE id IN (?)',['a']);
  assert.equal(rows.get('a').deletedAt,30);
  assert.deepEqual(await store.all('SELECT id FROM sessions WHERE deleted_at IS NULL'),[{id:'new'}]);
});
test('native write failures are reported and later requests can retry',async()=>{
  const store=createCodeBuddySessionStore({readItems:async()=>[],writeChanges:async()=>{throw Error('offline');}});
  await assert.rejects(store.run('INSERT INTO sessions (id) VALUES (?)',['new']),/offline/);
  assert.deepEqual(await store.all('SELECT * FROM sessions'),[]);
});

test('restoring a tombstone preserves exact metadata and timestamps',async()=>{
  const {store,rows}=harness();
  await store.run('UPDATE sessions SET deleted_at = NULL, updated_at = ? WHERE id = ?',[25,'b']);
  assert.equal(rows.get('b').deletedAt,undefined);
  assert.equal(rows.get('b').updatedAt,25);
  assert.deepEqual(await store.all('SELECT id FROM sessions WHERE deleted_at IS NULL ORDER BY updated_at DESC'),[{id:'b'},{id:'a'}]);
});
