import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertWholeHdDrain, inspectRetiredHdCaches } from './retired-hd-cache.mjs';
import { MV_DIRECT } from './release-contract.mjs';
import { validateRecoveryCertificate } from './certificate.mjs';
const checks=[],source='/data/video-api-debugger/managed-releases/'+MV_DIRECT.baselineSource;
const good={ActiveState:'inactive',MainPID:'0',ControlPID:'0',Result:'success',Restart:'no',SendSIGKILL:'no',TimeoutStopUSec:'infinity',WorkingDirectory:source};
assertWholeHdDrain(good,[],[],3435513);checks.push('actual-validator-complete-service-drain');
for(const [field,value] of Object.entries({ActiveState:'active',MainPID:'3435513',ControlPID:'77',Result:'timeout',Restart:'on-failure',SendSIGKILL:'yes',TimeoutStopUSec:'3min',WorkingDirectory:'/other'})){
  assert.throws(()=>assertWholeHdDrain({...good,[field]:value},[],[],3435513));checks.push('reject-'+field);
}
for(const [name,members,processes] of [['nested-cgroup',[77],[]],['original-pid',[],[{pid:3435513,related:false}]],['escaped-hd-or-ffmpeg',[],[{pid:77,related:true}]]]){
  assert.throws(()=>assertWholeHdDrain(good,members,processes,3435513));checks.push('reject-'+name);
}
assert.throws(()=>inspectRetiredHdCaches({runId:'other'},'drained'));checks.push('other-run-refused-before-filesystem');
const code=fs.readFileSync(new URL('./switch.mjs',import.meta.url),'utf8');
const begin=code.indexOf('async function restoreControlledDrain('),end=code.indexOf('\nasync function locked(',begin);
assert.ok(begin>0&&end>begin);const restoreSource=code.slice(begin,end);
const runtimeBegin=code.indexOf('export function originalRuntimeBuild('),runtimeEnd=code.indexOf('\nexport function protectedFileSnapshot(',runtimeBegin);
assert.ok(runtimeBegin>0&&runtimeEnd>runtimeBegin);const runtimeSource=code.slice(runtimeBegin,runtimeEnd).replace(/^export /,'');
const sha=x=>createHash('sha256').update(x).digest('hex');
async function recoveryCase(fault){
  const events=[],runId=MV_DIRECT.recoveryRunId,roles=['web','image','hd'];
  const m={runId,stage:'/stage',expectedProtectedFileSha256:{},live:Object.fromEntries(roles.map((role,i)=>[role,{unit:role,root:'/old/'+role,source:'a'.repeat(40),build:'build',version:'0.99.3'}])),hdWorkerLockPath:'/lock'};
  const before={captured:{control:1,guard:2,allowed:3,marker:4,chain:5},writers:Object.fromEntries(roles.map((role,i)=>[role,{MainPID:String(101+i),InvocationID:'1'.repeat(32),WorkingDirectory:'/old/'+role}])),protection:{fixed:true,files:{}}};
  const temporary={files:Object.fromEntries(roles.map(role=>[role,{file:'/own/'+role,ino:1}]))};
  const states=Object.fromEntries(roles.map((role,i)=>[role,{MainPID:String(101+i),InvocationID:'1'.repeat(32),ActiveState:'active',SubState:'running',WorkingDirectory:'/old/'+role}]));
  const asset='static/chunk.js',assetBytes=Buffer.from('actual-original-chunk');
  const context={assert,ROLES:roles,PRICING_START_CONTROL:'/control',sha,MV_DIRECT,
    inspectRecoveryCertificate:(manifest,captured,options)=>validateRecoveryCertificate(manifest,captured,null,options.phase),
    exists:file=>fault==='new-writer'&&file.includes('/start-'),capturePricingStartControl:()=>fault==='changed-control'?{...before.captured,allowed:9}:before.captured,
    service:(_m,role)=>fault==='changed-web'&&role==='web'?{...states[role],MainPID:'999'}:states[role],
    assertPolicy:()=>{},rootSnapshot:file=>fault==='changed-owned-file'?{file,ino:2}:{file,ino:1},
    restoreOriginalUsageRole:async(manifest,check)=>{assert.equal(manifest,m);check();events.push('role-restore');if(fault==='role-unrestored')throw Error('role-not-restored');return{restored:true};},
    fs:{unlinkSync:file=>events.push('remove:'+file),realpathSync:file=>file.endsWith('/.next-prod')?file+'-candidate':'/old/'+roles[Number(file.split('/')[2])-101],readFileSync:()=>'',statSync:()=>({})},
    hdLockOwnerRows:()=>['0 FLOCK ADVISORY WRITE 103 dev'],call:(_cmd,args)=>{events.push(args[0]);return '';},
    waitForOriginalRecovery:async(_m,_message,predicate)=>{for(let n=0;n<2;n++)if(await predicate())return;throw Error('not-ready');},
    liveArtifactSource:()=>m.live.web.source,json:()=>({pages:{'/multiview/page':[asset]}}),
    regularBytes:file=>file.endsWith('/BUILD_ID')?Buffer.from('build'):file.endsWith('/app-build-manifest.json')?Buffer.from(JSON.stringify({pages:{'/multiview/page':[asset]}})):assetBytes,path,
    request:(_target,url)=>({status:200,body:url==='/api/release'?Buffer.from(JSON.stringify({version:fault==='wrong-release'?'0.1.0':'0.99.3'})):fault==='wrong-asset'?Buffer.from('wrong'):assetBytes}),
    TARGETS:[{host:'sd2.youdooart.com'},{host:'sd2-server.youdoodesign.com'}],
    restoreNginxMaintenance:async options=>{events.push('entry-restore');const rows=await options.observeRestored();assert.equal(rows.length,2);return {rows};},
    assertProtection:(a,b)=>assert.deepEqual(a,b),readProtection:()=>before.protection,
    save:(_m,name)=>{events.push('receipt:'+name);},Buffer,Date,JSON,
  };
  context.originalRuntimeBuild=vm.runInNewContext('('+runtimeSource+')',context);
  const restore=vm.runInNewContext('('+restoreSource+')',context);
  if(fault){await assert.rejects(restore(m,before,temporary,{},{}));assert.ok(!events.some(x=>x.startsWith('receipt:')));}
  else{const result=await restore(m,before,temporary,{},{});assert.equal(result.completed,true);assert.equal(result.restoredRole.restored,true);assert.ok(events.indexOf('role-restore')<events.indexOf('entry-restore'));assert.ok(events.indexOf('start')<events.indexOf('entry-restore'));}
  if(['new-writer','changed-control','changed-web','changed-owned-file'].includes(fault))assert.equal(events.length,0);
  if(fault==='role-unrestored')assert.equal(events.includes('entry-restore'),false);
  checks.push('original-recovery-'+(fault||'complete'));
}
for(const fault of [null,'new-writer','changed-control','changed-web','changed-owned-file','wrong-release','wrong-asset','role-unrestored'])await recoveryCase(fault);
const stop=code.indexOf("for (const role of ['image', 'hd']) await stopNaturally");
assert.ok(stop<code.indexOf("const drainedCaches = await inspectHdReconciliation",stop));
assert.ok(code.indexOf("const drainedCaches = await inspectHdReconciliation",stop)<code.indexOf('await safety.installFence',stop));
checks.push('new-proof-before-fence-web-stop-pair-and-writer');
assert.ok(code.includes('RefuseManualStart=yes')&&code.includes("'hd-manual-start-gate-released-'"));checks.push('temporary-manual-start-gate-present');
console.log(JSON.stringify({schema:'retired-hd-cache-engineering.v1',completed:true,checks,count:checks.length,productionWrites:0,serviceCalls:0,historicalPidsReconstructed:false}));
