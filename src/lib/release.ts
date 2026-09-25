import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '新增个人画布列表、新建、保存与恢复入口，仅本人可访问；修复多张生图与结果展示。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
