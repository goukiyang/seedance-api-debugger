import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '模板侧栏记住展开状态，未读结果自动展开分类，标题可定位列表，新增我的收藏和图片生成分类。素材筛选更清楚，上传入口移到底部。完成提醒收进通用设置，单次与批量操作更紧凑；生成等待时只显示模糊小图或占位。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
