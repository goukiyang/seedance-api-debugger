import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '模板图片区与生成操作更紧凑；打开模板后确认本批新结果提醒；对比图固定左右、联动锁直接可见；素材卡简化，首页恢复图标入口，生成中的参考图铺满预览框。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
