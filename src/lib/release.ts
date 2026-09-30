import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '新增统一点赞收藏，资产页可集中找回图片、视频、音频、模板与已保存文案；支持分类搜索和取消撤销。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
