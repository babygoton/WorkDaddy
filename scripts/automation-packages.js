'use strict';

// Provider-neutral, pure preview. This module never downloads, installs or runs a task.
const crypto = require('node:crypto');
const { validateTask, CAPABILITIES } = require('./automation');
const { stableVersion, versionAtLeast, validateRequirements, assessRequirements } = require('./automation-compatibility');
const PACKAGE_KIND = 'workdaddy.automation-package';
const PACKAGE_FORMAT_VERSION = 1;
const MAX_BYTES = 1024 * 1024;
const KNOWN_FIELDS = new Set(['kind','formatVersion','id','version','name','description','author','license','tags','requires','inputs','task']);
const NAME = /^[A-Za-z_][\w-]{0,79}$/;
const unsafeName = value => ['__proto__','constructor','prototype'].includes(value);
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' must be an object');
  return value;
}
function fields(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.has(key) && !/^x-[a-z0-9][a-z0-9.-]*$/.test(key)) throw new Error(label + ': unsupported field ' + key);
}
function strings(value, label, max=100) {
  if (!Array.isArray(value) || value.length>max || value.some(v=>typeof v!=='string'||!v.trim()||v.length>200)) throw new Error(label + ' must be a bounded string array');
  return [...new Set(value)];
}
function readDocument(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(typeof input === 'string' ? input : JSON.stringify(input));
  if (!bytes.length || bytes.length>MAX_BYTES) throw new Error('Package must contain at most 1 MiB of JSON');
  return { document: object(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,'')), 'Package'), sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}
