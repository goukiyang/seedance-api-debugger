import { releaseDependencyRoot } from './full-release-contract.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { MV_DIRECT } from './release-contract.mjs';
import { operationalLive } from './candidate-evidence.mjs';
import { isSharedEngine } from './engine-context.mjs';

const RUN = MV_DIRECT.recoveryRunId;
const ROOT = '/data/video-api-debugger/var-lib/storage/hd-derivatives';
const SOURCE = '/data/video-api-debugger/managed-releases/76ef0f42daeb6969a99e6133b47c0ef8a00019eb';
const KEY = 'e7182874262e37275dc7bb6d7d3c3a6c0636d81fe16ba72b67bcaa1dfca44bee';
const OBJECTS = [
  { key: KEY, sha256: '019b0ef67a7877a8620626991aa0b4720c3e2b0b97cff924bb5e1a05026be339', status: 'failed', attempts: 3,
    runs: ['991fe4a7-3a2f-4154-beef-66dd6f32cfb6', 'dd5f6881-0a73-4965-81f1-a40163b65b98'] },
  { key: '2a8a89205124c76e905a1e71c068dcdb112866440ddc290164654eaa2192a989', sha256: '305060b61499fde14ad68acfff1dabc2b5494fe87dab55402fd723f46ed877c8', status: 'ready', attempts: 2,
    runs: ['6ea2271d-bb5a-4163-8180-eabf832e189c'] },
  { key: 'dbfb31cbdfcc2a94a869e720a1a9433696ec6e353b5b5f040bbf2655c77130f2', sha256: 'e9da21d2e90287e1d140dc4a31c439a1222928e09e1cd98d53e954a386304b5b', status: 'ready', attempts: 2,
    runs: ['ea55bb98-4a7a-4560-a9d0-180f869ef92e'] },
];
const CACHE = {
  '05dcd673e1692338d7268459c57c8a3c5c41001a': ['adc46ca4830bb0d5f7204bbca6784ef3cb50734414341c6cc1457553427a6aff', 'scripts/process-hd-image.ts'],
  '43775d5f498166a9f91bcb57602ddbdf24cd6274': ['cd9eefac1ef045b69aebb9960ad09c9eeff54c8dda591506098ee01f361e26e0', 'src/lib/media/hd-image-processor.ts'],
  '9c64c857e06356986bc468cf7d6ec29a712901d6': ['d98b1a5b714cebea0949bafe380bdfb557914a2eb8560e0868fb1de135b46c34', 'src/lib/media/hd-encoder.ts'],
};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const call = (args) => execFileSync('/usr/bin/systemctl', args, { encoding: 'utf8', timeout: 15000 }).trim();
const fields = s => Object.fromEntries(['dev','ino','size','mtimeMs','ctimeMs','uid','gid','mode','nlink'].map(k => [k,s[k]]));
function snapshot(file, kind) {
  assert.equal(fs.realpathSync(file),file);const stat=fs.lstatSync(file);
  assert.ok(!stat.isSymbolicLink() && (kind==='directory'?stat.isDirectory():stat.isFile()));
  assert.equal(stat.uid,1004);assert.equal(stat.gid,1004);assert.equal(stat.mode & 0o022,0);
  assert.equal(stat.dev,fs.statSync('/data').dev);if(kind==='file')assert.equal(stat.nlink,1);
  return fields(stat);
}
export function assertWholeHdDrain(state, members, processes, originalPid) {
  assert.equal(state.ActiveState,'inactive');assert.equal(state.MainPID,'0');assert.equal(state.ControlPID,'0');
  assert.equal(state.Result,'success');assert.equal(state.Restart,'no');assert.equal(state.SendSIGKILL,'no');
  assert.equal(state.TimeoutStopUSec,'infinity');assert.equal(state.WorkingDirectory,releaseDependencyRoot(MV_DIRECT));
  assert.deepEqual(members,[]);
  assert.ok(!processes.some(p=>p.pid===originalPid || p.related), 'Original or escaped HD processor/ffmpeg remains');
  return true;
}
function processInventory() {
  return fs.readdirSync('/proc').filter(n=>/^\d+$/.test(n)).flatMap(n=>{
    try {const args=fs.readFileSync('/proc/'+n+'/cmdline').toString().split('\0').filter(Boolean);
      const group=fs.readFileSync('/proc/'+n+'/cgroup','utf8');
      return [{pid:Number(n),related:args.some(a=>/(?:^|\/)process-hd-(?:image|derivatives)\.ts$/.test(a)
        || /^(?:ffmpeg|ffmpeg-[\w.-]+)$/.test(path.basename(a))) || group.includes('/sd2-hd-derivatives.service')}];
    } catch(e){if(['ENOENT','ESRCH'].includes(e.code))return [];throw e;}
  });
}
function groupMembers(directory) {
  if(!fs.existsSync(directory))return [];
  assert.equal(fs.realpathSync(directory),directory);
  return [...new Set([...fs.readFileSync(directory+'/cgroup.procs','utf8').trim().split(/\s+/).filter(Boolean).map(Number),
    ...fs.readdirSync(directory,{withFileTypes:true}).filter(x=>x.isDirectory()).flatMap(x=>groupMembers(directory+'/'+x.name))])];
}
function retiredHdOperationalIdentity(m) {
  const hd=operationalLive(m,'hd');assert.equal(hd.root,m.live.hd.root);
  if(hd===m.live.hd)assert.equal(hd.pid,MV_DIRECT.starts.hd[0]);
  else {assert.ok(isSharedEngine(m)&&m.fullRelease&&!m.protectedIncrement&&m.privateMultiviewInstall===true);assert.equal(hd.source,m.live.hd.source);}
  return hd;
}
export function inspectRetiredHdCaches(m,phase) {
  assert.equal(m.runId,RUN);assert.ok(['admission','drained'].includes(phase));
  assert.equal(m.hdRoot,ROOT);assert.equal(m.live.hd.root,releaseDependencyRoot(MV_DIRECT));
  const hd=retiredHdOperationalIdentity(m);
  assert.equal(fs.readdirSync(ROOT).some(name=>name.includes('.lock')||name.endsWith('.publish.json')||name.endsWith('.tmp')),false);
  const jobs=OBJECTS.map(object=>{
    const file=ROOT+'/'+object.key+'.json',bytes=fs.readFileSync(file),job=JSON.parse(bytes);
    assert.equal(sha(bytes),object.sha256);assert.equal(job.status,object.status);assert.equal(job.attempts,object.attempts);
    if(object.status==='failed')assert.equal(job.reason,'encode_timeout');
    assert.equal(job.protocol,'hd-job-v2');assert.ok(!job.stage&&Number.isFinite(Date.parse(job.executionExitedAt)));
    return {object,file,bytes,job};
  });
  for(const [file,digest] of Object.entries({
    'src/lib/media/hd-derivatives.ts':'7442f68dd8ce7db49390293e722107c2bc57b72ea43976541427978076858fbf',
    'src/lib/media/hd-image-processor.ts':'59b3662cd0e7d4bdc3723f48477b1e68d4563dce0cca1a4b92e6171b81faa0c5',
    'scripts/process-hd-derivatives.ts':'037904c2e9e18794eb745387d29da7d2e30eee1c1170f432468a73d4c63ce57d',
  }))assert.equal(sha(fs.readFileSync(SOURCE+'/'+file)),digest);
  const entries=jobs.flatMap(({object,bytes:jobBytes,job})=>object.runs.map((suffix,index)=>{
    const run=object.key+'.'+suffix;
    const attempt=job.attemptHistory[index],next=job.attemptHistory[index+1];
    assert.equal(attempt.attempt,index+1);assert.equal(attempt.status,'queued');assert.equal(attempt.reason,'encode_timeout');
    assert.equal(attempt.sourceVersion,job.version);assert.ok(Date.parse(attempt.finishedAt)<Date.parse(next.startedAt));
    const directory=ROOT+'/.runs/'+run,cache=directory+'/tsx-1004';
    const directoryStat=snapshot(directory,'directory'),cacheStat=snapshot(cache,'directory');
    assert.deepEqual(fs.readdirSync(directory),['tsx-1004']);
    const names=fs.readdirSync(cache).sort();assert.equal(names.length,3);
    const files=names.map(name=>{const match=/^(\d+)-([a-f0-9]{40})$/.exec(name);assert.ok(match && CACHE[match[2]]);
      const file=cache+'/'+name,before=snapshot(file,'file'),bytes=fs.readFileSync(file),known=CACHE[match[2]];
      assert.equal(sha(bytes),known[0]);assert.equal(Number(match[1]),Math.floor(before.mtimeMs/1e8));
      const value=JSON.parse(bytes);assert.deepEqual(Object.keys(value).sort(),['code','map','warnings']);
      assert.deepEqual(value.map.sources,[SOURCE+'/'+known[1]]);assert.deepEqual(value.warnings,[]);
      assert.deepEqual(snapshot(file,'file'),before);return {name,sha256:known[0],stat:before};});
    for(const stat of [directoryStat,cacheStat,...files.map(x=>x.stat)])for(const k of ['mtimeMs','ctimeMs'])
      assert.ok(stat[k]>=Date.parse(attempt.startedAt)&&stat[k]<=Date.parse(attempt.finishedAt));
    assert.deepEqual(snapshot(directory,'directory'),directoryStat);assert.deepEqual(snapshot(cache,'directory'),cacheStat);
    return {run,jobSha256:sha(jobBytes),directory:directoryStat,cache:cacheStat,files};
  }));
  let drain=null;
  if(phase==='drained') {
    const state=Object.fromEntries(call(['show','sd2-hd-derivatives.service',...['ActiveState','MainPID','ControlPID','Result','Restart','SendSIGKILL','TimeoutStopUSec','WorkingDirectory'].flatMap(k=>['-p',k])]).split('\n').map(line=>{const i=line.indexOf('=');return[line.slice(0,i),line.slice(i+1)]}));
    const members=groupMembers('/sys/fs/cgroup/system.slice/sd2-hd-derivatives.service'),processes=processInventory();
    assertWholeHdDrain(state,members,processes,hd.pid);
    drain={state,cgroupEmpty:true,originalPidAbsent:true,relatedProcessorsAbsent:true,method:'current-whole-service-natural-drain-not-historical-PID-reconstruction'};
  }
  for(const {file,bytes} of jobs)assert.equal(sha(fs.readFileSync(file)),sha(bytes));
  assert.equal(entries.length,4);
  return {schema:'specific-retired-hd-cache.v1',runId:RUN,phase,accepted:phase==='drained',historicalPidsRecovered:false,
    exactObjectCount:4,authorization:'Supervisor exact four-cache whole-service-drain extension; no unknown cache/source/writer acceptance',entries,drain,readOnly:true};
}
