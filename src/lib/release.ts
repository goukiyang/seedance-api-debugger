import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '模板页面的保存、确认和生成按钮更清楚。命名在入口旁填写，删除、发布、替换和未保存退出使用站内确认弹窗，取消保留当前内容。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
