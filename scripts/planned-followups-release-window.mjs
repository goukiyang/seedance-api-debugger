import fs from 'node:fs';
import { appendRegistryLine } from '/Users/gouki-youdoo/.codex/skills/release-window-coordination/scripts/release-registry-append.mjs';
import { buildRecentActivityDecision, confirmReservation } from '/Users/gouki-youdoo/.codex/skills/release-window-coordination/scripts/release-recent-activity-check.mjs';
const [mode, commit] = process.argv.slice(2);
const registry = '/Volumes/Data/Projects/project-version-registry.md', runId = 'planned-followups-reviewfixes-20261007', projectName = 'video-api-debugger';
if (!['start', 'renew', 'check', 'finish', 'failed'].includes(mode) || !/^[a-f0-9]{40}$/.test(commit || '')) throw Error('Invalid release arguments');
const decision = buildRecentActivityDecision(fs.readFileSync(registry, 'utf8'), { projectName });
if (decision.recentActivities.some(activity => activity.runId !== runId)) throw Error('Another release is active');
const write = async action => {
  const result = await appendRegistryLine({ registry, projectName, action, runId, commit, branch: 'codex/image-compare-20261006', targetUrl: 'https://sd2.youdooart.com/template-studio?type=image',
    note: 'v0.50.0 同一17项授权批次；不改绑定/权限/点数，不做收费生成；隔离回归及保护发布后由主管Ego68统一真实UI检查，CUT真实图受本人绑定前置阻碍。' });
  if (!result.confirmed) throw Error('Reservation append failed');
};
if (mode === 'start' || mode === 'renew') await write('部署开始');
if (!confirmReservation(fs.readFileSync(registry, 'utf8'), { projectName, runId }).canProceed) throw Error('Reservation ownership lost');
if (mode === 'finish' || mode === 'failed') await write(mode === 'finish' ? '部署完成' : '部署失败');
console.log(JSON.stringify({ mode, runId, reservationConfirmed: true }));
