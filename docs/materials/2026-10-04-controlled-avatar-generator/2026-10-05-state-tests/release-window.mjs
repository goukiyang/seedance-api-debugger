import fs from 'node:fs';
import {buildRecentActivityDecision,confirmReservation,parseRegistryActivities} from '/Users/gouki-youdoo/.codex/skills/release-window-coordination/scripts/release-recent-activity-check.mjs';
import {appendRegistryLine} from '/Users/gouki-youdoo/.codex/skills/release-window-coordination/scripts/release-registry-append.mjs';
const registry='/Volumes/Data/Projects/project-version-registry.md';
const projectName='video-api-debugger';
const runId='avatar-state-repair-20261005-907a7a2';
const commit='907a7a2b4d2a16c60206900045170bd4e3fd7cad';
const mode=process.argv[2]||'confirm';
if(mode==='start'){
  const d=buildRecentActivityDecision(fs.readFileSync(registry,'utf8'),{projectName});
  console.log(JSON.stringify({shouldWait:d.shouldWait,recentActivities:d.recentActivities}));
  if(d.shouldWait)process.exit(75);
}
if(mode==='start'||mode==='renew'){
  if(mode==='renew'){
    const recent=parseRegistryActivities(fs.readFileSync(registry,'utf8'),{projectName}).filter(a=>a.timestamp&&Date.now()-a.timestamp.getTime()<=300000&&Date.now()>=a.timestamp.getTime());
    if(recent.some(a=>a.runId!==runId))throw Error('Foreign release activity; do not renew');
  }
  await appendRegistryLine({registry,projectName,action:'部署开始',runId,branch:'codex/avatar-generator-20261005',commit,targetUrl:'https://sd2.youdooart.com',note:'0.42.3有限状态修复；web-only；零新模型费用；保留0.42.2源码/build回退'});
}
const decision=confirmReservation(fs.readFileSync(registry,'utf8'),{projectName,runId});
console.log(JSON.stringify(decision));
if(!decision.canProceed)process.exit(75);
