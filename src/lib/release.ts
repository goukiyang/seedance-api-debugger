import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '人物新增九宫格、直接选格与本地裁格下载，补充国家、混血和细分发型，生成记录按描述命名。模板记录分开人物来源，等待时显示本次主图，替换主图可关闭提醒并恢复。创作首页按五类整理入口。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
