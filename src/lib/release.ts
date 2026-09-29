import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '图片参数保留为临时草稿，刷新后可恢复；模板页记住浏览位置，并修复设置读取误报。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
