import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '统一旧页面、弹窗、表单与菜单的深夜配色，保留图片、视频和画布作品原色。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
