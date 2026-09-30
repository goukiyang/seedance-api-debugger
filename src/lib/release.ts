import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '统一图片和视频预览，竖图竖片完整显示；优化缩放、播放和返回位置，关闭大图保留选择。旧页面请刷新后使用新的素材预览入口。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
