import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '修复切图后喜欢按钮重复；我的喜欢在模板侧栏展开；分组删除移入分组菜单，删除模块只留图标；大图先显示缩略图再加载高清预览。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
