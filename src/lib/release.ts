import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '改善图片下载超时处理，生成与下载分别计时；提交、排队等正常进度不再显示为红色错误。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