function analyzeTask(task) {
  const capabilities = new Set(), effects = new Set(), origins = new Set();
  const walk = value => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') {
      const op = value.op;
      if (typeof op === 'string') {
        capabilities.add(op);
        if (op === 'account.forEach' && (value.switch === true || value.switchAccounts === true)) effects.add('account-switch');
        if (op === 'account.checkin') effects.add('account-checkin');
        if (/^session\.(create|send|sendCurrent)$/.test(op) || op === 'notify.afterAllTasks') effects.add('send-message');
        if (/^dom\.(click|type|clear|press)$/.test(op)) effects.add('page-input');
        if (/^state\.(set|checkpoint)$/.test(op)) effects.add('write-state');
        if (/^http\./.test(op)) {
          effects.add('network');
          if (op === 'http.requestAsAccount') effects.add('account-credentials');
          try { origins.add(new URL(value.url).origin); } catch (_) { origins.add('dynamic'); }
        }
      }
      if (['logic.sequence','logic.repeat','logic.retry','logic.catch','logic.forEach','logic.waitUntil','account.forEach'].includes(op)) walk(value.steps);
      if (op === 'logic.catch') walk(value.onError);
      if (op === 'logic.if') { walk(value.then); walk(value.else); }
      if (op === 'logic.switch') { Object.values(value.cases || {}).forEach(walk); walk(value.default); }
    }
  };
  walk([task.steps,task.onSuccess,task.onFailure]);
  const trigger = task.trigger || {};
  const types = Array.isArray(trigger.types) ? trigger.types : [trigger.type || 'manual'];
  types.filter(t=>t!=='manual').forEach(t=>capabilities.add('event.'+t));
  if (task.schedule && task.schedule.type !== 'manual') capabilities.add('event.schedule');
  return {capabilities:[...capabilities].sort(),effects:[...effects].sort(),origins:[...origins].sort()};
}
function bindInputs(definitions = {}, supplied = {}) {
  object(definitions,'inputs'); object(supplied,'values');
  if (Object.keys(definitions).length>40) throw new Error('Too many inputs');
  for (const key of Object.keys(supplied)) if (!Object.hasOwn(definitions,key)) throw new Error('Unknown input: '+key);
  const values = {}, missing = [];
  for (const [key,definition] of Object.entries(definitions)) {
    if (!NAME.test(key) || unsafeName(key)) throw new Error('Invalid input name');
    const d=object(definition,'input '+key);
    fields(d,new Set(['type','title','description','required','default','enum']),'input '+key);
    for(const key of ['title','description'])if(d[key]!=null&&(typeof d[key]!=='string'||d[key].length>500))throw new Error('Invalid input label');
    if (!['string','number','integer','boolean'].includes(d.type)) throw new Error('Unsupported input type');
    if (d.required != null && typeof d.required !== 'boolean') throw new Error('required must be boolean');
    if (d.enum != null && (!Array.isArray(d.enum)||!d.enum.length||d.enum.length>100)) throw new Error('Invalid input enum');
    const matches=v=>(d.type==='integer'?Number.isSafeInteger(v):d.type==='number'?typeof v==='number'&&Number.isFinite(v):typeof v===d.type) && (typeof v!=='string'||v.length<=6000);
    if (d.enum && !d.enum.every(matches)) throw new Error('Invalid input enum type');
    if (Object.hasOwn(d,'default') && (!matches(d.default)||d.enum&&!d.enum.includes(d.default))) throw new Error('Invalid input default');
    const hasValue = Object.hasOwn(supplied,key)||Object.hasOwn(d,'default');
    if (!hasValue) { if(d.required===true)missing.push(key); continue; }
    const value=Object.hasOwn(supplied,key)?supplied[key]:d.default;
    if(!matches(value)||d.enum&&!d.enum.includes(value))throw new Error('Invalid input value: '+key);
    values[key]=value;
  }
  return {values,missing};
}
function previewPackage(input, options = {}) {
  const {document,sha256} = readDocument(input);
  const runtime = options.runtime || {};
  const issues=[];
  const packaged = document.kind != null;
  const metadata = packaged ? {id:document.id,version:document.version} : null;
  const incompatible = code => ({kind:packaged?'package':'legacy-task',compatible:false,issues:[{code}],sha256,package:metadata,task:null,executed:false});
  if(packaged && document.kind!==PACKAGE_KIND)return incompatible('unsupported_package_kind');
  if(packaged && document.formatVersion!==PACKAGE_FORMAT_VERSION)return incompatible('unsupported_package_format');
  let task, requires={}, inputs={};
  if(packaged){
    fields(document,KNOWN_FIELDS,'package');
    if(typeof document.id!=='string'||document.id.length>160||!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(document.id))throw new Error('Package id must be namespaced, e.g. org.example.task');
    stableVersion(document.version);
    if(typeof document.name!=='string'||!document.name.trim()||document.name.length>120)throw new Error('Package name is required');
    for (const [key,max] of [['description',1000],['author',200],['license',100]]) if (document[key]!=null && (typeof document[key]!=='string'||document[key].length>max)) throw new Error('Invalid package metadata: '+key);
    if(document.tags)strings(document.tags,'tags',20);
    requires=validateRequirements(document.requires);
    task=object(document.task,'task');
    if((task.schemaVersion??1)!==requires.taskSchemaVersion)throw new Error('Task schema does not match requires');
    if (task.requires != null) throw new Error('Package requirements belong in the envelope only');
    inputs=document.inputs||{};
  }else { task=object(document.task||document,'task'); requires=task.requires || null; }
  if((task.schemaVersion??1)!==1)return incompatible('unsupported_task_schema');
  const analysis=analyzeTask(task);
  issues.push(...assessRequirements(requires,{...runtime,capabilities:runtime.capabilities || CAPABILITIES.filter(c=>c.available!==false).map(c=>c.id)},analysis.capabilities));
  const bound=bindInputs(inputs,options.values||{});
  bound.missing.forEach(name=>issues.push({code:'input_required',name}));
  let candidate=null;
  try{candidate=validateTask({...task,id:task.id||'package_preview',variables:{...(task.variables||{}),...bound.values},...(requires?{requires}:{}),enabled:false});}
  catch(error){issues.push({code:'invalid_task',message:error.message});}
  return {kind:packaged?'package':'legacy-task',compatible:issues.length===0,issues,sha256,package:metadata,inputs,analysis,task:candidate,executed:false};
}
module.exports={PACKAGE_KIND,PACKAGE_FORMAT_VERSION,previewPackage,analyzeTask,bindInputs,versionAtLeast};
