// Standalone, explicit-path growth case. Never an API or production database entrypoint.
'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const appRoot = process.argv[2], database = process.argv[3], output = process.argv[4], asOf = process.argv[5];
if (![appRoot,database,output].every(value=>typeof value==='string'&&path.isAbsolute(value))||!Number.isFinite(Date.parse(asOf))) throw new Error('Usage: node --import tsx scripts/usage-report-growth-case.cjs <appRoot> <private-database> <receipt.json> <asOf> [selection]');
for(const live of [path.join(appRoot,'var-lib/dev.db'),'/data/video-api-debugger/var-lib/dev.db'])if(fs.existsSync(live)){const a=fs.statSync(live),b=fs.statSync(database);if(a.dev===b.dev&&a.ino===b.ino)throw new Error('live_database_forbidden');}
if(fs.existsSync(output))throw new Error('receipt_exists');
const bootWorkingDirectory=process.cwd();
process.chdir(appRoot); process.env.DATABASE_URL = `file:${database}`;
const started = performance.now(), startedAt = new Date().toISOString();
const state = { schema: 'usage-report-growth-case.v1', source: fs.readFileSync(path.join(appRoot, '.deployed-commit'),'utf8').trim(), startedAt,
  query: { range:'month',year:2026,month:11,time_zone:'UTC' }, asOf,
  bootWorkingDirectory, budget: { cpuCores:1,memoryMiB:512,maximumSeconds:60 }, completed:false, phase:'module-load', forbiddenCalls:0,
  operationScope:'isolated backup financial snapshot plus JSON serialization; excludes auth/current avatar lookup', sql: { count:0,rows:0,wallMs:0,pythonQueryAndSendMs:0,pythonDoneFrames:0,pythonCpuMs:0,executeCpuMs:0,fetchCpuMs:0,emitCpuMs:0 }, phases:[], reader:[], queryGroups:[] };
