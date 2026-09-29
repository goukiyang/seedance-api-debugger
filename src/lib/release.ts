import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '模板标题旁新增删除按钮，确认后移除模板，保留已生成图片。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
