import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '图片生成统一走独立 API，新增 Banana 2、Banana Pro、GPT Image 2 与 2.5 模型及上游成本记录。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
