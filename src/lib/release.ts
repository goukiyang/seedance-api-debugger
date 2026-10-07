import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '上下文粘贴可用时亮起，数量设置更紧凑；当前模板可筛选自己喜欢的生成结果；大图两侧选图入口靠近中央对比按钮。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
