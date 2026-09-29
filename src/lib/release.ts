import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '新增图片与视频模板工作台。视频提示词可保存草稿、复用历史输入，并带素材进入生成页；旧图片工具和视频模板继续保留。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
