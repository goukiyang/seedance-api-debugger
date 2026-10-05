import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '生成图片按钮移到参考图下方、补充文案上方；人物正文一次点击自动理解并提交图片，费用和未确认状态保护保留。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
