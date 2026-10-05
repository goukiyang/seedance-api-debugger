import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '人物任务查询失败后可继续查询原提交；受理未知时不能微调或重复生成，较早返回的旧状态不再盖掉成功图片。保留单张四宫格、历史缩略图和余额同步。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
