import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '图片工作室支持原图比例与分辨率、生成结果对比与大图切换、模板封面分页和上下文复制；同时修复图片上传目录权限。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
