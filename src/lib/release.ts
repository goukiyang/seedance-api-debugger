import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '图片生成可选择常用比例，自动保存自定义比例；生成图片新增删除按钮和二次确认，保留其他模块与参考图。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
