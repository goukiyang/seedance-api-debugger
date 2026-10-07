import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '生成完成时后台标签温和提醒；参考图区与结果卡更紧凑，清空操作归位；图片先显示缩略图并并行读取清晰预览，原图和图片包交给浏览器下载。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
