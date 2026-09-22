import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '图片 API 支持五个图片模型和两个独立通道；用户模块、任务与资产按账号隔离，管理员可审计。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
