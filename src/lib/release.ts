import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '放大图片支持右键和顶部按钮复制，收藏旁可将自己的图片分享给站内用户。修复模板页已保存草稿仍反复提示离开的问题。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
