import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '图片结果统一模型简称并显示生成者头像；放大预览围绕鼠标位置缩放。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
