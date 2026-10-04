import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '设置保存成功后自动关闭或返回；保存失败保留输入，多个设置同时编辑时不会丢掉未保存内容。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
