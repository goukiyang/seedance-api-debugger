import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '模板参考图和banner显示真实上传进度，传完后单独显示服务器处理状态。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
