import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '画布文本可预览拆分为独立视频方案，原文和草稿保留。每个方案单独生成，提交未确认时可找回原任务；生成记录可预览、下载并明确选用，不会自动重跑。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
