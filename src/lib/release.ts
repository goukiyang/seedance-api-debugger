import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '缩小模板页横幅，完整显示图片，不再挤走下方操作区域。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
