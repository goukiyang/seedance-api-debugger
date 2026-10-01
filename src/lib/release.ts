import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '图片模板区分主图与辅助参考，可分别设置数量；未保存的参数和上下文可直接生成。支持一键清空本次辅助参考，风格组整体备注随素材使用，多张主图仍可与主图一对比。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
