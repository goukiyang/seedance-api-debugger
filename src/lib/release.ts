import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '大图可独立缩放和自由对比，关闭对比时也能直接换图；顶部粘贴替换全文。图片结果按屏幕宽度分页，每页最多三行；模板切换后刷新保留当前位置，窄屏导航定位修正。批量按素材确认数量和点数；抠图统一选图，未绑定账户仍不能提交任务。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
