import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '历史图片设置直接恢复，原恢复按钮改为查看图标并去掉重复入口，顶栏版本号放大50%。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
