import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '修复4K图片保存限制；模板内容自动保存、分组即时同步，设置改为手动保存。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
