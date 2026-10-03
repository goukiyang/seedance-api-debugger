import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '小确认框和命名框靠近触发按钮，不再跑到角落；小屏和输入键盘弹出时自动避让。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
