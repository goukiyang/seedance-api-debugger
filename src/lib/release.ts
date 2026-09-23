import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '无线画布生图模板同时读取授权模板和当前账号模块，选择后可正确绑定；工具流连线在重建、拖动、缩放和恢复后保持跟随节点。' };
export function newerRelease(remote: string, local: string) {
  const parse = (v: string) => /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null;
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
