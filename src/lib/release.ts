import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '新增抽帧动画工作台，可导入素材、同步对照动作、核对帧时值并导出工作副本；沿用项目权限，原有生成方式不变。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
