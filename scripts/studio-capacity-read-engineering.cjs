'use strict';
// Explicit internal RO service sample. This does not send HTTP or create a session/reader capability.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const {createRequire} = require('node:module'), {AsyncLocalStorage} = require('node:async_hooks');
const {performance, monitorEventLoopDelay} = require('node:perf_hooks');
// Resource-only mode is a separate observer with no application, DB or private-policy imports.
if (process.argv[2] === '--resources') {
 const output=process.argv[3],seconds=Number(process.argv[4]||55),owner=process.getuid?.();
 if(!path.isAbsolute(output||'')||!Number.isInteger(seconds)||seconds<1||seconds>60||fs.existsSync(output))throw Error('new_bounded_resource_receipt_required');
 const parent=fs.statSync(path.dirname(output));if(parent.uid!==owner||parent.mode&0o077)throw Error('private_observer_directory_required');
 const units=['sd2-gray.service','sd2-image-studio.service','sd2-hd-derivatives.service','sd2-multiview-works.service','sd2-periodic-credits.service','sd2-role-coordinator.service','sd2-template-prompts.service','sd2-mj-dna-preview.service'];
 const result=require('node:child_process').spawnSync('systemctl',['show','--no-pager','--property=Id','--property=ControlGroup',...units],{encoding:'utf8',timeout:5000});
 if(result.status!==0)throw Error('project_cgroups_unavailable');
 const groups={};for(const block of result.stdout.trim().split(/\n\n/)){const v=Object.fromEntries(block.split('\n').map(line=>{const at=line.indexOf('=');return[line.slice(0,at),line.slice(at+1)];}));if(units.includes(v.Id)&&v.ControlGroup)groups[v.Id]=v.ControlGroup;}
 const read=file=>{try{return fs.readFileSync(file,'utf8').trim();}catch{return null;}};
 const kv=file=>{const value=read(file);return value?Object.fromEntries(value.split('\n').map(line=>{const[k,v]=line.split(' ');return[k,Number(v)];})):null;};
 const sample=()=>({at:new Date().toISOString(),monotonicMs:performance.now(),hostCpuFirst8:(read('/proc/stat')||'').split('\n')[0].trim().split(/\s+/).slice(1,9).map(Number),hostPressure:Object.fromEntries(['cpu','memory','io'].map(name=>[name,read('/proc/pressure/'+name)])),services:Object.fromEntries(Object.entries(groups).map(([name,suffix])=>{const base='/sys/fs/cgroup'+suffix;return[name,{cpu:kv(base+'/cpu.stat'),cpuPressure:read(base+'/cpu.pressure'),memoryCurrent:Number(read(base+'/memory.current')),memoryEvents:kv(base+'/memory.events')}];}))});
 const state={schema:'studio-capacity-resource-window.v1',completed:false,maximumSeconds:seconds,samples:[sample()],requestedUnits:units,missingUnits:units.filter(name=>!groups[name]),scope:'Only fixed project cgroups and host aggregates; no PID commandlines, other-project configuration, DB, API or media'};
 const save=()=>fs.writeFileSync(output,JSON.stringify(state,null,2)+'\n',{mode:0o600});save();
 let ended=false;const interval=setInterval(()=>{state.samples.push(sample());save();},500);
 const finish=reason=>{if(ended)return;ended=true;clearInterval(interval);clearTimeout(timer);state.samples.push(sample());state.completed=true;state.reason=reason;save();};
 const timer=setTimeout(()=>finish('bounded-window-complete'),seconds*1000);process.on('SIGTERM',()=>finish('requested-stop'));
 console.log('READY '+JSON.stringify({startedAt:state.samples[0].at,receipt:output,maximumSeconds:seconds}));
} else {
const [appRoot, database, output] = process.argv.slice(2);
const thinkMs=Number(process.argv[6]||0);if(![0,1000].includes(thinkMs))throw Error('explicit_think_ms_zero_or_one_second_required');
if (![appRoot,database,output].every(v=>typeof v==='string'&&path.isAbsolute(v)) || process.getuid?.()!==1004) throw Error('explicit_paths_and_actual_gouki_uid_required');
if (path.dirname(output)!==path.dirname(database) || fs.existsSync(output)) throw Error('new_private_receipt_required');
const dbStat=fs.statSync(database), folderStat=fs.statSync(path.dirname(database));
if (dbStat.uid!==1004 || dbStat.mode&0o077 || folderStat.uid!==1004 || folderStat.mode&0o077 || dbStat.nlink!==1) throw Error('private_owned_copy_required');
for (const live of [path.join(appRoot,'var-lib/dev.db'),'/data/video-api-debugger/var-lib/dev.db']) if(fs.existsSync(live)){const s=fs.statSync(live);if(s.dev===dbStat.dev&&s.ino===dbStat.ino)throw Error('live_database_forbidden');}
process.chdir(appRoot);process.env.NODE_ENV='production';process.env.DATABASE_URL=`file:${database}`;
const req=createRequire(path.join(appRoot,'package.json')), Module=req('node:module'), originalLoad=Module._load;
req('@next/env').loadEnvConfig(appRoot,false,{info(){},error(){}});
if(process.env.DATABASE_URL!==`file:${database}`)throw Error('database_environment_changed');
const started=performance.now(), source=fs.readFileSync(path.join(appRoot,'.deployed-commit'),'utf8').trim();
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const state={schema:'studio-capacity-read-engineering.v1',source,startedAt:new Date().toISOString(),uid:process.getuid(),completed:false,
 scope:'Internal actual modern sharedStudioRevision with an additional harness-owned pinned RO reader per call; excludes HTTP/auth/media/providers',
 budget:{cpuCores:1,memoryMiB:512,totalSeconds:60,waveSeconds:10,maximumCalls:200,maximumCallsPerWave:thinkMs?null:50,thinkMs},
 databaseBytes:dbStat.size,actors:[],selectionRejected:[],waves:[],samples:[],calls:[],forbiddenCalls:0,denials:[],keyMaterialBytesRead:0,
 boundaries:{fakeSessions:false,newConsumers:false,fakeReadiness:false,policyChanges:false,keyCopies:false,writerSdk:false,httpRequests:0}};
const save=()=>fs.writeFileSync(output,JSON.stringify(state,null,2)+'\n',{mode:0o600});
const denied=boundary=>{state.forbiddenCalls++;const error=Error('engineering_write_or_network_forbidden');state.denials.push({boundary,callIndex:context.getStore()?.call?.index??null,stack:String(error.stack).split('\n').filter(line=>line.startsWith('    at')).slice(0,8)});throw error;};
const context=new AsyncLocalStorage();
const readOperations=new Set(['findUnique','findFirst','findMany','findUniqueOrThrow','findFirstOrThrow','count','aggregate','groupBy']);
const facade=new Proxy({}, {get(_target,name){
 if(name==='then')return undefined;
 if(name==='$queryRaw'||name==='$queryRawUnsafe')return (...args)=>{const tx=context.getStore()?.tx;if(!tx)return denied('prisma-no-read-context:'+name);return tx[name](...args);};
 if(typeof name!=='string'||name.startsWith('$'))return ()=>denied('prisma-method:'+String(name));
 return new Proxy({}, {get(_delegate,operation){if(operation==='then')return undefined;return (...args)=>{if(!readOperations.has(operation))return denied('prisma-operation:'+name+'.'+String(operation));const tx=context.getStore()?.tx;if(!tx)return denied('prisma-no-read-context:'+name+'.'+String(operation));return tx[name][operation](...args);};}});
}});
global.prisma=facade;global.feedbackPrisma=facade;global.hdReadonlyDb=facade;global.fetch=()=>denied('fetch');
for(const name of ['node:http','node:https']){const mod=req(name);mod.get=mod.request=()=>denied('http-request');}
const observed=new Map();
Module._load=function(name,parent,main){
 if(name==='server-only')return {};
 const value=originalLoad.call(this,name,parent,main);
 if(name==='@prisma/client')return new Proxy(value,{get(target,key){return key==='PrismaClient'?class{constructor(){denied('PrismaClient-constructor');}}:Reflect.get(target,key);}});
 let resolved;try{resolved=Module._resolveFilename(name,parent,main);}catch{return value;}
 if(resolved===path.join(appRoot,'src/lib/pricing/runtime.ts')){
  if(!observed.has(resolved))observed.set(resolved,new Proxy(value,{get(target,key){if(key!=='assertPricingImageConsumerReady')return Reflect.get(target,key);return async(...args)=>{const call=context.getStore()?.call,t=performance.now(),cpu=process.cpuUsage();try{return await target[key](...args);}finally{if(call){call.readinessWindows??=[];call.readinessWindows.push({wallMs:performance.now()-t,nodeCpuMicroseconds:process.cpuUsage(cpu),scope:'process-window across async check; overlapping requests are not additive'});}}};}}));return observed.get(resolved);
 }
 if(resolved===path.join(appRoot,'src/lib/image-studio/catalog-revision.ts')){
  if(!observed.has(resolved))observed.set(resolved,new Proxy(value,{get(target,key){if(key!=='catalogReaderReady')return Reflect.get(target,key);return async(...args)=>{const ready=await target[key](...args);const call=context.getStore()?.call;if(call)call.markerReadiness.push(ready);return ready;};}}));
  return observed.get(resolved);
 }
 return value;
};
const logKeys=['event','operation','phase','op','elapsedMs','outcome','code','queries','rows','stdoutBytes','databaseClosed','openPinMs','forced'];
for(const name of ['info','error','warn'])console[name]=(label,raw)=>{if(!['[RequestTrace]','[UsageReadSnapshot]','[StudioSharedRead]','[Capacity]'].includes(label))return;try{const value=JSON.parse(raw),call=context.getStore()?.call;if(!call)return;call.trace.push({label,...Object.fromEntries(logKeys.filter(k=>k in value).map(k=>[k,value[k]]))});}catch{}};
function resources(){const suffix=fs.readFileSync('/proc/self/cgroup','utf8').split('\n').find(x=>x.startsWith('0::')).slice(3),base='/sys/fs/cgroup'+suffix;const kv=name=>Object.fromEntries(fs.readFileSync(base+'/'+name,'utf8').trim().split('\n').map(x=>{const[k,v]=x.split(' ');return[k,Number(v)];}));return {at:new Date().toISOString(),cpu:kv('cpu.stat'),memoryEvents:kv('memory.events'),memoryCurrent:Number(fs.readFileSync(base+'/memory.current','utf8')),memoryPeak:Number(fs.readFileSync(base+'/memory.peak','utf8')),memoryPressure:fs.readFileSync(base+'/memory.pressure','utf8').trim(),cpuPressure:fs.readFileSync(base+'/cpu.pressure','utf8').trim(),hostCpuFirst8:fs.readFileSync('/proc/stat','utf8').split('\n')[0].trim().split(/\s+/).slice(1,9).map(Number),hostCpuPressure:fs.readFileSync('/proc/pressure/cpu','utf8').trim()};}
const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),57000);let sampler;
process.on('SIGTERM',()=>{state.terminated=true;abort.abort();save();});
(async()=>{
 if(process.env.PRIVATE_PROMPTS_RUNTIME_REVISION!==source)throw Error('existing_private_consumer_source_mismatch');
 const privateModule=req(path.join(appRoot,'src/lib/security/private-prompts.server.ts')),policy=privateModule.privatePromptPolicy();
 if(!policy)throw Error('existing_private_policy_required');state.privatePolicyRevision=policy.revision;
 const keyFiles=new Set(Object.values(policy.keys).flatMap(domain=>Object.values(domain.files))),fds=new Map();
 const open=fs.openSync,close=fs.closeSync,read=fs.readFileSync;
 fs.openSync=function(file,...args){const fd=open.call(this,file,...args);if(keyFiles.has(String(file)))fds.set(fd,String(file));return fd;};
 fs.closeSync=function(fd){fds.delete(fd);return close.call(this,fd);};
 fs.readFileSync=function(file,...args){const t=performance.now(),result=read.call(this,file,...args),call=context.getStore()?.call,bytes=Buffer.byteLength(result);if(keyFiles.has(String(file))||fds.has(file)){state.keyMaterialBytesRead+=bytes;if(call)call.keyMaterialBytesRead=(call.keyMaterialBytesRead||0)+bytes;}if(call&&typeof file==='string'&&['src/lib/pricing/','src/lib/image-studio/'].some(prefix=>file.startsWith(path.join(appRoot,prefix)))){call.runtimeSourceReads??={count:0,bytes:0,synchronousReadWallMs:0};call.runtimeSourceReads.count++;call.runtimeSourceReads.bytes+=bytes;call.runtimeSourceReads.synchronousReadWallMs+=performance.now()-t;}return result;};
 const {Prisma}=req('@prisma/client'),{withUsageReadSnapshot}=req(path.join(appRoot,'src/lib/usage/sqlite-read-snapshot.ts'));
 const {sqlitePrismaReadClient}=req(path.join(appRoot,'src/lib/sqlite-prisma-read-snapshot.ts'));
 const {assertPricingImageConsumerReady}=req(path.join(appRoot,'src/lib/pricing/runtime.ts'));
 const {assertStudioActor,sharedStudioRevision}=req(path.join(appRoot,'src/lib/image-studio/shared-contract.ts'));
 const {traceServerRequest,tracePhase}=req(path.join(appRoot,'src/lib/performance/request-trace.ts'));
 state.sourceSha256=Object.fromEntries(['src/lib/image-studio/shared-contract.ts','src/lib/image-studio/catalog-revision.ts','src/lib/image-studio/read-snapshot.ts','src/lib/pricing/runtime.ts','src/lib/sqlite-prisma-read-snapshot.ts','scripts/usage-sqlite-reader.py','src/lib/security/private-prompts.server.ts'].map(file=>[file,sha(fs.readFileSync(path.join(appRoot,file)))]));state.engineeringSha256=sha(fs.readFileSync(__filename));
 let actors=[];
 await withUsageReadSnapshot(async reader=>{
  const tx=sqlitePrismaReadClient(reader);state.readiness=await assertPricingImageConsumerReady(tx);
  if(Date.parse(state.readiness.expiresAt)-Date.now()<45000)throw Error('fresh_existing_readiness_window_insufficient');
  const candidates=await reader.query(Prisma.sql`SELECT u."id" AS "actorId", m."id" AS "moduleId", m."source_preset_id" AS "presetId"
   FROM "User" u JOIN "ImageStudioModule" m ON m."owner_id"=u."id" JOIN "ImageStudioPreset" p ON p."id"=m."source_preset_id"
   JOIN "PlatformSetting" b ON b."key"='studio_shared_binding_v1:'||m."id"
   WHERE u."status"='active' AND u."account_type"='internal' AND json_valid(b."value_json")
   AND json_extract(b."value_json",'$.protocol')='shared-live-v1' AND json_extract(b."value_json",'$.ownerId')=u."id"
   AND json_extract(b."value_json",'$.presetId')=p."id" AND json_extract(b."value_json",'$.mode') IN('publisher','live')
   AND (p."owner_id"=u."id" OR (p."scope" IN('admin','creator') AND p."is_shared"=1))
   ORDER BY CASE WHEN m."id"='669d92e3-8348-406f-bb34-7b3b2e942530' THEN 0 ELSE 1 END,u."id",m."id" LIMIT 128`);
  state.selectionCandidateRows=candidates.length;state.selectionCapped=candidates.length===128;const seen=new Set();for(const row of candidates){if(seen.has(row.actorId))continue;seen.add(row.actorId);try{const actor=await assertStudioActor(row.actorId,tx);actors.push({actor,moduleId:row.moduleId,presetId:row.presetId});}catch(error){state.selectionRejected.push({actorSha256:sha(row.actorId).slice(0,16),status:error?.status??null,code:error?.reasonCode??null});}if(actors.length===8)break;}
 },{signal:abort.signal,timeoutMs:12000});
 state.actors=actors.map(x=>({actorSha256:sha(x.actor.id).slice(0,16),moduleId:x.moduleId,presetId:x.presetId}));
 const cohort=process.argv[5];if(cohort){const bytes=fs.readFileSync(cohort),prior=JSON.parse(bytes);state.cohortReceiptSha256=sha(bytes);if(JSON.stringify(state.actors)!==JSON.stringify(prior.actors))throw Error('actual_frozen_cohort_changed');}
 if(actors.length<2||state.actors[0].actorSha256!=='59bf645d707c72c9'||actors[0].moduleId!=='669d92e3-8348-406f-bb34-7b3b2e942530')throw Error('actual_frozen_actor_and_multi_actor_sample_required');
 state.preparationWallMs=performance.now()-started;save();
 sampler=setInterval(()=>state.samples.push(resources()),500);state.samples.push(resources());
 let stopped=false,serial=0;const resultHashes=new Map();
 for(const concurrency of [1,2,4,8]){
  if(stopped||abort.signal.aborted){state.waves.push({concurrency,notRun:true,reason:'earlier_failure_or_budget'});continue;}
  const wave={concurrency,startedAt:new Date().toISOString(),calls:0,successes:0,failures:0},waveStart=performance.now(),cpu=process.cpuUsage(),before=resources(),loop=performance.eventLoopUtilization(),delay=monitorEventLoopDelay({resolution:10});delay.enable();state.waves.push(wave);
  const waveCallLimit=thinkMs?200:50;
  const worker=async()=>{while(!stopped&&!abort.signal.aborted&&performance.now()-waveStart<10000&&wave.calls<waveCallLimit&&state.calls.length<200){
   const chosen=actors[serial++%actors.length],call={index:state.calls.length,concurrency,actorSha256:sha(chosen.actor.id).slice(0,16),startedAt:new Date().toISOString(),sqlCount:0,sqlRows:0,sqlWallMs:0,markerReadiness:[],trace:[]};wave.calls++;state.calls.push(call);const time=performance.now();
   try{const result=await traceServerRequest('studio.shared',new Headers(),()=>context.run({call},()=>withUsageReadSnapshot(reader=>{
    const measured={query:async statement=>{if(!/^\s*(SELECT|WITH|EXPLAIN\s+QUERY\s+PLAN)\b/i.test(statement.sql))return denied('raw-statement:'+statement.sql.trim().match(/^\w+/)?.[0]);const t=performance.now(),rows=await reader.query(statement);call.sqlCount++;call.sqlRows+=rows.length;call.sqlWallMs+=performance.now()-t;return rows;}};
    return context.run({tx:sqlitePrismaReadClient(measured),call},()=>tracePhase('resolve',()=>sharedStudioRevision(chosen.actor,chosen.presetId,chosen.moduleId,true)));
   },{signal:abort.signal,timeoutMs:15000})));
    call.resultHash=sha(JSON.stringify(result));const prior=resultHashes.get(call.actorSha256);if(prior&&prior!==call.resultHash)throw Error('frozen_revision_changed');resultHashes.set(call.actorSha256,call.resultHash);call.activeAvailable=result.activeAvailable;call.resultBytes=Buffer.byteLength(JSON.stringify(result));
    if(!result.activeAvailable||call.markerReadiness.length!==2||call.markerReadiness.some(v=>v!==true))throw Error('actual_modern_ready_projection_unavailable');call.success=true;wave.successes++;
   }catch(error){call.success=false;call.error={name:error?.name||'Error',code:typeof error?.code==='string'?error.code:null,status:error?.status??null,reason:typeof error?.message==='string'&&/^[a-z_]+$/.test(error.message)?error.message:null,stack:String(error?.stack||'').split('\n').filter(line=>line.startsWith('    at')).slice(0,8)};wave.failures++;stopped=true;}
   call.elapsedMs=performance.now()-time;
   if(thinkMs&&!stopped&&!abort.signal.aborted){const remaining=10000-(performance.now()-waveStart);if(remaining>0)await new Promise(resolve=>setTimeout(resolve,Math.min(thinkMs,Math.ceil(remaining))));if(remaining<=thinkMs)break;}
  }};
  await Promise.all(Array.from({length:concurrency},worker));delay.disable();wave.wallMs=performance.now()-waveStart;wave.nodeCpuMicroseconds=process.cpuUsage(cpu);wave.resourcesBefore=before;wave.resourcesAfter=resources();wave.eventLoop={scope:'isolated-process-wave-window',...performance.eventLoopUtilization(loop),maxDelayMs:Number(delay.max)/1e6,p99DelayMs:Number(delay.percentile(99))/1e6};wave.distinctActors=new Set(state.calls.filter(call=>call.concurrency===concurrency).map(call=>call.actorSha256)).size;wave.continuousDurationReached=wave.wallMs>=10000;wave.callLimitReached=wave.calls===waveCallLimit||state.calls.length===200;wave.durationCensoredByCallBudget=wave.callLimitReached&&wave.wallMs<10000;wave.totalBudgetAborted=abort.signal.aborted;save();
 }
 const end=fs.statSync(database);state.databaseFileUnchanged=dbStat.size===end.size&&dbStat.mtimeMs===end.mtimeMs;state.totalWallMs=performance.now()-started;state.finishedAt=new Date().toISOString();state.runtimeBudgetAborted=abort.signal.aborted;state.completed=!abort.signal.aborted&&state.waves.length===4&&state.waves.every(w=>w.successes>0&&!w.failures&&(!thinkMs||(w.continuousDurationReached&&w.distinctActors===actors.length)))&&state.databaseFileUnchanged&&!state.forbiddenCalls;save();if(!state.completed)process.exitCode=2;
})().catch(error=>{state.error={name:error?.name||'Error',code:typeof error?.code==='string'?error.code:null,reason:typeof error?.message==='string'&&/^[a-z_]+$/.test(error.message)?error.message:null};state.totalWallMs=performance.now()-started;save();process.exitCode=2;}).finally(()=>{clearTimeout(timer);if(sampler)clearInterval(sampler);state.processMemory=process.memoryUsage();state.processResourceUsage=process.resourceUsage();save();});

}
