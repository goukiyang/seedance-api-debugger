import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '视频模板支持通用与模块上下文生成文案，结果可编辑后带到视频生成；头像姓名并入结果信息行。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
