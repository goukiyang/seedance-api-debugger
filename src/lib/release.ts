import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '图片生成未确认时可查询原提交，不会自动重复生成。已返回原图先保存恢复资料，慢速下载可有界延长；下载、校验和保存状态分开显示，完整交付后才完成。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
