import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '人物生成按完整原描述理解，简短描述不再被预设分类拦住；补充条件可选，四宫格和独立头像都保留原意。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
