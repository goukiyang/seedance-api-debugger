import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '模板名称右侧只保留收藏；工作台新增我的收藏入口，可查找、使用和取消收藏的模板。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
