import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '新增模板批量生成、暂停与批次找回，可保存到所选目录或分包下载。演化内容可选递进或递减。生成完成可提醒或开启提示音，人物结果与历史图片支持放大预览。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
