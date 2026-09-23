import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '无线画布支持节点内选择模板或系统默认配置，输入图片可在节点内上传、粘贴和拖入，工具流连线可删除并在分支、拖动和恢复后跟随端点。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
