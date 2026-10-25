import packageInfo from '../../package.json';
export const release = { version: packageInfo.version, channel: 'production',
  summary: '视频可直接保存到项目，素材恢复和模板作者信息更清楚；改进高清查看与上传；窄屏也显示版本号；3D多视图的动作时间由系统按所选时长自动控制，模板不用写秒数，模板预览与提交一致；3D多视图页面三个入口更醒目，点“生成视频”后进度第一步立即亮起，提交没成功时直接说明原因和“没有扣点”，内部核对信息收进“详情”，保存位置折叠为一行；3D多视图 1080p 改为每次经管理员飞书同意后使用（一次同意可用一次，24 小时内有效）；生图失败详情按供应商说明区分内容安全、限流、服务繁忙、超时等原因；图片尺寸或格式与请求不同时不再当作问题提示，实际规格可在详情查看；修复模板封面无法显示和保存的问题；旧版模板设置给出明确提示；生图设置与模板读取遇到数据库短暂繁忙时自动重试，并减少对数据库写锁的占用；进入模板工作台和切换模块时直接显示内容，不再需要刷新；素材较多时素材选择窗口也能正常读取；多视图作品“重新核对”会显示核对结果；多视图作品可“用作参考图”，把拼图或当前单张设为编辑页主图；多视图生成设置下拉菜单的每一项可直接编辑或删除；恢复3D多视图新生成；开放新的视频创作、画布批量视频、3D多视图生成和费率设置。' };

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
