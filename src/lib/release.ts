import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '无线画布新增可保存、可恢复、可并行执行的图片工具流，并支持结果筛选、人工确认和失败重试。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
