import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '画布生图模型菜单改为左侧模型、右侧小字积分；移除底部重复积分和后台计费文案。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
