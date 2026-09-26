import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '指定项目可试用视频角色替换，并可设置单次积分上限；原有生成方式不变。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
