import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '修复大图预览时滚轮影响底层页面的问题，关闭预览后恢复网页操作。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
