import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '新增只提供文字的skills；素材可按真实生成来源和模板筛选；未读模板仍可收起；大图、复制和高清下载使用原尺寸高清档，原图下载不变。' };
export function newerRelease(remote: string, local: string) {
  // Production only advertises stable releases. Keep legacy leading-zero versions comparable.
  const parse = (v: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(v);
    if (!match) return null;
    const parts = match.slice(1, 4).map(Number);
    return parts.every(Number.isSafeInteger) ? parts : null;
  };
  const a = parse(remote), b = parse(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
