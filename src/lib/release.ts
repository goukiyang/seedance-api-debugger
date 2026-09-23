import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '无线画布支持模板并联与汇合、主路径整理、节点上下文独立保存、节点内输入图片操作和满屏深色工作区。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
