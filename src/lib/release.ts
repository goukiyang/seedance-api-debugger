import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '修复放大图片拖动后预览意外关闭的问题，保留原有页面布局和关闭操作。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
