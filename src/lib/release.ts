import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '新增图片生成页面，支持两张参考图、多张生成、预览和打包下载；管理员可自动保存生成规则与每张积分。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
