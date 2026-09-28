 'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const {PROFILES}=require('../scripts/profiles');
const {rendererBridgeSource}=require('../scripts/renderer-api-bridge');
const inject=fs.readFileSync(path.join(__dirname,'../scripts/inject.js'),'utf8');
const daemon=fs.readFileSync(path.join(__dirname,'../scripts/daemon.js'),'utf8');
test('CodeBuddy keeps accounts, sessions and models but disables composer enhancements and glass takeover',()=>{
  for(const id of ['codebuddy-cn','codebuddy-intl']) {
    const c=PROFILES[id].capabilities;
    for(const key of ['accounts','sessions','models','theme']) assert.equal(c[key],true);
    assert.equal(c.themeTakeover,false);assert.equal(c.enhance,false);assert.equal(c.nativeComposer,true);assert.equal(c.stashPrompt,false);
    assert.equal(c.sessionsReadOnly,undefined);assert.equal(c.modelsReadOnly,undefined);
    assert.equal(c.apiTransport,'cdp');assert.equal(c.panelAppearance,'light');assert.equal(c.robotStyle,'black');
  }
  assert.doesNotMatch(inject,/WBS_CODEBUDDY_BOOTSTRAP|CAPS\.sessionsReadOnly|CAPS\.modelsReadOnly/);
  assert.match(inject,/CAPS\.enhance === false/);
  assert.match(inject,/themeSwitch\.disabled = true/);
  assert.match(inject,/window\.__wbsApiFetch\(path, request, WBS_API_TOKEN\)/);
});
test('CodeBuddy injection compiles with all shared pages and the CSP-compatible bridge',()=>{
  const start=daemon.indexOf('function buildInjectScript()');
  const end=daemon.indexOf('function injectWidgetManual()',start);
  const ctx=vm.createContext({fs,path,__dirname:path.join(__dirname,'../scripts'),PROFILE:PROFILES['codebuddy-cn'],rendererBridgeSource,
    HOST:'127.0.0.1',ACTUAL_PORT:47834,DAEMON_VERSION:'test',API_TOKEN:'fixture',diagnosticsEnabled:()=>false,process});
  vm.runInContext(daemon.slice(start,end),ctx);
  const script=ctx.buildInjectScript();new vm.Script(script);
  assert.ok(script.includes('CodeDaddy CN'));assert.ok(script.includes('root.__wbsHTML ='));
  assert.ok(script.includes('__wbsLocalApiRequest'));
});
test('CodeBuddy HTML compatibility keeps the official innerHTML sink unchanged', () => {
  const start = daemon.indexOf("  const trustedTypesBootstrap =");
  const end = daemon.indexOf("  let source =", start);
  const bootstrap = new Function('PROFILE', daemon.slice(start, end) + 'return trustedTypesBootstrap;')(PROFILES['codebuddy-cn']);
  class Element {}
  const nativeSet = function (html) { if (!html || !html.trusted) throw Error('TrustedHTML required'); this.html = html.value; };
  const adjacent = function (position, html) { nativeSet.call(this,html); this.position=position; };
  Element.prototype.insertAdjacentHTML=adjacent;
  Object.defineProperty(Element.prototype, 'outerHTML', {configurable:true,set:nativeSet,get(){return this.html;}});
  Object.defineProperty(Element.prototype, 'innerHTML', {configurable: true, set: nativeSet, get() {return this.html;}});
  const ctx = vm.createContext({Element, window: {}, trustedTypes: {createPolicy: () => ({createHTML:value=>({trusted:true,value})})}});
  vm.runInContext(bootstrap, ctx);
  vm.runInContext(bootstrap, ctx);
  assert.equal(Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML').set, nativeSet);
  const el = new Element(); el.__wbsHTML = '<b>escaped template</b>';
  assert.equal(el.innerHTML, '<b>escaped template</b>');
  el.__wbsOuterHTML='<span>updated</span>'; assert.equal(el.outerHTML,'<span>updated</span>');
  el.__wbsInsertAdjacentHTML('beforeend','<span>inserted</span>'); assert.equal(el.position,'beforeend');
  assert.equal(Element.prototype.insertAdjacentHTML,adjacent);
  assert.throws(()=>{el.innerHTML='raw';},/TrustedHTML/);
  assert.throws(()=>{el.outerHTML='raw';},/TrustedHTML/);
  assert.throws(()=>el.insertAdjacentHTML('beforeend','raw'),/TrustedHTML/);
});


test('updates select only the matching brand and prefer Setup over historical ZIP',()=>{
  const start=daemon.indexOf('function selectUpdateAsset('),end=daemon.indexOf('function makeUpdateCandidate(',start);
  const source={downloadRoot:'https://example.test/releases'};
  const names=['WorkDaddy','WorkDaddy-AI','CodeDaddy-CN','CodeDaddy'];
  const assets=names.flatMap(n=>[n+'-1.2.191.dmg',n+'-1.2.191-win64.zip',n+'-Setup-1.2.191.exe']).map(name=>({name,browser_download_url:source.downloadRoot+'/'+name}));
  for(const profile of Object.values(PROFILES))for(const windows of [true,false]){
    const context={PROFILE:profile,IS_WIN:windows};vm.runInNewContext(daemon.slice(start,end),context);
    assert.equal(context.selectUpdateAsset(source,{assets}).name,profile.packageName+(windows?'-Setup-1.2.191.exe':'-1.2.191.dmg'));
    assert.equal(context.selectUpdateAsset(source,{assets:assets.filter(a=>a.name!==profile.packageName+'-1.2.191.dmg' && !a.name.startsWith(profile.packageName+'-Setup-') && a.name!==profile.packageName+'-1.2.191-win64.zip')}),null);
  }
});

test('CodeBuddy Windows binaries are separated by official product metadata, not shared executable name',t=>{
  const {isCodeBuddyBinary}=require('../scripts/profiles');
  const os=require('node:os');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codedaddy-product-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'resources','app'),{recursive:true});
  const exe=path.join(root,'CodeBuddy.exe');fs.writeFileSync(exe,'fixture');
  assert.equal(isCodeBuddyBinary(exe,'codebuddy-cn'),false);
  fs.writeFileSync(path.join(root,'resources','app','product.json'),JSON.stringify({applicationName:'buddycn'}));
  assert.equal(isCodeBuddyBinary(exe,'codebuddy-cn'),true);
  assert.equal(isCodeBuddyBinary(exe,'codebuddy-intl'),false);
});

