import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '升级原有AI抠图：六项调节、角色框选、画笔细修、拆分合并与历史找回。提交前检查业务授权，未接入时明确提示，不会空转或重复提交任务。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
