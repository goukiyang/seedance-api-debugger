import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '刷新更新不再重复确认；已保留的模板草稿不再误报丢失；外部账号不显示具体更新内容。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
