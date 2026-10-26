import fs from 'node:fs';
import { appendRegistryLine } from '/Users/gouki-youdoo/.codex/skills/release-window-coordination/scripts/release-registry-append.mjs';
import { buildRecentActivityDecision, confirmReservation } from '/Users/gouki-youdoo/.codex/skills/release-window-coordination/scripts/release-recent-activity-check.mjs';
const [mode, commit] = process.argv.slice(2);
const registry = '/Volumes/Data/Projects/project-version-registry.md';
const runId = 'unified-likes-20261006';
const projectName = 'video-api-debugger';
if (!['start', 'renew', 'check', 'finish', 'failed'].includes(mode) || !/^[a-f0-9]{40}$/.test(commit || '')) throw Error('Invalid release stage/commit');
const decision = buildRecentActivityDecision(fs.readFileSync(registry, 'utf8'), { projectName });
if (decision.recentActivities.some(activity => activity.runId !== runId)) throw Error('Another release is active');
const write = async action => {
  const result = await appendRegistryLine({ registry, projectName, action, runId, commit,
    branch: 'codex/unified-likes-20261006', targetUrl: 'https://sd2.youdooart.com/assets?view=favorites',
    note: 'v0.49.0 LIKE1-LIKE3；合并喜欢，历史私密收藏不公开；无迁移/付费/权限扩大；候选构建、回退保护、静态发布检查，功能待用户手验。' });
  if (!result.confirmed) throw Error('Reservation append failed');
};
if (mode === 'start' || mode === 'renew') await write('部署开始');
const reservation = confirmReservation(fs.readFileSync(registry, 'utf8'), { projectName, runId });
if (!reservation.canProceed) throw Error('Reservation ownership lost');
if (mode === 'finish' || mode === 'failed') await write(mode === 'finish' ? '部署完成' : '部署失败');
console.log(JSON.stringify({ mode, runId, reservationConfirmed: true }));
