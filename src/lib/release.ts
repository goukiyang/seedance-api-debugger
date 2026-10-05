import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '已点赞或收藏的左上角图标持续显示；未激活按钮仍按悬停、聚焦或触控方式显示。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
