import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '图片预览独立浮层支持参考图切换；生成结果操作改为悬浮图标并支持一键复制图片。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
