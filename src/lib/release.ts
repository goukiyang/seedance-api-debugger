import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '文件准备与可下载状态分开显示；刷新列表保留已有内容，失败可重试。历史图片可恢复设置，画布阶段更清楚；等待使用局部刷光，确认框和记录时间统一。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
