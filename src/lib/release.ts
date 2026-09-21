import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '视频生成提示词上限提升到 20,000 字，输入、恢复、保存和提交校验保持一致。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
