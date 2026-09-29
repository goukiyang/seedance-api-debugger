import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '新增删除模板按钮；模型、质量与分辨率自动保存，可直接生成。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
