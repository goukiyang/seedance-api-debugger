import fs from 'node:fs';
import { appendRegistryLine } from '/Users/gouki-youdoo/.codex/skills/release-window-coordination/scripts/release-registry-append.mjs';
import { buildRecentActivityDecision, confirmReservation } from '/Users/gouki-youdoo/.codex/skills/release-window-coordination/scripts/release-recent-activity-check.mjs';
const [mode, commit] = process.argv.slice(2);
const registry = '/Volumes/Data/Projects/project-version-registry.md', runId = 'planned-followups-page18-20261007', projectName = 'video-api-debugger';
if (!['start', 'renew', 'check', 'finish', 'failed'].includes(mode) || !/^[a-f0-9]{40}$/.test(commit || '')) throw Error('Invalid release arguments');
const decision = buildRecentActivityDecision(fs.readFileSync(registry, 'utf8'), { projectName });
if (decision.recentActivities.some(activity => activity.runId !== runId)) throw Error('Another release is active');
const write = async action => {
  const result = await appendRegistryLine({ registry, projectName, action, runId, commit, branch: 'codex/image-compare-20261006', targetUrl: 'https://sd2.youdooart.com/template-studio?type=image',
    note: 'v0.50.0 同一17项+PAGE18授权批次；接续已只读确认旧候选未切、无发布占用；不改绑定/权限/点数、不收费；隔离统一Verify/Review及保护发布，真实浏览器归主管。CUT/NAV/PIN三缺口及新反馈同行/左右顺序未实施保留。' });
  if (!result.confirmed) throw Error('Reservation append failed');
};
if (mode === 'start' || mode === 'renew') await write('部署开始');
if (!confirmReservation(fs.readFileSync(registry, 'utf8'), { projectName, runId }).canProceed) throw Error('Reservation ownership lost');
if (mode === 'finish' || mode === 'failed') await write(mode === 'finish' ? '部署完成' : '部署失败');
console.log(JSON.stringify({ mode, runId, reservationConfirmed: true }));
