import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '模块保存按钮移到数量设置下方；新建图片模块和模板默认最多选 1 张主图，已有设置不变。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
