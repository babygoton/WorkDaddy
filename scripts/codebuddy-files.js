'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const identityKeys = new Set(['conversationId','sessionId','conversation_id','session_id','ownerConversationId']);
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);

// CodeBuddy's extension owns per-account history trees. Expose their files in
// the existing archive/snapshot vocabulary so panel and sync transactions stay
// shared; never synthesize an empty WorkBuddy transcript for a native session.
function createCodeBuddyFiles({root, sync}) {
  const rows = new Map();
  function parseIndex(text) {
    try { return JSON.parse(text); } catch (_) { throw Error('CodeBuddy 会话索引格式不兼容'); }
  }
  function register(row) {
    if (!row || !validId(row.id) || !validId(row.user_id) || typeof row.cwd !== 'string' || !path.isAbsolute(row.cwd)) throw Error('CodeBuddy 会话归属或工作区无效');
    rows.set(row.id, row);
  }
  function bases(id) {
    const row=rows.get(id);
    if(!row) throw Error('未找到 CodeBuddy 会话归属');
    const workspace=crypto.createHash('md5').update(path.normalize(row.cwd)).digest('hex');
    const base=[row.user_id,'CodeBuddyIDE',row.user_id];
    return [
      ['workspace/sessions', [...base,'history',workspace,id].join('/')],
      ['tasks', [...base,'plan-task',workspace,id].join('/')],
      ['file-history', [...base,'check-point',workspace,id].join('/')],
      ['codebuddy-file-tree', [...base,'file-tree',workspace,id].join('/')],
    ];
  }
  function safe(relative) {
    const parts=relative.split('/');
    if(parts.some(p=>!p || p==='.' || p==='..' || /[\\\x00]/.test(p))) throw Error('无效的会话文件路径');
    let target=path.resolve(root);
    for(const part of parts) {
      target=path.join(target,part);
      try {if(fs.lstatSync(target).isSymbolicLink()) throw Error('会话目录包含符号链接');}
      catch(e){if(e.code!=='ENOENT')throw e;}
    }
    return target;
  }
  function relativeFor(key,id) {
    for(const [prefix,relative] of bases(id)) {
      const lead=prefix+'/__session__/';
      if(key.startsWith(lead)) return relative+'/'+key.slice(lead.length);
    }
    throw Error('CodeBuddy 会话归档格式不兼容');
  }
  function normalize(value,aliases) {
    if(Array.isArray(value)) return value.map(v=>normalize(v,aliases));
    if(value && typeof value==='object') return Object.fromEntries(Object.keys(value).sort().map(k=>[k,identityKeys.has(k)&&aliases.includes(value[k])?'__session__':normalize(value[k],aliases)]));
    return value;
  }
  function snapshot(_root,id,aliases=[]) {
    const known=Array.from(new Set([id,...aliases])), files=new Map();let totalBytes=0;
    function visit(relative,key) {
      const file=safe(relative);let stat;
      try{stat=fs.lstatSync(file);}catch(e){if(e.code==='ENOENT')return;throw e;}
      if(stat.isDirectory()) {for(const name of fs.readdirSync(file).sort()) {
        if(name.startsWith('.') || /\.(?:lock|tmp|bak)$/.test(name))continue;
        visit(relative+'/'+name,key+'/'+name);
      }return;}
      if(!stat.isFile())throw Error('不支持的会话文件类型');
      const bytes=fs.readFileSync(file),after=fs.statSync(file);
      if(bytes.length!==stat.size || stat.mtimeMs!==after.mtimeMs || stat.ctimeMs!==after.ctimeMs)throw Error('会话文件正在变化');
      let semantic=hash(bytes);
      if(key.startsWith('workspace/sessions/') && file.endsWith('.json')) {
        let json;try{json=JSON.parse(bytes);}catch{throw Error('CodeBuddy 会话文件未写完或已损坏');}
        semantic=hash(JSON.stringify(normalize(json,known)));
      }
      files.set(key,{relative,sourcePath:file,bytes,hash:hash(bytes),semantic,size:stat.size,mode:stat.mode&0o777,mtimeMs:stat.mtimeMs,ctimeMs:stat.ctimeMs});totalBytes+=stat.size;
    }
    for(const [prefix,relative] of bases(id)) visit(relative,prefix+'/__session__');
    const indexKey='workspace/sessions/__session__/index.json',indexFile=files.get(indexKey);
    let records=null;
    if(indexFile) {
      const index=JSON.parse(indexFile.bytes);
      if(!Array.isArray(index.messages))throw Error('CodeBuddy 消息索引格式不兼容');
      records=index.messages.map(entry=>{
        if(!validId(entry.id))throw Error('CodeBuddy 消息标识无效');
        const file=files.get('workspace/sessions/__session__/messages/'+entry.id+'.json');
        if(!file)throw Error('CodeBuddy 会话缺少消息文件');
        return file.semantic;
      });
      if(!records.length)throw Error('会话消息文件没有消息，未同步');
    } else if(files.size) throw Error('CodeBuddy 会话缺少消息索引');
    const result={root:path.resolve(root),id,aliases:known,files,totalBytes,records,transcriptKey:indexFile?indexKey:null};
    result.reread=()=>snapshot(null,id,known);
    result.resolveRelative=key=>relativeFor(key,id);
    result.rewriteBytes=(key,file,target)=>{
      if(!key.startsWith('workspace/sessions/') || !key.endsWith('.json')) return null;
      const rewrite=value=>{
        if(Array.isArray(value))return value.map(rewrite);
        if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,identityKeys.has(k)&&known.includes(v)?target.id:rewrite(v)]));
        return value;
      };
      return Buffer.from(JSON.stringify(rewrite(JSON.parse(file.bytes))));
    };
    return result;
  }
  async function fileMarkers(id) {
    const markers=[];let totalBytes=0;
    async function visit(relative) {
      const file=safe(relative);let stat;
      try {stat=await fs.promises.lstat(file);}catch(error){if(error.code==='ENOENT')return;throw error;}
      if(stat.isSymbolicLink())throw Error('会话目录包含符号链接');
      markers.push([relative,stat.size,stat.mtimeMs,stat.ctimeMs]);
      if(stat.isDirectory()) {
        for(const name of (await fs.promises.readdir(file)).sort()) {
          if(name.startsWith('.') || /\.(?:lock|tmp|bak)$/.test(name))continue;
          await visit(relative+'/'+name);
        }
      } else if(stat.isFile())totalBytes+=stat.size;
      else throw Error('不支持的会话文件类型');
    }
    for(const [,relative] of bases(id))await visit(relative);
    return {totalBytes,fingerprint:hash(JSON.stringify(markers))};
  }
  function tokenOptions(ids) {
    const owners=new Map();
    for(const id of ids) {
      if(!rows.has(id))continue;
      const file=safe(bases(id)[0][1]+'/index.json');
      if(fs.existsSync(file))owners.set(file,id);
    }
    return {files:[...owners.keys()],source:'local-codebuddy-requests',
      sourceSession:file=>owners.get(file),
      readRecords:text=>{const index=parseIndex(text);return Array.isArray(index.requests)?index.requests:[];}};
  }
  function collect(id) {
    return [...snapshot(null,id).files].map(([key,file])=>({path:key.replace('/__session__/','/'+id+'/'),source:file.sourcePath,size:file.size}));
  }
  async function restore(archive,newId,staged) {
    const oldId=String(archive.record?.id || '');if(!validId(oldId))throw Error('会话归档 ID 无效');
    const targets=new Set();const written=[];
    try {
      for(const entry of archive.files || []) {
        if(typeof entry.path!=='string')throw Error('会话归档路径无效');
        const key=entry.path.replace('/'+oldId+'/','/__session__/');
        const target=safe(relativeFor(key,newId));
        if(targets.has(target))throw Error('会话归档路径重复');targets.add(target);
        fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
        if(staged)await fs.promises.copyFile(entry.source,target,fs.constants.COPYFILE_EXCL);
        else {
          if(typeof entry.data!=='string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(entry.data))throw Error('会话归档数据无效');
          await fs.promises.writeFile(target,Buffer.from(entry.data,'base64'),{flag:'wx',mode:0o600});
        }
        written.push(target);await fs.promises.chmod(target,0o600);
        if(key.startsWith('workspace/sessions/') && key.endsWith('.json')) {
          const rewrite=value=>{
            if(Array.isArray(value))return value.map(rewrite);
            if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,identityKeys.has(k)&&v===oldId?newId:rewrite(v)]));
            return value;
          };
          let json;try{json=JSON.parse(await fs.promises.readFile(target,'utf8'));}catch{throw Error('CodeBuddy 会话归档格式不兼容');}
          await fs.promises.writeFile(target,JSON.stringify(rewrite(json)),{mode:0o600});
        }
      }
      snapshot(null,newId);
    }catch(e){for(const file of written)await fs.promises.unlink(file).catch(()=>{});throw e;}
  }
  async function publish(id,sourceId,metadata) {
    const row=rows.get(id);if(!row)throw Error('未找到会话归属');
    const indexFile=safe(path.posix.dirname(bases(id)[0][1])+'/index.json');
    fs.mkdirSync(path.dirname(indexFile),{recursive:true,mode:0o700});
    // Match the official proper-lockfile directory lock; never replace a
    // workspace index while its HistoryManager is updating it.
    const lock=indexFile+'.lock';
    try{fs.mkdirSync(lock,{mode:0o700});}catch(e){if(e.code==='EEXIST')throw Error('工作区会话索引正在更新，请稍后重试');throw e;}
    let created;
    try {
      let index={conversations:[],current:''};
      if(fs.existsSync(indexFile)) index=parseIndex(fs.readFileSync(indexFile,'utf8'));
      if(!Array.isArray(index.conversations))throw Error('工作区会话索引格式不兼容');
      if(index.conversations.some(c=>c.id===id))return async()=>{};
      let original=metadata;
      if(!original && sourceId && rows.has(sourceId)) {
        const sourceIndex=safe(path.posix.dirname(bases(sourceId)[0][1])+'/index.json');
        if(fs.existsSync(sourceIndex)) original=parseIndex(fs.readFileSync(sourceIndex,'utf8')).conversations?.find(c=>c.id===sourceId);
      }
      const now=new Date().toISOString();
      created={...original,id,type:original?.type || 'craft',name:row.custom_title || row.title || original?.name || '',createdAt:original?.createdAt || now,lastMessageAt:original?.lastMessageAt || now,originalId:id};
      index.conversations.push(created);
      const temp=indexFile+'.codedaddy-'+crypto.randomUUID();
      try{fs.writeFileSync(temp,JSON.stringify(index),{flag:'wx',mode:0o600});fs.renameSync(temp,indexFile);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
    }finally{fs.rmdirSync(lock);}
    return async()=>{
      fs.mkdirSync(lock,{mode:0o700});
      try{const index=parseIndex(fs.readFileSync(indexFile,'utf8'));const i=index.conversations.findIndex(c=>c.id===id && JSON.stringify(c)===JSON.stringify(created));
        if(i>=0){index.conversations.splice(i,1);const temp=indexFile+'.codedaddy-'+crypto.randomUUID();fs.writeFileSync(temp,JSON.stringify(index),{flag:'wx',mode:0o600});fs.renameSync(temp,indexFile);}
      }finally{fs.rmdirSync(lock);}
    };
  }
  function removeIndex(id) {
    const indexFile=safe(path.posix.dirname(bases(id)[0][1])+'/index.json');
    if(!fs.existsSync(indexFile))return ()=>{};
    const lock=indexFile+'.lock';fs.mkdirSync(lock,{mode:0o700});
    let before,after;
    try {
      before=fs.readFileSync(indexFile,'utf8');const index=parseIndex(before);
      if(!Array.isArray(index.conversations))throw Error('工作区会话索引格式不兼容');
      index.conversations=index.conversations.filter(c=>c.id!==id);
      if(index.current===id)index.current='';
      after=JSON.stringify(index);const temp=indexFile+'.codedaddy-'+crypto.randomUUID();
      fs.writeFileSync(temp,after,{flag:'wx',mode:0o600});fs.renameSync(temp,indexFile);
    } finally {fs.rmdirSync(lock);}
    return ()=>{
      fs.mkdirSync(lock,{mode:0o700});
      try {
        if(fs.readFileSync(indexFile,'utf8')!==after)throw Error('会话索引已变化，恢复未确认');
        const temp=indexFile+'.codedaddy-'+crypto.randomUUID();fs.writeFileSync(temp,before,{flag:'wx',mode:0o600});fs.renameSync(temp,indexFile);
      }finally{fs.rmdirSync(lock);}
    };
  }
  async function commit(changes,write) {
    const undo=[];
    try {
      for(const change of changes) {
        if(!change.before || !change.after || change.before.userId===change.after.userId)continue;
        const before={...change.before,id:change.id,user_id:change.before.userId,cwd:change.before.cwd};
        const after={...change.after,id:change.id,user_id:change.after.userId,cwd:change.after.cwd};
        register(before);const sourceBases=bases(change.id);
        const sourceIndex=safe(path.posix.dirname(sourceBases[0][1])+'/index.json');
        let metadata;
        if(fs.existsSync(sourceIndex))metadata=parseIndex(fs.readFileSync(sourceIndex,'utf8')).conversations?.find(c=>c.id===change.id);
        const restoreIndex=removeIndex(change.id);undo.push(restoreIndex);
        register(after);undo.push(()=>register(before));const targets=bases(change.id);
        for(let i=0;i<sourceBases.length;i++) {
          const source=safe(sourceBases[i][1]),target=safe(targets[i][1]);
          if(!fs.existsSync(source))continue;
          if(fs.existsSync(target))throw Error('目标账号已有同名会话文件，未覆盖');
          fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
          fs.renameSync(source,target);undo.push(()=>fs.renameSync(target,source));
        }
        undo.push(await publish(change.id,null,metadata));
      }
      return await write();
    } catch(error) {
      for(const restore of undo.reverse())await restore();
      throw error;
    }
  }
  async function deleteSessions(ids,write) {
    const undo=[],staged=[];
    try {
      for(const id of ids) {
        undo.push(removeIndex(id));
        for(const [,relative] of bases(id)) {
          const original=safe(relative);
          if(!fs.existsSync(original))continue;
          const temporary=original+'.codedaddy-delete-'+crypto.randomUUID();
          fs.renameSync(original,temporary);staged.push(temporary);
          undo.push(()=>fs.renameSync(temporary,original));
        }
      }
      await write();
    } catch(error) {
      let failed=false;
      for(const restore of undo.reverse()) {try {await restore();}catch(_){failed=true;}}
      if(failed)throw Error('会话删除失败，文件恢复未确认');
      throw error;
    }
    // Metadata has committed. Cleanup failure must not roll back only the files.
    for(const file of staged)await fs.promises.rm(file,{recursive:true,force:true}).catch(()=>{});
    return staged.length;
  }
  function remove(id) {removeIndex(id);let count=0;for(const [,relative] of bases(id)){const file=safe(relative);if(fs.existsSync(file)){fs.rmSync(file,{recursive:true});count++;}}return count;}
  return {register,collect,tokenOptions,restore,remove,snapshot,publish,commit,deleteSessions,
    sync:{...sync,readSnapshot:snapshot,readSnapshotAsync:async(...args)=>snapshot(...args),
      readSessionSizes:async(_root,ids)=>{const result=new Map();for(const id of ids){try{result.set(id,(await fileMarkers(id)).totalBytes);}catch{result.set(id,null);}}return result;},
      readSessionFingerprintAsync:async(_root,id)=>(await fileMarkers(id)).fingerprint,
      readSessionQuickFingerprintAsync:async(_root,id)=>(await fileMarkers(id)).fingerprint,
    },
  };
}
module.exports={createCodeBuddyFiles};
