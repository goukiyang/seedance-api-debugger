import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '生图模板支持自适应 banner、固定参考图数量、单图粘贴覆盖、自动保存和模型质量同排设置；无线画布继续默认进入步骤式工具流。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
