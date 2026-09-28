'use strict';
const path = require('node:path');
const fs = require('node:fs');
const {isCodeBuddyBinary} = require('./profiles');

// Run on the official authentication service. Persist using Electron's own
// encryption service before publishing to windows; never patch app.asar or
// pretend that renderer-only state changes switch the account.
async function replaceNativeSession(session) {
  await this.initialized;
  if (this.refreshInFlight || this.loginInProgress || this.logoutInProgress) throw new Error('登录状态正在更新，请稍后重试');
  if (session !== null && (!session || !session.account || !session.account.uid || !session.auth || typeof session.auth.accessToken !== 'string' || !session.auth.accessToken)) throw new Error('账号备份无效');
  const previous = this.currentSession;
  // Reserve the official guards before the first await. A refresh or logout
  // must not overwrite this transaction while encrypted storage is pending.
  let unlock;
  this.loginInProgress = new Promise(resolve => { unlock = resolve; });
  this.refreshInFlight = true;
  this.logoutInProgress = true;
  if (this.refreshTimer) { clearTimeout(this.refreshTimer); this.refreshTimer = undefined; }
  const persist = async value => {
    if (value) await this.storeSession(value);
    else await this.storageService.remove(this.getStorageKey(), -1);
  };
  let succeeded = false;
  try {
    await persist(session);
    this.currentSession = session || undefined;
    this.refreshFailureRetryCount = 0;
    this._onDidChangeSession.fire(this.currentSession);
    this.scheduleRefresh();
    succeeded = true;
    return {uid:session ? String(session.account.uid) : null};
  } catch (_) {
    try {
      await persist(previous);
      this.currentSession = previous;
      this._onDidChangeSession.fire(previous);
      this.scheduleRefresh();
    } catch (_) {
      throw new Error('账号切换失败，原登录态恢复未确认');
    }
    throw new Error('账号切换失败，已恢复原登录态');
  } finally {
    this.refreshInFlight = false;
    this.logoutInProgress = false;
    this.loginInProgress = undefined;
    unlock(succeeded);
  }
}

async function findNativeService(send, channel, predicate) {
  const root = await send('Runtime.evaluate', {
    expression:"process.getBuiltinModule('module').createRequire(process.execPath)('electron').ipcMain._invokeHandlers.get(" + JSON.stringify(channel) + ")",
    objectGroup:'codedaddy-auth',
  });
  if (root.exceptionDetails || root.result?.type !== 'function') throw new Error('当前 CodeBuddy 版本未找到原生认证入口');
  const seen = new Set();
  async function visit(objectId, depth) {
    if (!objectId || depth > 4 || seen.has(objectId) || seen.size > 24) return null;
    seen.add(objectId);
    const props = await send('Runtime.getProperties', {objectId,ownProperties:true});
    const scopes = props.internalProperties?.find(p=>p.name==='[[Scopes]]');
    if (!scopes?.value?.objectId) return null;
    const list = await send('Runtime.getProperties',{objectId:scopes.value.objectId,ownProperties:true});
    for (const scope of list.result.filter(p=>/^\d+$/.test(p.name) && /Closure/.test(p.value?.description || ''))) {
      const members = await send('Runtime.getProperties',{objectId:scope.value.objectId,ownProperties:true});
      // Do not scan the whole main-process module, global object or heap.
      if (members.result.length > 24) continue;
      for (const member of members.result.filter(p=>p.value?.type==='object' && p.value.objectId)) {
        const check = await send('Runtime.callFunctionOn',{objectId:member.value.objectId,
          functionDeclaration:predicate.toString(),returnByValue:true});
        if (check.result?.value===true) return member.value.objectId;
      }
      for (const member of members.result.filter(p=>p.value?.type==='function')) {
        const found=await visit(member.value.objectId,depth+1); if(found)return found;
      }
    }
    return null;
  }
  const objectId=await visit(root.result.objectId,0);
  if(!objectId) throw new Error('当前 CodeBuddy 版本的认证服务结构不兼容');
  return objectId;
}

function findAuthService(send) {
  return findNativeService(send, 'vscode:genie:auth:getSession', function () {
    return typeof this.getCurrentSessionAsync === 'function' && typeof this.storeSession === 'function' &&
      typeof this.scheduleRefresh === 'function' && typeof this._onDidChangeSession?.fire === 'function';
  });
}

