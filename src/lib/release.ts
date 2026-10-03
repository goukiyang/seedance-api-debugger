import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '添加图片和视频参考直接进入素材库；库内上传、搜索、收藏、最近选用和图集项目导航统一，选好后按顺序加入。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
