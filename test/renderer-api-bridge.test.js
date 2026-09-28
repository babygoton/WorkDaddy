'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const vm = require('node:vm');
const { createRendererApiBridge, rendererBridgeSource, BINDING } = require('../scripts/renderer-api-bridge.js');

test('bridge forwards authenticated API reads/writes and binary exports to loopback only', async t => {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      requests.push({url:req.url, method:req.method, token:req.headers['x-workdaddy-token'], body:Buffer.concat(chunks).toString()});
      res.writeHead(200, {'content-type':'application/octet-stream', 'x-workdaddy-count':'2'});
      res.end(Buffer.from([0,255,42]));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const replies=[];
  const bridge=createRendererApiBridge({token:'secret',port:()=>server.address().port,send:async (method,params)=>replies.push(params)});
  const call = payload => bridge({name:BINDING,executionContextId:7,payload:JSON.stringify(payload)});
  await call({id:'a:1',token:'secret',path:'/api/models/backup',method:'POST',body:'{"index":0}'});
  assert.deepEqual(requests,[{url:'/api/models/backup',method:'POST',token:'secret',body:'{"index":0}'}]);
  let response;
  vm.runInNewContext(replies[0].expression,{window:{__wbsApiBridgeReply:r=>response=r}});
  assert.equal(replies[0].contextId,7);
  assert.equal(response.body,'AP8q');
  assert.equal(response.count,2);
  for (const path of ['https://example.com/api/x','//example.com/api/x','/api/../secret','/api/%2e%2e/secret','/api/x#fragment']) {
    await call({id:'a:2',token:'secret',path,method:'GET'});
  }
  await call({id:'a:3',token:'wrong',path:'/api/models',method:'GET'});
  assert.equal(requests.length,1);
});

test('renderer transport handles errors/binary and rejects outstanding work on reinjection', async () => {
  let sent;
  const timers=new Map(); let next=0;
  const win={ [BINDING]:value=>{sent=JSON.parse(value);} };
  const ctx={window:win,Map,Promise,Error,Uint8Array,Blob,atob,btoa,crypto:require('node:crypto').webcrypto,
    setTimeout:fn=>{timers.set(++next,fn);return next;},clearTimeout:id=>timers.delete(id)};
  vm.runInNewContext(rendererBridgeSource(),ctx);
  const pending=win.__wbsApiFetch('/api/models',{method:'GET'},'secret');
  win.__wbsApiBridgeReply({id:sent.id,status:403,body:Buffer.from('{"ok":false,"error":"denied"}').toString('base64')});
  const res=await pending;
  assert.equal(res.ok,false);
  assert.equal((await res.json()).error,'denied');
  const old=win.__wbsApiFetch('/api/models',{},'secret');
  const rejected=assert.rejects(old,/重新加载/);
  vm.runInNewContext(rendererBridgeSource(),ctx);
  await rejected;
  assert.equal(timers.size,0);
});

test('bridge accepts binary imports and DELETE while rejecting unexpected headers or verbs', async t => {
  const requests = [];
  const server = http.createServer((req,res) => {
    const chunks=[]; req.on('data',c=>chunks.push(c));
    req.on('end',()=>{requests.push({method:req.method,type:req.headers['content-type'],body:Buffer.concat(chunks)});res.end('{}');});
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r)); t.after(()=>server.close());
  const bridge=createRendererApiBridge({token:'fixture',port:()=>server.address().port,send:async()=>{}});
  const call=x=>bridge({name:BINDING,executionContextId:1,payload:JSON.stringify({id:'a',token:'fixture',path:'/api/sessions/import',...x})});
  await call({method:'POST',body:'AP8q',encoding:'base64',contentType:'application/octet-stream'});
  await call({method:'DELETE',path:'/api/custom-wallpapers?name=fixture'});
  await call({method:'CONNECT'}); await call({method:'POST',contentType:'x\r\nevil:yes'});
  assert.equal(requests.length,2);
  assert.deepEqual(requests[0].body,Buffer.from([0,255,42]));
  assert.equal(requests[0].type,'application/octet-stream');assert.equal(requests[1].method,'DELETE');
});

test('binary imports stream bounded chunks and reject a different renderer context',async t=>{
  let received=0;
  const server=http.createServer((req,res)=>{req.on('data',b=>received+=b.length);req.on('end',()=>res.end('{"ok":true}'));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
  const replies=[];
  const bridge=createRendererApiBridge({token:'fixture',port:()=>server.address().port,send:async(_,p)=>vm.runInNewContext(p.expression,{window:{__wbsApiBridgeReply:r=>replies.push(r)}})});
  let serial=0;
  const call=(payload,context=1)=>bridge({name:BINDING,executionContextId:context,payload:JSON.stringify({id:'chunk:'+(++serial),token:'fixture',...payload})});
  await call({kind:'upload-start',uploadId:'upload',path:'/api/sessions/import',method:'POST',contentType:'application/octet-stream',totalBytes:6});
  assert.equal(replies.at(-1).status,204);
  await call({kind:'upload-chunk',uploadId:'upload',offset:0,body:'YWJj'},2);
  assert.ok(replies.at(-1).error);
  await call({kind:'upload-chunk',uploadId:'upload',offset:0,body:'YWJj'});
  await call({kind:'upload-chunk',uploadId:'upload',offset:3,body:'ZGVm'});
  await call({kind:'upload-end',uploadId:'upload'});
  assert.equal(received,6);assert.equal(replies.at(-1).status,200);
  assert.deepEqual(JSON.parse(Buffer.from(replies.at(-1).body,'base64')), {ok:true});
});

test('renderer Blob import never loads the whole archive and returns the real route response',async t=>{
  let received=0;
  const server=http.createServer((req,res)=>{req.on('data',c=>received+=c.length);req.on('end',()=>res.end('{"imported":1}'));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
  const win={},ctx={window:win,Map,Promise,Error,Uint8Array,Blob,atob,btoa,crypto:require('node:crypto').webcrypto,setTimeout,clearTimeout};
  const chunks=[];
  const bridge=createRendererApiBridge({token:'fixture',port:()=>server.address().port,send:async(_,p)=>vm.runInNewContext(p.expression,ctx)});
  win[BINDING]=payload=>{const request=JSON.parse(payload);if(request.kind==='upload-chunk')chunks.push(Buffer.from(request.body,'base64').length);bridge({name:BINDING,executionContextId:1,payload});};
  vm.runInNewContext(rendererBridgeSource(),ctx);
  const blob=new Blob([new Uint8Array(600000)]);blob.arrayBuffer=()=>{throw Error('must slice');};
  const response=await win.__wbsApiFetch('/api/sessions/import',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:blob},'fixture');
  assert.equal((await response.json()).imported,1);assert.equal(received,600000);
  assert.ok(chunks.length===3 && chunks.every(size=>size<=262144));
});
