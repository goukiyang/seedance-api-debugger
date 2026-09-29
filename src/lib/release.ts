import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '改善生成图片下载，支持安全跳转和有限重试；下载失败原因单独提示。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
