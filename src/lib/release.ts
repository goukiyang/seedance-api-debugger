import packageInfo from '../../package.json';

export const release = { version: packageInfo.version, channel: 'production', summary: '图片异常结果改为独立待核对，不再长期占用生成名额；保留原请求和费用预留，后台有限核对，也可手动核对原任务。执行上限仍为8张，不会重新生成或重复扣费。' };

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
