'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const sync=require('../scripts/session-sync');
const {createCodeBuddyFiles}=require('../scripts/codebuddy-files');
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codedaddy-files-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const files=createCodeBuddyFiles({root,sync}),cwd='/fixture';
  files.register({id:'source',user_id:'user-a',cwd,title:'Fixture'});
  files.register({id:'target',user_id:'user-b',cwd,title:'Fixture'});
  const base=path.join(root,'user-a','CodeBuddyIDE','user-a','history',crypto.createHash('md5').update(path.normalize(cwd)).digest('hex'));
  fs.mkdirSync(path.join(base,'source','messages'),{recursive:true});
  fs.writeFileSync(path.join(base,'index.json'),JSON.stringify({conversations:[{id:'source',type:'craft',name:'Fixture',createdAt:'2026-01-01',lastMessageAt:'2026-01-01'}],current:'source'}));
  fs.writeFileSync(path.join(base,'source','index.json'),JSON.stringify({messages:[{id:'message',role:'user'}],requests:[]}));
  fs.writeFileSync(path.join(base,'source','messages','message.json'),JSON.stringify({id:'message',role:'user',message:'fixture',extra:{conversationId:'source'}}));
  return {root,files,base};
}
test('native history copy uses the shared guarded transaction and publishes a complete workspace index',async t=>{
  const {root,files}=fixture(t);
  const source=files.snapshot(null,'source',['target']),target=files.snapshot(null,'target',['source']);
  assert.equal(source.records.length,1);assert.equal(target.records,null);
  const result=await sync.applySnapshotAsync(source,target,{backupRoot:path.join(root,'backups'),commit:async verify=>{await verify();await files.publish('target','source');}});
  assert.ok(result.copiedBytes>0);
  assert.equal(sync.compareSnapshots(files.snapshot(null,'source',['target']),files.snapshot(null,'target',['source'])).kind,'equal');
  const copied=files.collect('target');assert.equal(copied.length,2);
  const message=JSON.parse(fs.readFileSync(copied.find(f=>f.path.includes('/messages/')).source));assert.equal(message.extra.conversationId,'target');assert.equal(message.message,'fixture');
  const index=JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(copied[0].source)),'index.json')));assert.equal(index.conversations[0].id,'target');
});
test('native history copy rolls files back when metadata commit fails',async t=>{
  const {root,files}=fixture(t);
  await assert.rejects(sync.applySnapshotAsync(files.snapshot(null,'source'),files.snapshot(null,'target'),{backupRoot:path.join(root,'backups'),commit:async()=>{throw Error('fixture failure');}}),/fixture failure/);
  assert.equal(files.snapshot(null,'target').files.size,0);
});
test('native history rejects partial messages, unknown owners, traversal and symlink paths',async t=>{
  const {files,base}=fixture(t);
  assert.throws(()=>files.snapshot(null,'unknown'),/归属/);
  assert.throws(()=>files.register({id:'x',user_id:'../escape',cwd:'/fixture'}),/无效/);
  fs.unlinkSync(path.join(base,'source','messages','message.json'));
  assert.throws(()=>files.snapshot(null,'source'),/缺少消息/);
  await assert.rejects(files.restore({record:{id:'source'},files:[{path:'workspace/sessions/source/../../escape',data:'eA=='}]},'target',false),/路径/);
});

test('ownership migration moves all native paths and rolls back on a failed native commit',async t=>{
  const {files}=fixture(t);
  const before={conversationId:'source',userId:'user-a',cwd:'/fixture'},after={...before,userId:'user-b'};
  const original=files.collect('source').map(f=>f.source);
  await assert.rejects(files.commit([{id:'source',before,after}],async()=>{throw Error('denied');}),/denied/);
  assert.deepEqual(files.collect('source').map(f=>f.source),original);
  await files.commit([{id:'source',before,after}],async()=>({changed:1}));
  assert.ok(files.collect('source').every(f=>f.source.includes(path.join('user-b','CodeBuddyIDE','user-b'))));
});

test('encrypted-transfer file mapping restores messages under a new owner and session identity',async t=>{
  const {files}=fixture(t);
  const archive={record:{id:'source'},files:files.collect('source').map(f=>({path:f.path,data:fs.readFileSync(f.source).toString('base64')}))};
  await files.restore(archive,'target',false);
  const copy=files.collect('target');const message=JSON.parse(fs.readFileSync(copy.find(f=>f.path.includes('/messages/')).source));
  assert.equal(message.extra.conversationId,'target');assert.equal(message.message,'fixture');
});

test('native deletion rolls files and workspace index back when the service rejects a running session',async t=>{
  const {files,base}=fixture(t);
  const index=fs.readFileSync(path.join(base,'index.json'),'utf8');
  await assert.rejects(files.deleteSessions(['source'],async()=>{throw Error('busy');}),/busy/);
  assert.equal(files.snapshot(null,'source').records.length,1);
  assert.equal(fs.readFileSync(path.join(base,'index.json'),'utf8'),index);
  await files.deleteSessions(['source'],async()=>({changed:1}));
  assert.equal(files.snapshot(null,'source').files.size,0);
});

test('workspace parse failures do not disclose stored text',async t=>{
  const {files,base}=fixture(t);
  fs.writeFileSync(path.join(base,'index.json'),'{private fixture');
  await assert.rejects(files.publish('target','source'),e=>!e.message.includes('private fixture') && /索引/.test(e.message));
});

test('native file-tree attachments survive the real encrypted archive codec',async t=>{
  const {root,files,base}=fixture(t);
  const tree=path.join(path.dirname(path.dirname(base)),'file-tree',path.basename(base),'source');
  fs.mkdirSync(tree,{recursive:true});fs.writeFileSync(path.join(tree,'snapshot.bin'),Buffer.from([0,1,255]));
  const {writeSessionTransfer,readSessionTransfer}=require('../scripts/session-transfer');
  const archive=path.join(root,'export.wds');
  await writeSessionTransfer(archive,[{record:{id:'source'},files:files.collect('source')}],'fixture-password');
  const decoded=await readSessionTransfer(archive,'fixture-password',path.join(root,'decoded'));
  await files.restore(decoded.sessions[0],'target',true);
  const copied=files.collect('target').find(f=>f.path.startsWith('codebuddy-file-tree/'));
  assert.ok(copied);assert.deepEqual(fs.readFileSync(copied.source),Buffer.from([0,1,255]));
});

test('size and invalidation probes use metadata without reading conversation bodies',async t=>{
  const {files}=fixture(t);
  const read=fs.readFileSync;fs.readFileSync=()=>{throw Error('content read forbidden');};
  try {
    const sizes=await files.sync.readSessionSizes(null,['source']);assert.ok(sizes.get('source')>0);
    assert.match(await files.sync.readSessionQuickFingerprintAsync(null,'source'),/^[a-f0-9]{64}$/);
  }finally{fs.readFileSync=read;}
});
