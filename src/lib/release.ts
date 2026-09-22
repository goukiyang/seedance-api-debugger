import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '接入 Seedance 2.5 样片 Draft 到 1080p 正式生成的本地任务链路；真实供应商升级能力默认保持门控。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
