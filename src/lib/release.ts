import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '视频模板参考图改为同组加号图片块；创作首页在手机顶栏也能直接打开；大图工具栏收成单行，缩放、复制和对比设置仍可使用。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
