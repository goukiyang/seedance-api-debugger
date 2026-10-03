import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '顶部导航固定显示；图片结果单击恢复设置、双击放大；资产视频封面单击播放，查看按钮独立靠右，点赞收藏统一放在封面左上。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
