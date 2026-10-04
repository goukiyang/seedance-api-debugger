import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '素材标题更紧凑，点击结果立即套用并显示来源；模板新结果用蓝点提醒并记住已看状态，支持的图片模型可选择4:1。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
