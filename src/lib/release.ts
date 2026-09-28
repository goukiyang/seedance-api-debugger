import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '普通生成选择 Seedance 2.5 后，时长可选到30秒；切换模型会提示不适用的时长，费用按实际秒数预估。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
