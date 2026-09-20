import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '修复图片取图；支持仅图片生成和粘贴图片。可保存、新建多个模块，分别设置模块上下文，并统一应用通用上下文。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
