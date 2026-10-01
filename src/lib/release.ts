import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '修复切换模板时通用上下文草稿异常，清空前增加确认；现有和新建图片模板、历史任务重新生成都会合并当前通用上下文，保留模板自己的内容。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
