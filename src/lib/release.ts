import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '图片生成支持模块级模型与计费规则、最多 10 张参考图，并为每张结果保存完整设置快照，生成结果可在资产库复用。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
