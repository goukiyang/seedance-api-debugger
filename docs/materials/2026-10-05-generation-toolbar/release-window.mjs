import fs from 'node:fs';
import { appendRegistryLine } from '/Users/gouki-youdoo/.codex/skills/release-window-coordination/scripts/release-registry-append.mjs';
import { confirmReservation } from '/Users/gouki-youdoo/.codex/skills/release-window-coordination/scripts/release-recent-activity-check.mjs';

const registry = '/Volumes/Data/Projects/project-version-registry.md';
const projectName = 'video-api-debugger';
const [mode, commit, runId] = process.argv.slice(2);
if (!['finish', 'failed'].includes(mode) || !/^[a-f0-9]{40}$/.test(commit || '') || !runId) throw Error('Expected finish|failed, exact commit, and parent run ID');
const contents = fs.readFileSync(registry, 'utf8');
const reservation = confirmReservation(contents, { projectName, runId });
console.log(JSON.stringify(reservation));
if (!reservation.canProceed) throw Error('Parent release-window reservation is not confirmed');
await appendRegistryLine({
  registry,
  projectName,
  action: mode === 'finish' ? '部署完成' : '部署失败',
  runId,
  branch: 'codex/avatar-generator-20261005',
  commit,
  targetUrl: 'https://sd2.youdooart.com',
  note: 'D1/D2/D3：生成图片按钮归位；人物正文一键理解并提交图片，保留变价、未知受理和旧草稿保护；v0.43.3。安全发布检查完成，待用户手动验收；模型调用0、费用0；未做浏览器/截图/业务功能验收；正式根记录与素材归档由父级登记。',
});
