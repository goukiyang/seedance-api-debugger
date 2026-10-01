import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '新增可复用风格组，管理员和创建者可管理内容，同事通过封面选用；模板固定图对普通用户隐藏但仍参与生成。参考图更紧凑，备注可单独保存；资产缩略图完整显示，弹窗支持安全点击空白关闭。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
