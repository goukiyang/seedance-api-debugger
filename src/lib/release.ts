import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '恢复设置已并入图片下方下载、复制、预览操作行，悬停或键盘聚焦时显示，图片单击仍只选中；人物描述失败恢复及默认单张四宫格保持可用。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
