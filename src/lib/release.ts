import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '人物描述解析失败后保留草稿，已有回复可免费重检，结果未知时不自动重试；默认生成一张四宫格图片，四格为不同人物，按一张计费，也可选择独立头像。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
