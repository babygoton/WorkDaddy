'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const p = require('../scripts/persona');
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wd-sharing-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { dataRoot: path.join(root, 'client'), backupRoot: path.join(root, 'plugin'), currentUid: 'a', accounts: [{uid:'a'}, {uid:'b'}] };
  const file = (uid, name) => path.join(p.personaDir(options.dataRoot, uid), name);
  const write = (uid, name, text) => { fs.mkdirSync(path.dirname(file(uid,name)), {recursive:true}); fs.writeFileSync(file(uid,name),text); };
  for (const uid of ['a','b']) for (const name of ['IDENTITY.md','USER.md','SOUL.md']) write(uid,name,uid + name);
  write('b','workspace-state.json',JSON.stringify({custom:42}));
  const enable = () => p.configurePersona({...options,mode:'shared',sourceUid:'a',revision:p.listPersonaSources(options)[0].revision});
  return {options,file,write,enable};
}
test('dismissal persists without selecting a mode and can later enable sharing', t => {
  const f=fixture(t);
  p.dismissPersonaNotice(f.options.backupRoot);
  assert.deepEqual(p.readPersonaSettings(f.options.backupRoot),{mode:'unset',noticeDismissed:true,activeUid:null});
  f.enable();
  assert.equal(p.readPersonaSettings(f.options.backupRoot).mode,'shared');
});
test('a redirected backup root supports unset settings, sharing and rollback without following inner links', t => {
  const f = fixture(t);
  const actualRoot = f.options.backupRoot;
  fs.mkdirSync(actualRoot);
  const alias = actualRoot + '-alias';
  fs.symlinkSync(actualRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
  f.options.backupRoot = alias;
  assert.equal(p.readPersonaSettings(alias).mode, 'unset');
  assert.equal(p.syncSharedPersonaForSwitch({ ...f.options, sourceUid: 'a', targetUid: 'b' }).skipped, true);
  f.enable();
  f.write('a', 'USER.md', 'updated');
  const prepared = p.syncSharedPersonaForSwitch({ ...f.options, sourceUid: 'a', targetUid: 'b' });
  assert.equal(fs.readFileSync(f.file('b', 'USER.md'), 'utf8'), 'updated');
  prepared.rollback();
  assert.equal(fs.readFileSync(f.file('b', 'USER.md'), 'utf8'), 'bUSER.md');
  const outside = path.join(path.dirname(actualRoot), 'outside');
  fs.mkdirSync(outside);
  fs.rmSync(path.join(actualRoot, 'persona', 'shared'), { recursive: true });
  fs.symlinkSync(outside, path.join(actualRoot, 'persona', 'shared'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => p.syncSharedPersonaForSwitch({ ...f.options, sourceUid: 'a', targetUid: 'b' }), /符号链接/);
  assert.deepEqual(fs.readdirSync(outside), []);
});
test('a not-yet-created backup root beneath a redirected parent can initialize settings', t => {
  const f = fixture(t);
  const actualRoot = f.options.backupRoot;
  fs.mkdirSync(actualRoot);
  const alias = actualRoot + '-alias';
  fs.symlinkSync(actualRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const nested = path.join(alias, 'new', 'profile');
  assert.equal(p.readPersonaSettings(nested).mode, 'unset');
  p.dismissPersonaNotice(nested);
  assert.equal(p.readPersonaSettings(path.join(actualRoot, 'new', 'profile')).noticeDismissed, true);
});
test('shared A edits reach B; B edits and optional memory deletion reach A, preserving state', t => {
  const f=fixture(t); f.enable();
  f.write('a','MEMORY.md','new A memory');
  p.syncSharedPersonaForSwitch({...f.options,sourceUid:'a',targetUid:'b'});
  assert.equal(fs.readFileSync(f.file('b','MEMORY.md'),'utf8'),'new A memory');
  assert.equal(JSON.parse(fs.readFileSync(f.file('b','workspace-state.json'))).custom,42);
  f.write('b','USER.md','edited B'); fs.unlinkSync(f.file('b','MEMORY.md'));
  p.syncSharedPersonaForSwitch({...f.options,sourceUid:'b',targetUid:'a'});
  assert.equal(fs.readFileSync(f.file('a','USER.md'),'utf8'),'edited B');
  assert.equal(fs.existsSync(f.file('a','MEMORY.md')),false);
  assert.equal(fs.readFileSync(path.join(p.sharedPersonaDir(f.options.backupRoot),'USER.md'),'utf8'),'edited B');
});
test('independent mode leaves other account untouched; re-enabling asks for a fresh source', t => {
  const f=fixture(t); f.enable(); p.configurePersona({...f.options,mode:'independent'});
  f.write('a','USER.md','private');
  assert.equal(p.syncSharedPersonaForSwitch({...f.options,sourceUid:'a',targetUid:'b'}).skipped,true);
  assert.equal(fs.readFileSync(f.file('b','USER.md'),'utf8'),'bUSER.md');
  assert.throws(()=>p.configurePersona({...f.options,mode:'shared'}),/来源/);
});
test('stale selection, unknown account, external login and symlinks fail before replacement', t => {
  const f=fixture(t); const revision=p.listPersonaSources(f.options)[0].revision;
  f.write('a','USER.md','changed');
  assert.throws(()=>p.configurePersona({...f.options,mode:'shared',sourceUid:'a',revision}),/变化/);
  assert.throws(()=>p.configurePersona({...f.options,mode:'shared',sourceUid:'unknown'}),/来源/);
  f.enable();
  assert.throws(()=>p.syncSharedPersonaForSwitch({...f.options,sourceUid:'b',targetUid:'a'}),/账号已变化/);
  const before=fs.readFileSync(f.file('b','USER.md'),'utf8');
  fs.symlinkSync(f.file('a','USER.md'),f.file('b','MEMORY.md'));
  assert.throws(()=>p.syncSharedPersonaForSwitch({...f.options,sourceUid:'a',targetUid:'b'}),/符号链接/);
  assert.equal(fs.readFileSync(f.file('b','USER.md'),'utf8'),before);
});
test('failed transaction restores canonical, target and settings; switch failure can undo prepared sharing', t => {
  const f=fixture(t); f.enable(); f.write('a','USER.md','new');
  const before=fs.readFileSync(f.file('b','USER.md'),'utf8'); let writes=0;
  const replace = require('../scripts/atomic-file-write').replaceFileWithRetry;
  assert.throws(()=>p.syncSharedPersonaForSwitch({...f.options,sourceUid:'a',targetUid:'b',replaceFile:(...args)=>{
    if(++writes===2) throw new Error('disk failed');
    return replace(...args);
  }}),/disk failed/);
  assert.equal(fs.readFileSync(f.file('b','USER.md'),'utf8'),before);
  assert.equal(fs.readFileSync(path.join(p.sharedPersonaDir(f.options.backupRoot),'USER.md'),'utf8'),'aUSER.md');
  assert.equal(p.readPersonaSettings(f.options.backupRoot).activeUid,'a');
  const prepared=p.syncSharedPersonaForSwitch({...f.options,sourceUid:'a',targetUid:'b'}); prepared.rollback();
  assert.equal(fs.readFileSync(f.file('b','USER.md'),'utf8'),before);
  assert.equal(p.readPersonaSettings(f.options.backupRoot).activeUid,'a');
});
test('edits arriving during backup abort sharing before canonical or destination changes', t => {
  const f=fixture(t); f.enable(); f.write('a','USER.md','before backup');
  const write=fs.writeFileSync;
  let changed=false;
  t.mock.method(fs,'writeFileSync',function(file,...args) {
    const result=write.call(fs,file,...args);
    if (!changed && String(file).includes(path.join('persona','backups'))) {
      changed=true;
      write.call(fs,f.file('a','USER.md'),'edited during backup');
    }
    return result;
  });
  assert.throws(()=>p.syncSharedPersonaForSwitch({...f.options,sourceUid:'a',targetUid:'b'}),/来源个性化设置已变化/);
  assert.equal(changed,true);
  assert.equal(fs.readFileSync(f.file('a','USER.md'),'utf8'),'edited during backup');
  assert.equal(fs.readFileSync(f.file('b','USER.md'),'utf8'),'bUSER.md');
  assert.equal(fs.readFileSync(path.join(p.sharedPersonaDir(f.options.backupRoot),'USER.md'),'utf8'),'aUSER.md');
  assert.equal(p.readPersonaSettings(f.options.backupRoot).activeUid,'a');
});
test('invalid settings never replace a previously saved preference', t => {
  const f=fixture(t); p.dismissPersonaNotice(f.options.backupRoot);
  assert.throws(()=>p.writePersonaSettings(f.options.backupRoot,{mode:'shared',noticeDismissed:true,activeUid:'../a'}),/设置无效/);
  assert.deepEqual(p.readPersonaSettings(f.options.backupRoot),{mode:'unset',noticeDismissed:true,activeUid:null});
});
test('source picker lists every account, explains unavailable accounts, and names the pre-upgrade settings', t => {
  const f=fixture(t);
  fs.rmSync(path.dirname(f.file('b','USER.md')),{recursive:true});
  for(const name of ['IDENTITY.md','USER.md','SOUL.md']) fs.writeFileSync(path.join(f.options.dataRoot,name),'before upgrade '+name);
  const sources=p.listPersonaSources(f.options);
  assert.deepEqual(sources.map(s=>s.uid),['a','b','legacy']);
  assert.equal(sources[0].available,true);
  assert.equal(sources[1].available,false);
  assert.equal(sources[1].unavailableReason,'未设置');
  assert.equal(sources[1].revision,undefined);
  assert.equal(sources[2].nickname,'升级前共用的设置');
  assert.equal(sources[2].available,true);
  assert.throws(()=>p.configurePersona({...f.options,mode:'shared',sourceUid:'b',revision:sources[0].revision}),/来源/);
  assert.equal(JSON.stringify(sources).includes('before upgrade'),false);
});
