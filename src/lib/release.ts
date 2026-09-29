import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '整理模板页左侧分组栏，标题不再被遮挡，保留侧栏和页面各自滚动。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
