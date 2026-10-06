import fs from 'node:fs';
import { appendRegistryLine } from '/Users/gouki-youdoo/.codex/skills/release-window-coordination/scripts/release-registry-append.mjs';
import { buildRecentActivityDecision, confirmReservation } from '/Users/gouki-youdoo/.codex/skills/release-window-coordination/scripts/release-recent-activity-check.mjs';
const [mode, commit] = process.argv.slice(2);
const registry = '/Volumes/Data/Projects/project-version-registry.md', runId = 'like21-avui21-20261007', projectName = 'video-api-debugger';
if (!['start', 'renew', 'check', 'finish', 'failed'].includes(mode) || !/^[a-f0-9]{40}$/.test(commit || '')) throw Error('Invalid release arguments');
const decision = buildRecentActivityDecision(fs.readFileSync(registry, 'utf8'), { projectName });
if (decision.recentActivities.some(activity => activity.runId !== runId)) throw Error('Another release is active');
const write = async action => {
  const result = await appendRegistryLine({ registry, projectName, action, runId, commit, branch: 'codex/image-compare-20261006', targetUrl: 'https://sd2.youdooart.com/tools/avatar-studio',
    note: 'v0.51.0 LIKE21+AVUI21限定授权；共享喜欢单心和紧凑圆背景、头像候选布局及真实可选参考。仅构建/源码Review/候选产物/健康/公网检查，功能待用户手动验收；不跑浏览器/业务回归/收费模型，不改鉴权支付数据库，不重启图片worker。其他冻结保持。' });
  if (!result.confirmed) throw Error('Reservation append failed');
};
if (mode === 'start' || mode === 'renew') await write('部署开始');
if (!confirmReservation(fs.readFileSync(registry, 'utf8'), { projectName, runId }).canProceed) throw Error('Reservation ownership lost');
if (mode === 'finish' || mode === 'failed') await write(mode === 'finish' ? '部署完成' : '部署失败');
console.log(JSON.stringify({ mode, runId, reservationConfirmed: true }));