test('CodeBuddy waits for page load rather than mounting into the disposable bootstrap body',async()=>{
  const start=daemon.indexOf('async function injectWidget(reason, executionContextId)');
  const end=daemon.indexOf('\nfunction buildInjectScript()',start);
  const inject=vm.runInNewContext('('+daemon.slice(start,end)+')',{PROFILE:{kind:'codebuddy'},cdp:{connected:true}});
  const result=await inject('reload-context',1);
  assert.equal(result.mounted,false);
});

test('CodeBuddy relaunch helpers accept only the matching installation, including encoded spaces', () => {
  const {spawnSync} = require('node:child_process');
  for (const [file, name, binary, own, sibling] of [
    ['relaunch-with-cdp.sh', 'is_workbuddy_cdp', '/Applications/CodeBuddy CN.app/Contents/MacOS/Electron', '/Applications/CodeBuddy%20CN.app/Contents/Resources/app/agentManager.html', '/Applications/CodeBuddy.app/Contents/Resources/app/agentManager.html'],
    ['relaunch-with-cdp-linux.sh', 'is_profile_cdp', '/opt/CodeBuddy CN/codebuddy', '/opt/CodeBuddy%20CN/resources/app/agentManager.html', '/opt/CodeBuddy/resources/app/agentManager.html'],
  ]) {
    const source = fs.readFileSync(path.join(__dirname, '../scripts', file), 'utf8');
    const fn = source.slice(source.indexOf(name + '() {')).split('\n}\n')[0] + '\n}';
    for (const [url, expected] of [[own, 0], [sibling, 1]]) {
      const shell = `PROFILE=codebuddy-cn\nAPP_BIN='${binary}'\nAPP_NAME='CodeBuddy CN'\ncurl() { printf '%s' '${JSON.stringify([{url}])}'; }\ncurl_local() { curl; }\n${fn}\n${name} 9224`;
      assert.equal(spawnSync('bash', ['-c', shell]).status, expected, file + ': ' + url);
    }
  }
});

