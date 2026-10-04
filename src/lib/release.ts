import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '资产视频封面和播放完整显示，风格组点击卡片直接选用，主图等数量控件与标题等高。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