state.phaseResources = [];
const databaseBefore=fs.statSync(database);
state.databaseBytes=databaseBefore.size;state.databasePath=database;
const save = () => fs.writeFileSync(output,JSON.stringify(state,null,2)+'\n',{mode:0o600});
const allowedLogKeys = ['event','phase','op','elapsedMs','outcome','openPinMs','queries','frames','rows','stdoutBytes','stderrBytes','databaseClosed','code','eventLoopUtilization','eventLoopActiveMs','eventLoopIdleMs'];
const queryGroups = new Map();
const req=createRequire(path.join(appRoot,'package.json')), Module=req('node:module'), originalLoad=Module._load;
if(process.argv[6]==='selection'){
 const {Prisma}=req('@prisma/client');const {usageWindowCondition,usageSqlTime}=req(path.join(appRoot,'src/lib/usage/read-window.ts'));
 const {parseUsageQuery}=req(path.join(appRoot,'src/lib/admin/usage-query.ts'));const query=parseUsageQuery(new URLSearchParams('range=month&year=2026&month=11&time_zone=UTC'),new Date(asOf));
 const window={startUtc:query.startUtc,endUtc:query.endUtc},time=usageSqlTime(Prisma.sql`"occurred_at"`);
 const statements={video:Prisma.sql`SELECT "VideoTask"."id" FROM "VideoTask" WHERE ${usageWindowCondition('video_task',window,true)}`,image:Prisma.sql`SELECT "ImageStudioTask"."id" FROM "ImageStudioTask" WHERE ${usageWindowCondition('image_task',window,true)}`,cash:Prisma.sql`SELECT "id" FROM "CostLedger" WHERE ${time} IS NULL OR (${time} >= ${Date.parse(window.startUtc)} AND ${time} < ${Date.parse(window.endUtc)})`};
 fs.writeFileSync(output,JSON.stringify({schema:'usage-growth-selection.v1',asOf,statements:Object.fromEntries(Object.entries(statements).map(([key,value])=>[key,{sql:value.sql,params:value.values}]))},null,2)+'\n',{mode:0o600});process.exit(0);
}
const sourceFiles=['src/lib/admin/usage-analytics.ts','src/lib/admin/usage-query.ts','src/lib/admin/usage-money.ts','src/lib/admin/usage-csv.ts','src/lib/usage/facts.ts','src/lib/usage/accounting.ts','src/lib/usage/database.ts','src/lib/usage/row-spool.ts','src/lib/usage/summary-fold.ts','src/lib/usage/read-window.ts','src/lib/usage/sqlite-read-snapshot.ts','scripts/usage-sqlite-reader.py'];
if(fs.existsSync(path.join(appRoot,'src/lib/admin/usage-report-admission.ts')))sourceFiles.push('src/lib/admin/usage-report-admission.ts');
state.sourceSha256=Object.fromEntries(sourceFiles.map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(path.join(appRoot,file))).digest('hex')]));
const prohibited = () => { state.forbiddenCalls++; throw new Error('probe_application_or_network_access'); };
global.prisma=new Proxy({}, {get(_target,name){if(name==='then')return undefined; return prohibited;}});
global.fetch=prohibited;
for(const name of ['node:http','node:https']) {const mod=req(name);mod.request=prohibited;mod.get=prohibited;}
const observedModules=new Map();
Module._load=function(name,parent,main){
 if(name==='server-only')return {};
 const result=originalLoad.call(this,name,parent,main);
 if(name==='node:readline')return new Proxy(result,{get(target,key){
  if(key!=='createInterface')return Reflect.get(target,key);
  return (...args)=>{const lines=target.createInterface(...args);lines.on('line',line=>{if(line.startsWith('{"type":"done",')){const value=JSON.parse(line);if(Number.isFinite(value.queryMs)){state.sql.pythonDoneFrames++;state.sql.pythonQueryAndSendMs+=value.queryMs;for(const name of ['pythonCpuMs','executeCpuMs','fetchCpuMs','emitCpuMs'])state.sql[name]+=Number(value[name]||0);}}});return lines;};
 }});
 let resolved;try{resolved=Module._resolveFilename(name,parent,main);}catch{return result;}
 if(resolved===path.join(appRoot,'src/lib/performance/request-trace.ts')) {
  if(observedModules.has(resolved))return observedModules.get(resolved);
  const actualPhase=result.tracePhase;
  const observed=new Proxy(result,{get(target,key){if(key!=='tracePhase')return Reflect.get(target,key);
   return (phase,run)=>actualPhase(phase,async()=>{
    const w=performance.now(),c=process.cpuUsage(),g=cgroupCpu();
    try{return await run();}finally{const end=cgroupCpu(),node=process.cpuUsage(c);state.phaseResources.push({phase,scope:'isolated-probe-process-phase-window; nested phases are not additive',wallMs:performance.now()-w,nodeCpuMicroseconds:node,cgroupCpuDelta:g&&end?Object.fromEntries(Object.entries(end).map(([k,v])=>[k,v-(g[k]||0)])):null});}
   });
  }});observedModules.set(resolved,observed);return observed;
 }
 if(resolved!==path.join(appRoot,'src/lib/usage/sqlite-read-snapshot.ts'))return result;
 if(observedModules.has(resolved))return observedModules.get(resolved);
 const actual=result.withUsageReadSnapshot;
 const observed=new Proxy(result,{get(target,key){if(key!=='withUsageReadSnapshot')return Reflect.get(target,key);
  return (capture,options={})=>actual(async(reader,dataAsOf)=>{
   const measured={query:async statement=>{const before=performance.now(),pythonBefore=state.sql.pythonCpuMs;const rows=await reader.query(statement);const elapsed=performance.now()-before;
    state.sql.count++;state.sql.rows+=rows.length;state.sql.wallMs+=elapsed;
    const sql=statement.sql.replace(/\s+/g,' ').trim();const fingerprint=crypto.createHash('sha256').update(sql).digest('hex').slice(0,16);
    const tables=[...new Set([...sql.matchAll(/(?:FROM|JOIN)\s+"?([A-Za-z][A-Za-z0-9_]*)"?/gi)].map(match=>match[1]))];
    const group=queryGroups.get(fingerprint)||{fingerprint,tables,count:0,rows:0,wallMs:0,pythonCpuMs:0,sqlShape:sql};group.pythonCpuMs+=state.sql.pythonCpuMs-pythonBefore;group.count++;group.rows+=rows.length;group.wallMs+=elapsed;queryGroups.set(fingerprint,group);return rows;}};
   return capture(measured,dataAsOf);
  },{...options,dataAsOf:asOf,timeoutMs:55000});
 }});
 observedModules.set(resolved,observed);return observed;
};
const log = (label,value) => {if(!['[RequestTrace]','[UsageReadSnapshot]','[Capacity]'].includes(label))return;
 try{const parsed=JSON.parse(value);const safe=Object.fromEntries(allowedLogKeys.filter(key=>key in parsed).map(key=>[key,parsed[key]]));
  if(label==='[UsageReadSnapshot]')state.reader.push(safe);else if(label==='[RequestTrace]')state.phases.push(safe);
 }catch{} };
