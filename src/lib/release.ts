import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '修正画布生图接口地址，参考图和图片质量与模板生图使用同一接口处理；异常时提示更清楚。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
