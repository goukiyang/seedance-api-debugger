import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '新增人物生成工具和参考区入口；素材窗口可从我的素材库删除并撤销；生成图片单击只选中，下方悬停显示恢复设置按钮。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
