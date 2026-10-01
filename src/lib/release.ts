import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '图片模板按主图、风格组、参考图分区，使用方形缩略图与独立数量设置；风格组显示封面和名称。隐藏视频卡相关展示，保留已有生成记录。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