console.info=console.error=log;console.warn=()=>{};
const originalDriver=path.join(appRoot,'scripts/usage-sqlite-reader.py'),observedDriver=output+'.reader.py';
let driver=fs.readFileSync(originalDriver,'utf8');
const replaceOnce=(old,next)=>{if(driver.split(old).length!==2)throw Error('driver_observation_source_mismatch');driver=driver.replace(old,next);};
replaceOnce('            started = time.monotonic()','            started = time.monotonic()\n            cpu_started = time.process_time()\n            execute_cpu = fetch_cpu = emit_cpu = 0.0');
replaceOnce("                cursor.execute(message['sql'], parameters)","                measured_cpu = time.process_time()\n                cursor.execute(message['sql'], parameters)\n                execute_cpu += time.process_time() - measured_cpu");
replaceOnce('                    batch = cursor.fetchmany(500)','                    measured_cpu = time.process_time()\n                    batch = cursor.fetchmany(500)\n                    fetch_cpu += time.process_time() - measured_cpu');
replaceOnce("                    emit({'type': 'rows'", "                    measured_cpu = time.process_time()\n                    emit({'type': 'rows'");
replaceOnce('                    rows += len(batch)','                    emit_cpu += time.process_time() - measured_cpu\n                    rows += len(batch)');
replaceOnce("                  'queryMs': (time.monotonic() - started) * 1000})", "                  'queryMs': (time.monotonic() - started) * 1000, 'pythonCpuMs': (time.process_time() - cpu_started) * 1000, 'executeCpuMs': execute_cpu * 1000, 'fetchCpuMs': fetch_cpu * 1000, 'emitCpuMs': emit_cpu * 1000})");
fs.writeFileSync(observedDriver,driver,{mode:0o600});state.observedDriverSha256=crypto.createHash('sha256').update(driver).digest('hex');state.driverObservation='Only CPU clock fields added; actual SQL/typed rows/read-only transaction/cancel logic unchanged';
const childModule=req('node:child_process'),originalSpawn=childModule.spawn;childModule.spawn=function(command,args,options){if(command==='/usr/bin/python3'&&args?.[1]===originalDriver)return originalSpawn.call(this,command,[args[0],observedDriver],options);return originalSpawn.call(this,command,args,options);};
const controller=new AbortController();process.on('SIGTERM',()=>{state.terminated=true;state.phaseAtTermination=state.phase;save();controller.abort();});
function cgroupCpu(){try{const suffix=fs.readFileSync('/proc/self/cgroup','utf8').split('\n').find(line=>line.startsWith('0::')).slice(3);return Object.fromEntries(fs.readFileSync('/sys/fs/cgroup'+suffix+'/cpu.stat','utf8').trim().split('\n').map(line=>{const [key,value]=line.split(' ');return [key,Number(value)];}));}catch{return null;}}
(async()=>{
 const {parseUsageQuery}=req(path.join(appRoot,'src/lib/admin/usage-query.ts'));
 const {getUsageAnalyticsSnapshot}=req(path.join(appRoot,'src/lib/admin/usage-analytics.ts'));
 const trace=req(path.join(appRoot,'src/lib/performance/request-trace.ts'));
 if(process.argv[6]==='preflight'){state.loadedOnly=true;state.phase='preflight';state.completed=state.forbiddenCalls===0;state.totalWallMs=performance.now()-started;save();return;}
 const query=parseUsageQuery(new URLSearchParams('range=month&year=2026&month=11&time_zone=UTC'),new Date(asOf));
 state.moduleLoadMs=performance.now()-started;state.phase='snapshot-and-fold';save();
 const cpuBefore=process.cpuUsage(),cgBefore=cgroupCpu(),loopBefore=performance.eventLoopUtilization();const delay=monitorEventLoopDelay({resolution:10});delay.enable();
 const workloadStarted=performance.now();let snapshot;
 await trace.traceServerRequest('admin.usage-analytics',new Headers(),async()=>{
  snapshot=await getUsageAnalyticsSnapshot(query,controller.signal);
  state.phase='serialize';save();
  await trace.tracePhase('serialize',async()=>{const before=performance.now(),json=JSON.stringify(snapshot.report);state.serializeMs=performance.now()-before;state.responseBytes=Buffer.byteLength(json);state.reportHash=crypto.createHash('sha256').update(json).digest('hex');});
 });
 state.workloadWallMs=performance.now()-workloadStarted;state.nodeCpuMicroseconds=process.cpuUsage(cpuBefore);const cgAfter=cgroupCpu();
 state.cgroupCpuDelta=cgBefore&&cgAfter?Object.fromEntries(Object.entries(cgAfter).map(([key,value])=>[key,value-(cgBefore[key]||0)])):null;
 const loop=performance.eventLoopUtilization(loopBefore);state.eventLoop={scope:'isolated-probe-process-window',...loop,maxDelayMs:Number(delay.max)/1e6,p99DelayMs:Number(delay.percentile(99))/1e6};delay.disable();
 state.memory=process.memoryUsage();state.resourceUsage=process.resourceUsage();state.summary=snapshot.report.summary;
 state.recordTotal=snapshot.report.records.total;state.memberTotal=snapshot.report.members.total;state.projectTotal=snapshot.report.projects.total;
 state.queryGroups=[...queryGroups.values()].sort((a,b)=>b.count-a.count);state.queryGroupsByWall=[...queryGroups.values()].sort((a,b)=>b.wallMs-a.wallMs).slice(0,20);
 state.phase='equivalence-hash';save();
 const validationStarted=performance.now();
 for(const [name,rows]of [['records',snapshot.records],['cashEvents',snapshot.cashEvents]]){const hash=crypto.createHash('sha256');let count=0;for await(const row of rows.values()){count++;hash.update(JSON.stringify(row)).update('\n');}state[name+'Hash']=hash.digest('hex');state[name+'Rows']=count;}
 const {streamUsageCsv}=req(path.join(appRoot,'src/lib/admin/usage-csv.ts'));state.csv={};
 for(const type of ['summary','records']){const hash=crypto.createHash('sha256'),stream=streamUsageCsv({...snapshot,dispose:undefined},type),reader=stream.getReader();let bytes=0,lines=0;for(;;){const chunk=await reader.read();if(chunk.done)break;hash.update(chunk.value);bytes+=chunk.value.byteLength;for(const byte of chunk.value)if(byte===10)lines++;}state.csv[type]={sha256:hash.digest('hex'),bytes,lines};}
 state.validationWallMs=performance.now()-validationStarted;await snapshot.dispose?.();
 const databaseAfter=fs.statSync(database);state.databaseFileUnchanged=databaseAfter.size===databaseBefore.size&&databaseAfter.mtimeMs===databaseBefore.mtimeMs;
 if(!state.databaseFileUnchanged)throw new Error('probe_database_modified');
 if(state.forbiddenCalls)throw new Error('probe_forbidden_call');state.completed=true;state.phase='complete';state.finishedAt=new Date().toISOString();state.totalWallMs=performance.now()-started;save();
})().catch(error=>{state.phaseAtFailure=state.phase;state.phase='failed';state.finishedAt=new Date().toISOString();state.error={name:error?.name||'Error',code:typeof error?.code==='string'?error.code:null};if(error?.code==='MODULE_NOT_FOUND'){const value=String(error.message).match(/Cannot find module '([A-Za-z0-9@_.\/:-]+)'/);if(value)state.error.missingModule=value[1];}state.totalWallMs=performance.now()-started;state.queryGroups=[...queryGroups.values()].sort((a,b)=>b.count-a.count);state.queryGroupsByWall=[...queryGroups.values()].sort((a,b)=>b.wallMs-a.wallMs).slice(0,20);save();process.exitCode=1;});
