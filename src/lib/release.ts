import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '修复画布选择多张却只出一张的问题；多张结果分别展示，部分完成会说明实际交付数量。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
