import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '人物文案先主动分析，显示理解和待补充条件，再确认四宫格图片费用。改画质保留原人物，改描述不再沿用旧报价；补充胡须条件，旧图和历史继续保留。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
