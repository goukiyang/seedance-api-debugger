import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '视频封面播放时隐藏中央按钮，保留点击暂停、继续播放以及等待和错误提示。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
