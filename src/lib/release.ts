import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '修复素材替换失败丢失原选择、混合选图漏项和长时长模板无法继续生成。选图失败保留弹窗，上传和切换图集保留勾选；重置筛选不再清空最近使用，主图替换增加确认。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
