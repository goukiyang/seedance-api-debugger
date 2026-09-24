import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '图片模板新增管理员共享开关；公司飞书同事可使用共享模板，模板素材和个人配置按权限隔离。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
