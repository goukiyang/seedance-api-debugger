import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '修复画布图片生成节点无法选择模型；模型选择随节点保存，生成使用所选模型。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
