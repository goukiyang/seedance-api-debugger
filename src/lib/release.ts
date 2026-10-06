import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '模板侧栏记住展开状态，新结果提醒会展开对应分类，点击标题可定位列表，新增我的收藏和图片生成分类。素材选择器整理范围、来源与排序，单一图片类型不再重复选择，上传素材移到底部。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
