import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '修复人物描述回复多包一层数组导致的解析失败，已有回复可免费重检；恢复设置并入下载、复制、预览同一行，悬停或聚焦时显示。默认单张四宫格保持可用。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
