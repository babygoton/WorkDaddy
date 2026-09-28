'use strict';

// CDP transport for sandboxed Electron pages. Routes still pass through the
// daemon's existing authentication, validation and handlers; no CSP changes.
const http = require('node:http');
const crypto = require('node:crypto');
const BINDING = '__wbsLocalApiRequest';
const MAX_BYTES = 64 * 1024 * 1024;

function createRendererApiBridge({ token, port, send }) {
  let active = 0;
  const uploads = new Map();
  function openRequest(path, method, contentType, size) {
    let req;
    const result = new Promise((resolve, reject) => {
      req = http.request({hostname:'127.0.0.1',port:port(),path,method,
        headers:{'X-WorkDaddy-Token':token,'Content-Type':contentType,'Content-Length':size}}, res => {
        const chunks=[]; let received=0;
        res.on('data', chunk => {
          received+=chunk.length;
          if(received>MAX_BYTES) {res.destroy();reject(new Error('本地 API 响应过大'));}
          else chunks.push(chunk);
        });
        res.on('error',reject);
        res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString('base64'),
          contentType:String(res.headers['content-type'] || ''),count:Number(res.headers['x-workdaddy-count'] || 0)}));
      });
      req.setTimeout(120000,()=>req.destroy(new Error('本地 API 请求超时')));
      req.on('error',reject);
    });
    result.catch(()=>{});
    return {req,result};
  }
  function closeUpload(id) {
    const upload=uploads.get(id);
    if(!upload)return;
    uploads.delete(id);clearTimeout(upload.timer);active--;
    upload.req.destroy();
  }
  return async function handleBinding(params) {
    if (params.name !== BINDING || !Number.isInteger(params.executionContextId)) return;
    let request;
    try { request = JSON.parse(params.payload); } catch (_) { return; }
    if (!request || typeof request.id !== 'string' || !/^[\w:-]{1,100}$/.test(request.id)) return;
    const supplied = Buffer.from(String(request.token || ''));
    const expected = Buffer.from(token);
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return;
    const reply = value => send('Runtime.evaluate', {
      contextId: params.executionContextId,
      expression: 'window.__wbsApiBridgeReply && window.__wbsApiBridgeReply(' + JSON.stringify({id:request.id,...value}) + ')',
      returnByValue: false,
    }).catch(() => {}); // navigation destroys pending calls with their old context
    if (['upload-chunk','upload-end','upload-cancel'].includes(request.kind)) {
      const upload=uploads.get(request.uploadId);
      if(!upload || upload.context!==params.executionContextId || upload.writing) {await reply({error:'上传任务不存在或正在处理'});return;}
      try {
        upload.writing=true;
        if(request.kind==='upload-cancel') {closeUpload(request.uploadId);await reply({status:204});return;}
        if(request.kind==='upload-end') {
          if(upload.offset!==upload.total)throw new Error('上传长度不匹配');
          upload.req.end();
          const result=await upload.result;
          await reply(result);closeUpload(request.uploadId);return;
        }
        if(request.offset!==upload.offset || typeof request.body!=='string' || request.body.length>350000 ||
           !/^[A-Za-z0-9+/]*={0,2}$/.test(request.body))throw new Error('上传分片无效');
        const chunk=Buffer.from(request.body,'base64');
        if(!chunk.length || chunk.length>262144 || upload.offset+chunk.length>upload.total)throw new Error('上传分片过大');
        await new Promise((resolve,reject)=>upload.req.write(chunk,error=>error?reject(error):resolve()));
        upload.offset+=chunk.length;upload.writing=false;
        clearTimeout(upload.timer);upload.timer=setTimeout(()=>closeUpload(request.uploadId),120000);upload.timer.unref();
        await reply({status:204});
      } catch (_) {closeUpload(request.uploadId);await reply({error:'会话上传失败，请重新导入'});}
      return;
    }
    const path = request.path;
    const method = request.method || 'GET';
    const encoded = request.body == null ? '' : request.body;
    const contentType = request.contentType || 'application/json';
    const validEncoding = request.encoding == null || request.encoding === 'base64';
    const body = typeof encoded === 'string' ? Buffer.from(encoded, request.encoding === 'base64' ? 'base64' : 'utf8') : null;
    let url;
    try { url = new URL(path, 'http://127.0.0.1'); } catch (_) {}
    if (typeof path !== 'string' || !/^\/api\/[A-Za-z0-9_/-]+(?:\?[^#\r\n]*)?$/.test(path) ||
        !url || url.origin !== 'http://127.0.0.1' || !url.pathname.startsWith('/api/') ||
        !['GET','POST','DELETE'].includes(method) || !body || !validEncoding ||
        !['application/json','application/octet-stream'].includes(contentType) || encoded.length > MAX_BYTES * 1.4 || body.length > MAX_BYTES || active >= 32) {
      await reply({error:'本地 API 请求无效或过多'}); return;
    }
    if (request.kind==='upload-start') {
      if(path!=='/api/sessions/import' || method!=='POST' || contentType!=='application/octet-stream' ||
         typeof request.uploadId!=='string' || !/^[\w:-]{1,100}$/.test(request.uploadId) || uploads.has(request.uploadId) ||
         !Number.isSafeInteger(request.totalBytes) || request.totalBytes<=0) {await reply({error:'上传请求无效'});return;}
      const opened=openRequest(path,method,contentType,request.totalBytes);
      const upload={...opened,total:request.totalBytes,offset:0,writing:false,context:params.executionContextId};
      upload.timer=setTimeout(()=>closeUpload(request.uploadId),120000);upload.timer.unref();
      active++;uploads.set(request.uploadId,upload);
      await reply({status:204});return;
    }
    if(request.kind) {await reply({error:'请求类型无效'});return;}
    active++;
    try {
      const opened=openRequest(path,method,contentType,body.length);
      opened.req.end(body);
      await reply(await opened.result);
    } catch (_) { await reply({error:'本地 API 请求失败'}); }
    finally { active--; }
  };
}

function installRendererBridge(binding) {
  if (window.__wbsApiBridgeDispose) window.__wbsApiBridgeDispose();
  var pending = new Map(), serial = 0, prefix = crypto.randomUUID();
  window.__wbsApiBridgeDispose = function () {
    pending.forEach(function (entry) { clearTimeout(entry.timer); entry.reject(new Error('面板已重新加载')); });
    pending.clear();
  };
  window.__wbsApiBridgeReply = function (reply) {
    var entry = pending.get(reply.id);
    if (!entry) return;
    pending.delete(reply.id); clearTimeout(entry.timer);
    if (reply.error) { entry.reject(new Error(reply.error)); return; }
    var bytes = Uint8Array.from(atob(reply.body || ''), function (ch) { return ch.charCodeAt(0); });
    var blob = new Blob([bytes], {type:reply.contentType || 'application/octet-stream'});
    entry.resolve({ok:reply.status >= 200 && reply.status < 300,
      json:function () { return blob.text().then(JSON.parse); }, blob:function () { return Promise.resolve(blob); },
      headers:{get:function (key) { return key.toLowerCase() === 'x-workdaddy-count' ? String(reply.count || 0) : null; }}});
  };
  function transmit(request, token) {
    return new Promise(function (resolve,reject) {
      var id=prefix+':'+(++serial);
      var timer=setTimeout(function(){pending.delete(id);reject(new Error('本地 API 请求超时'));},125000);
      pending.set(id,{resolve:resolve,reject:reject,timer:timer});
      try {window[binding](JSON.stringify(Object.assign({},request,{id:id,token:token})));}
      catch (_) {pending.delete(id);clearTimeout(timer);reject(new Error('本地 API 尚未连接'));}
    });
  }
  window.__wbsApiFetch = async function (path, options, token) {
    options=options || {};
    var body=options.body;
    var contentType=options.headers && (options.headers['content-type'] || options.headers['Content-Type']);
    var request={path:path,method:options.method || 'GET',contentType:contentType};
    if(body instanceof Blob && path==='/api/sessions/import') {
      var uploadId=prefix+':upload:'+(++serial);
      await transmit(Object.assign({},request,{kind:'upload-start',uploadId:uploadId,totalBytes:body.size}),token);
      try {
        for(var offset=0;offset<body.size;offset+=262144) {
          var bytes=new Uint8Array(await body.slice(offset,offset+262144).arrayBuffer()),parts=[];
          for(var i=0;i<bytes.length;i+=16384)parts.push(String.fromCharCode.apply(null,bytes.subarray(i,i+16384)));
          await transmit({kind:'upload-chunk',uploadId:uploadId,offset:offset,body:btoa(parts.join(''))},token);
        }
        return await transmit({kind:'upload-end',uploadId:uploadId},token);
      } catch(error) {transmit({kind:'upload-cancel',uploadId:uploadId},token).catch(function(){});throw error;}
    }
    return transmit(Object.assign({},request,{body:body}),token);
  };
}

function rendererBridgeSource() { return '(' + installRendererBridge.toString() + ')(' + JSON.stringify(BINDING) + ');\n'; }
module.exports = { BINDING, createRendererApiBridge, rendererBridgeSource };
