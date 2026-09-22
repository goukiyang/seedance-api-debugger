import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '图片生成支持最高质量默认值、管理员/创作者模板、分组子项快捷栏和3:4模板封面页。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
