import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '改善新图片的下载恢复：下载中断后继续获取同一张原图，不会自动再次付费生成。恢复仍失败或链接过期时释放冻结积分；已发生且没有保存链接的旧任务不能自动找回。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
