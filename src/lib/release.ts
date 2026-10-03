import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '资产视频封面显示扣费金额；无账单时按普通生成相同费率估算，不再只显示点数。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
