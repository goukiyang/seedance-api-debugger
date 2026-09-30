import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '用户管理新增周期额度：按岗位或成员独立设置刷新周期，支持发布、暂停及补齐漏发；账户统一显示周期额度和跨期冻结点数。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
