import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '生图封面与结果列表优先加载轻量缩略图，打开大图和下载仍保留原图质量。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
