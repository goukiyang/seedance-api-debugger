import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '另存模板后可在默认旁快捷套用；点击历史生成图片会恢复当时的上下文提示词，不混入当前上下文。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
