import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '画布新增风格广场与文本快捷创作栏，优化输入面板和左右连接菜单。文本生成可选模板页同款六种模型，全站通用规则与节点专属规则分开保存。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
