import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '图片工作室的大图查看器提供单参考图对比入口、左右/上下切换、同步缩放平移与结果切换；同时支持原图比例与分辨率、模板封面分页和上下文复制，并修复图片上传目录权限、封面分页刷新恢复和画布并行连线命中问题。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
