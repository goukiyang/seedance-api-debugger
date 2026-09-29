import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '添加图片可选本地上传或资产库；已有图片按已生成、已上传分类选择。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
