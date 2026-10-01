import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: 'IP 生成新增 Seedance 2.5，支持最长 30 秒并分别记住生成参数；补齐历史素材恢复、提交异常保护和视频保存重试。反馈窗口支持直接粘贴图片，不再限制图片张数。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