// The public upsert drops metadata and cannot restore tombstones. Execute the
// shared SQL diff through the owning main service, with a revision check, its
// write queue, encrypted-client-independent storage and official notifications.
// This also keeps pending sessions and v2 subscribers in sync (no DB file edits).
async function writeNativeSessions(changes) {
  return this.enqueueV2Write(async () => {
    if (!this._db || !(this._sessions instanceof Map)) throw new Error('会话存储尚未就绪');
    const updates = new Map();
    for (const change of changes) {
      const current = this._sessions.get(change.id);
      if (current && ['Working','Planning'].includes(current.status)) throw new Error('会话正在运行，请完成后重试');
      if (JSON.stringify(current || null) !== JSON.stringify(change.before || null)) throw new Error('会话已变化，请刷新后重试');
      const value = change.after ? {...current, ...change.after} : {...current, deletedAt:Date.now(), updatedAt:Date.now()};
      if (change.after && change.after.deletedAt == null) delete value.deletedAt;
      value.conversationId = change.id;
      if (typeof this.nextV2Revision === 'function') value.revision = this.nextV2Revision();
      updates.set('session:' + change.id, JSON.stringify(value));
    }
    await this._db.updateItems({insert:updates});
    for (const change of changes) {
      const value = JSON.parse(updates.get('session:' + change.id));
      this._sessions.set(change.id,value);
      this._newSessions.delete(change.id);
      // Persisted data is authoritative. A closed window must not make callers
      // roll back files after the metadata transaction has already committed.
      try { if (typeof this.broadcastV2 === 'function') this.broadcastV2(value.deletedAt == null ? 'upsert' : 'delete', value, 'codedaddy', value.revision); } catch (_) {}
      try { this.notifyAgentManager(value.deletedAt == null ? 'upsert' : 'delete', value.deletedAt == null ? value : {conversationId:change.id}); } catch (_) {}
    }
    return {changed:changes.length};
  });
}

async function findSessionService(send, onPause) {
  const handler=await send('Runtime.evaluate',{expression:"process.getBuiltinModule('module').createRequire(process.execPath)('electron').ipcMain._invokeHandlers.get('codebuddy:getSession')"});
  if(handler.result?.type !== 'function') throw new Error('未找到会话服务入口');
  const props=await send('Runtime.getProperties',{objectId:handler.result.objectId,ownProperties:true});
  const scopes=props.internalProperties?.find(p=>p.name==='[[Scopes]]');
  if(!scopes?.value?.objectId) throw new Error('会话服务入口不兼容');
  const list=await send('Runtime.getProperties',{objectId:scopes.value.objectId,ownProperties:true});
  let callback;
  for(const scope of list.result.filter(p=>/Closure/.test(p.value?.description || ''))) {
    const members=await send('Runtime.getProperties',{objectId:scope.value.objectId,ownProperties:true});
    if(members.result.length > 8) continue;
    const functions=members.result.filter(p=>p.value?.type==='function');
    if(functions.length===1) {callback=functions[0].value.objectId;break;}
  }
  if(!callback) throw new Error('会话服务回调不兼容');
  // V8 omits lexical `this` from arrow-function scopes. Briefly stop only our
  // harmless getSession call to retain that receiver, then resume immediately.
  // Never pause arbitrary application code, scan the heap or patch a prototype.
  let breakpoint, timer;
  await send('Debugger.enable');
  try {
    breakpoint=await send('Debugger.setBreakpointOnFunctionCall',{objectId:callback});
    const paused=new Promise((resolve,reject)=>{
      onPause(event=>{if(event.hitBreakpoints?.includes(breakpoint.breakpointId))resolve(event);});
      timer=setTimeout(()=>{send('Debugger.resume').catch(()=>{});reject(new Error('会话服务发现超时'));},1000);
    });
    const invocation=send('Runtime.callFunctionOn',{objectId:callback,functionDeclaration:"function(){return this(null,'__codedaddy_readonly_probe__');}",awaitPromise:true});
    invocation.catch(()=>{}); // Timeout cleanup may run before the invocation settles.
    const event=await paused;
    const owner=await send('Debugger.evaluateOnCallFrame',{callFrameId:event.callFrames[0].callFrameId,expression:'this',objectGroup:'codedaddy-sessions'});
    await send('Debugger.resume');
    clearTimeout(timer);
    await invocation;
    const objectId=owner.result?.objectId;
    if(!objectId) throw new Error('会话服务对象不可用');
    const check=await send('Runtime.callFunctionOn',{objectId,functionDeclaration:"function(){return this._sessions instanceof Map && this._newSessions instanceof Set && typeof this.enqueueV2Write==='function' && typeof this.notifyAgentManager==='function';}",returnByValue:true});
    if(check.result?.value!==true) throw new Error('会话服务版本不兼容');
    return objectId;
  } finally {
    clearTimeout(timer);onPause(null);
    await send('Debugger.resume').catch(()=>{});
    if(breakpoint?.breakpointId) await send('Debugger.removeBreakpoint',{breakpointId:breakpoint.breakpointId}).catch(()=>{});
    await send('Debugger.disable').catch(()=>{});
  }
}

