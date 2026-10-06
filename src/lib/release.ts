import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '修复直接打开或刷新视频生成页后，添加参考图和图集参考不打开的问题。登录状态读取失败时可重新检查，原素材选择与生成设置保留。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