test('macOS uninstall limits launchd removal to selected profile and legacy cleanup to WorkBuddy CN', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/uninstall.sh'), 'utf8');
  assert.match(source, /for old_profile in "\$PROFILE"/);
  assert.match(source, /if \[ "\$PROFILE" = workbuddy-cn \]; then/);
});

test('native panel mount survives body replacement, restores the same node, and disposes observers', () => {
  const match=inject.match(/function preserveNativePanelMount\(doc, root, Observer\) \{[\s\S]*?\n\}/);
  assert.ok(match, 'mount lifecycle helper exists');
  const preserve=vm.runInNewContext('('+match[0]+')');
  const observers=[];
  class Observer { constructor(fn){this.fn=fn;this.targets=[];observers.push(this);} observe(target,options){assert.equal(options.subtree,undefined);this.targets.push(target);} disconnect(){this.targets=[];} }
  const root={isConnected:true};
  const body=()=>({appendChild(node){assert.equal(node,root);node.isConnected=true;this.count=(this.count||0)+1;}});
  const doc={documentElement:{},body:body()};
  const dispose=preserve(doc,root,Observer);
  root.isConnected=false;observers[0].fn();assert.equal(doc.body.count,1);
  doc.body=body();root.isConnected=false;observers[1].fn();assert.equal(doc.body.count,1);
  assert.ok(observers[0].targets.includes(doc.body));
  observers[1].fn();assert.equal(doc.body.count,1);
  dispose();root.isConnected=false;observers[1].fn();assert.equal(root.isConnected,false);
  assert.ok(observers.every(x=>x.targets.length===0));
});

test('native overlay mounts restore prebuilt account popovers along with the panel', () => {
  const match=inject.match(/function preserveNativePanelMount\(doc, root, Observer\) \{[\s\S]*?\n\}/);
  const preserve=vm.runInNewContext('('+match[0]+')');const observers=[];
  class Observer {constructor(fn){this.fn=fn;observers.push(this);}observe(){}disconnect(){}}
  const body=()=>({appendChild(n){n.isConnected=true;}});
  const doc={body:body(),documentElement:{}},root={isConnected:true},popup={isConnected:false};
  const dispose=preserve(doc,root,Observer);assert.equal(typeof dispose.keep,'function');dispose.keep(popup);
  root.isConnected=false;popup.isConnected=false;doc.body=body();observers[1].fn();
  assert.ok(root.isConnected&&popup.isConnected);
  dispose();popup.isConnected=false;observers[0].fn();assert.equal(popup.isConnected,false);
});

test('CN retains real growth and streak controls and panel identity is separate from package branding', () => {
  assert.equal(PROFILES['codebuddy-cn'].capabilities.growthDaily,true);
  assert.match(inject,/WBS_PANEL_TITLE/);
  assert.match(inject,/' for ' \+ WBS_BRAND/);
});

test('CN streak refresh uses the same capability as the account growth panel', async () => {
  const start=daemon.indexOf("  if (req.method === 'POST' && p === '/api/growth/streak')");
  const end=daemon.indexOf('  // 查询指定账号今日是否活跃',start);
  const handle=new Function('req','p','res','readBody','PROFILE','fs','accountBackupFile','growthStreakCache','json',daemon.slice(start,end));
  const result=await handle({method:'POST'},'/api/growth/streak',{},async()=>({uid:'fixture'}),PROFILES['codebuddy-cn'],{existsSync:()=>true},()=>'/fixture',{get:async()=>({days:2})},(_,status,body)=>({status,body}));
  assert.equal(result.status,200);assert.equal(result.body.activityStreak.days,2);
});
