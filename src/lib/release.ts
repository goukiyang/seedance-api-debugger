import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '视频文案模板新增GPT模型下拉选择，支持5.6 Luna/Sol和6 Luna/Sol/Astra；生成记录保留所选模型。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
