import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '修复刷新后新分组和模板不显示；左栏显示完整目录，模块内容按需加载。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
