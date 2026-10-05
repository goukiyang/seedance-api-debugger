import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '手机返回先关闭大图，保留当前页面。人物描述作为主输入，其他条件可选；未指定的外观随机补齐，主动选择仍可补充要求。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
