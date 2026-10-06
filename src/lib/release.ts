import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '喜欢按钮动画结束不再留下双心，圆形背景更小。人物生成以分格候选为主，参考图、生成和正文在图片下方；可从素材、喜欢、最近或上传中选择参考图，刷新后保留草稿。整图预览、下载和单格裁图仍保留。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
