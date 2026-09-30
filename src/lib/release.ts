import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '模板可添加带备注的固定参考图并调整顺序；精简结果卡片和预览工具栏，保护内部上下文。恢复资产右侧详情，优化竖图竖片和大图读取进度，模板入口记住上次使用位置。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
