import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '设置模板可以改名、更新和删除；模块上下文新增稳定五位版本码；生成按钮移到主图上方，结果卡移除交付详情。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
