import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '资产视频封面补充实际扣点显示；现金金额和站内点数明确区分。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
