import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '大图可独立缩放和自由对比；顶部粘贴替换全文；批量按素材确认数量和点数，结果留在当前模板。模板操作和定位调整，抠图统一选图并明确账户授权状态；未绑定账户仍不能提交任务。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
