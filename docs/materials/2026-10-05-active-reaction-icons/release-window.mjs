import fs from 'node:fs';
import { appendRegistryLine } from '/Users/gouki-youdoo/.codex/skills/release-window-coordination/scripts/release-registry-append.mjs';
import { buildRecentActivityDecision, confirmReservation } from '/Users/gouki-youdoo/.codex/skills/release-window-coordination/scripts/release-recent-activity-check.mjs';

const [mode, commit, runId] = process.argv.slice(2);
if (!['start', 'renew', 'check', 'finish', 'failed'].includes(mode) || !/^[a-f0-9]{40}$/.test(commit || '') || !/^[A-Za-z0-9-]+$/.test(runId || '')) throw Error('Invalid release guard arguments');
const registry = '/Volumes/Data/Projects/project-version-registry.md', projectName = 'video-api-debugger';
const contents = fs.readFileSync(registry, 'utf8');
const decision = buildRecentActivityDecision(contents, { projectName });
const foreign = decision.recentActivities.filter(activity => activity.runId !== runId);
console.log(JSON.stringify({ mode, runId, shouldWait: foreign.length > 0, foreign }));
if (foreign.length) throw Error('Another release occupies this project window');
const write = async action => {
  const result = await appendRegistryLine({ registry, projectName, action, runId, branch: 'codex/avatar-generator-20261005', commit, targetUrl: 'https://sd2.youdooart.com', note: 'E1/E2：已点赞/收藏的左上角激活图标常显，未激活与分享保留情境显示；v0.43.4；仅共享样式和真实按钮标记；发布检查不代表用户验收；业务调用0、费用0；正式根记录由父级归档。' });
  console.log(JSON.stringify({ line: result.line, confirmed: result.confirmed }));
};
if (mode === 'start' || mode === 'renew' || (mode !== 'check' && !confirmReservation(contents, { projectName, runId }).canProceed)) await write('部署开始');
const confirmed = confirmReservation(fs.readFileSync(registry, 'utf8'), { projectName, runId });
console.log(JSON.stringify(confirmed));
if (!confirmed.canProceed) throw Error('Release reservation not confirmed');
if (mode === 'finish' || mode === 'failed') await write(mode === 'finish' ? '部署完成' : '部署失败');
