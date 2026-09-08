'use strict';
function stableVersion(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw new Error('Expected a stable version: major.minor.patch');
  const parts=value.split('.').map(Number);
  if(!parts.every(Number.isSafeInteger))throw new Error('Version exceeds supported range');
  return parts;
}
function versionAtLeast(actual, minimum) {
  const a=stableVersion(actual),b=stableVersion(minimum);
  for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]>b[i];
  return true;
}
function validateRequirements(requires) {
  if(!requires||typeof requires!=='object'||Array.isArray(requires))throw new Error('requires must be an object');
  const allowed=new Set(['minWorkDaddyVersion','taskSchemaVersion','capabilities','profiles','platforms']);
  for(const key of Object.keys(requires))if(!allowed.has(key)&&!/^x-[a-z0-9][a-z0-9.-]*$/.test(key))throw new Error('Unsupported requirement: '+key);
  stableVersion(requires.minWorkDaddyVersion);
  if(!Number.isSafeInteger(requires.taskSchemaVersion)||requires.taskSchemaVersion<1)throw new Error('Invalid taskSchemaVersion');
  for(const key of ['capabilities','profiles','platforms']){
    const value=requires[key];
    if(key!=='capabilities'&&value==null)continue;
    if(!Array.isArray(value)||value.length>100||value.some(v=>typeof v!=='string'||!v.trim()||v.length>200))throw new Error('Invalid requirement: '+key);
  }
  return requires;
}
function assessRequirements(requires, runtime, actualCapabilities=[]) {
  const issues=[];
  if(requires){
    validateRequirements(requires);
    if(!runtime.version||!versionAtLeast(runtime.version,requires.minWorkDaddyVersion))issues.push({code:'workdaddy_version',required:requires.minWorkDaddyVersion});
    if(requires.taskSchemaVersion!==1)issues.push({code:'unsupported_task_schema'});
    if(requires.profiles&&!requires.profiles.includes(runtime.profileId))issues.push({code:'profile',allowed:requires.profiles});
    if(requires.platforms&&!requires.platforms.includes(runtime.platform))issues.push({code:'platform',allowed:requires.platforms});
  }
  const available=new Set(runtime.capabilities||[]);
  for(const capability of new Set([...(requires&&requires.capabilities||[]),...actualCapabilities]))if(!available.has(capability))issues.push({code:'capability',capability});
  return issues;
}
module.exports={stableVersion,versionAtLeast,validateRequirements,assessRequirements};