function createCodeBuddyNative({profile,WebSocketCtor}) {
  let ws, service, sessionService, sessionConnecting, connecting, pauseListener, serial=0;
  const pending=new Map();
  function send(method,params={}) {
    return new Promise((resolve,reject)=>{
      if(!ws || ws.readyState!==1) return reject(new Error('CodeBuddy 主进程尚未连接'));
      const id=++serial;
      const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CodeBuddy 主进程请求超时'));},15000);
      pending.set(id,{resolve,reject,timer});
      ws.send(JSON.stringify({id,method,params}));
    });
  }
  function close() {
    const old=ws; ws=null; service=null; sessionService=null;
    for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('CodeBuddy 主进程连接已关闭'));}
    pending.clear(); if(old) old.close();
  }
  async function connect() {
    if(ws?.readyState===1 && service) return;
    if(connecting) return connecting;
    connecting=(async()=>{
      const list=await (await fetch('http://127.0.0.1:'+profile.nativeDebugPort+'/json/list',{signal:AbortSignal.timeout(3000)})).json();
      const target=list.find(p=>p.type==='node');
      if(!target) throw new Error('未发现 CodeBuddy 主进程调试入口');
      const url=new URL(target.webSocketDebuggerUrl);
      if(url.protocol!=='ws:' || url.hostname!=='127.0.0.1' || Number(url.port)!==profile.nativeDebugPort) throw new Error('主进程调试地址无效');
      ws=new WebSocketCtor(url.href);
      await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('主进程连接超时')),3000);
        ws.onopen=()=>{clearTimeout(timer);resolve();};
        ws.onerror=()=>{clearTimeout(timer);reject(new Error('主进程连接失败'));};
      });
      const socket = ws;
      ws.onclose=()=>{if(ws !== socket)return; ws=null; service=null; sessionService=null; for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('CodeBuddy 已关闭'));}pending.clear();};
      ws.onmessage=event=>{
        let msg; try{msg=JSON.parse(event.data);}catch(_){return;}
        if(msg.method==='Debugger.paused' && pauseListener) pauseListener(msg.params);
        const p=pending.get(msg.id);if(!p)return;
        pending.delete(msg.id);clearTimeout(p.timer);
        msg.error?p.reject(new Error('CodeBuddy 调试请求失败')):p.resolve(msg.result);
      };
      const identity=await send('Runtime.evaluate',{expression:"(()=>{const e=process.getBuiltinModule('module').createRequire(process.execPath)('electron');return {exe:process.execPath,userData:e.app.getPath('userData')};})()",returnByValue:true});
      const found=identity.result?.value;
      const normalize=p=>{
        let resolved=path.resolve(p || '');
        try { resolved=fs.realpathSync(resolved); } catch (_) {}
        return process.platform==='win32' ? resolved.toLowerCase() : resolved;
      };
      const expectedExe=process.platform==='darwin'?path.join(profile.appPath,'Contents/MacOS/Electron'):profile.appPath;
      if(!found || !(process.platform==='win32' ? isCodeBuddyBinary(found.exe,profile.id) : normalize(found.exe)===normalize(expectedExe)) || normalize(found.userData)!==normalize(profile.userDataRoot)) throw new Error('主进程不属于当前 CodeBuddy 安装或用户目录');
      service=await findAuthService(send);
    })().catch(error=>{close();throw new Error('无法连接 CodeBuddy 认证服务：'+error.message);}).finally(()=>{connecting=null;});
    return connecting;
  }
  async function call(fn,args=[],kind='auth') {
    await connect();
    if (kind === 'sessions' && !sessionService) {
      if(!sessionConnecting) sessionConnecting=findSessionService(send, listener=>{pauseListener=listener;})
        .then(id=>{sessionService=id;}).finally(()=>{sessionConnecting=null;});
      await sessionConnecting;
    }
    const result=await send('Runtime.callFunctionOn',{objectId:kind==='sessions'?sessionService:service,functionDeclaration:fn.toString(),arguments:args.map(value=>({value})),awaitPromise:true,returnByValue:true});
    // Never include exception descriptions: official errors can embed auth data.
    if(result.exceptionDetails) throw new Error('CodeBuddy 认证操作失败，原生服务未确认成功');
    return result.result?.value;
  }
  return {
    connect,close,
    sessionItems:()=>call(function(){return Array.from(this._sessions, ([id,value])=>({key:'session:'+id,value:JSON.stringify(value)}));},[],'sessions'),
    writeSessions:changes=>call(writeNativeSessions,[changes],'sessions'),
    read:()=>call(async function(){return (await this.getCurrentSessionAsync()) || null;}),
    replace:session=>call(replaceNativeSession,[session]),
    // Fake logout preserves the backed-up token; official logout may revoke it.
    logout:async()=>{await call(replaceNativeSession,[null]);return true;},
  };
}
module.exports={createCodeBuddyNative,findAuthService,replaceNativeSession,writeNativeSessions};
