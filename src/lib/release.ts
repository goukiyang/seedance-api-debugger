import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '主图预览放大，满额隐藏添加入口；手机和平板可直接选择分组和模块。视频比例、时长和分辨率可按模型支持范围调整；模块上下文未修改可直接关闭。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
