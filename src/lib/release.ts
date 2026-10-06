import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '修复直接查看生成图片后仍提醒未读的问题，只有成功查看的对应结果会记为已读，新结果仍保留提醒。侧栏数量增加单位，区分模板总数与未读蓝点。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
