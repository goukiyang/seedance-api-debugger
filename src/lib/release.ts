import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '修复人物文案背景格式校验，已保存回复可免费重检，不必重新收费分析。胡茬不再误标为伤痕或猜具体位置；原文条件、旧图和历史继续保留。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
