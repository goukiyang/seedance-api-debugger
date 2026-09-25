import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '大图先显示缩略图，再加载高清预览；可切换完整原图，加载失败支持重试，下载画质不变。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
