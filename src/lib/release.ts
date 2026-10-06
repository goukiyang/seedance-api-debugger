import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '点赞和收藏合并为一个“喜欢”按钮，原有记录统一到“我的喜欢”；旧收藏保留且仍私密，不加入公开喜欢人数。点击喜欢采用新的心形绽放反馈。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
