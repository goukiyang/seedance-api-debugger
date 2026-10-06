import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '管理中心新增视频、超分和图片的生成耗时统计，可按日期查看平均和较慢任务用时，展开模型与线路明细并导出；缺失时间记录明确标注，不与视频时长混淆。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
