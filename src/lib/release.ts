import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '修复人物生成完成后历史卡仍显示排队、缺少缩略图的问题；提交与任务结束时同步刷新点数余额，不重复生成或扣费。单张四宫格和恢复设置操作行保持可用。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
