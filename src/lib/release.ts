import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '精简画布工具栏的重复信息，保留画布管理与保存操作；顶部新增图片生成入口。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
