import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '批量下载显示打包和接收状态；未自动开始时，可直接点击保存视频包，无需重新打包。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
