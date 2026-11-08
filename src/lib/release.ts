import packageInfo from '../../package.json';
// Update notice: one title and 2–4 short outline points in user language, never a detailed change list (2026-10-25).
const notice = { title: '角色工作台布局与制作栏优化', outline: [
  '素材、成品和制作三栏支持拖动换位及调整宽度',
  '提示词、补充输入、生成设置和成品版本集中到制作栏',
  '布局按账号记忆，可一键恢复默认；历史上下文保持独立',
] };
export const release = { version: packageInfo.version, channel: 'production', title: notice.title, outline: notice.outline,
  // Older open pages still read `summary`; it now carries only the title.
  summary: notice.title };

function numericOrder(a: string, b: string) {
  // Compare decimal strings without rounding identifiers beyond Number's precision.
  return a.length !== b.length ? (a.length > b.length ? 1 : -1) : a === b ? 0 : a > b ? 1 : -1;
}

export function parseReleaseVersion(version: unknown) {
  if (typeof version !== 'string') return null;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
  if (!match || match[0] !== version) return null;
  const prerelease = match[4]?.split('.') || [];
  if (prerelease.some(id => /^\d+$/.test(id) && id.length > 1 && id[0] === '0')) return null;
  // Only the core accepts the project's known legacy leading-zero format.
  return { core: match.slice(1, 4).map(part => part.replace(/^0+(?=\d)/, '')), prerelease };
}

export function newerRelease(remote: string, local: string) {
  const a = parseReleaseVersion(remote), b = parseReleaseVersion(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    const order = numericOrder(a.core[i], b.core[i]);
    if (order) return order > 0;
  }
  if (!a.prerelease.length || !b.prerelease.length) return !a.prerelease.length && Boolean(b.prerelease.length);
  for (let i = 0; i < Math.min(a.prerelease.length, b.prerelease.length); i++) {
    const left = a.prerelease[i], right = b.prerelease[i];
    if (left === right) continue;
    const leftNumeric = /^\d+$/.test(left), rightNumeric = /^\d+$/.test(right);
    if (leftNumeric !== rightNumeric) return !leftNumeric;
    return leftNumeric ? numericOrder(left, right) > 0 : left > right;
  }
  return a.prerelease.length > b.prerelease.length;
}
