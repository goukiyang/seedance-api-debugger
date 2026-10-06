import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '视频模板的参考图移到需求输入框上方，可选图、预览、移除和调整用途。视频、音频及生成参数仍可展开设置。顶栏移除超分快捷入口，原超分功能保留。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
