import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '无线画布默认进入步骤式工具流，可直接选择素材和生图模板，支持上传/粘贴图片并保留高级画布。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
