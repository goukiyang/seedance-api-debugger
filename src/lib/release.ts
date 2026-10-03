import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '全站确认与名称、理由输入统一为网站窗口；更新时在同一窗口处理未保存内容，保存和上传完成后再刷新，避免重复询问。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
