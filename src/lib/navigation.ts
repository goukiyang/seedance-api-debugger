import { hasInternalEmailAuthorization, isExternalUser, type AccountScopedUser } from '@/lib/access/external-role';

export interface NavItem {
  label: string;
  href: string;
  match?: string[];
  prefixMatch?: boolean;
  adminOnly?: boolean;
  externalHidden?: boolean;
  externalOnlyHidden?: boolean;
  imageStudioOnly?: boolean;
}

export interface NavGroup {
  title: string;
  items: NavItem[];
}

export const showLegacyVideoWorkbenchEntry = false;
export const showVideoCardManagementUi = false;

export const shellRoutes = [
  '/',
  '/workbench',
  '/account',
  '/points',
  '/image-studio',
  '/template-studio',
  '/notifications',
  '/assets',
  '/templates',
  '/template-generate',
  '/projects',
  '/usage',
  '/collections',
  '/cutout',
  '/multiview',
  '/tools/ultimate-canvas',
  '/generate/enhance',
  '/admin',
  '/admin/projects',
  '/admin/pricing',
  '/admin/outputs',
  '/admin/image-studio',
  '/admin/costs',
  '/admin/usage-costs',
  '/admin/points',
  '/admin/integrations',
  '/admin/templates',
  '/admin/agent-runs',
  '/admin/usage-records',
  '/admin/feedback',
] as const;

const topbarOnlyShellRoutes = ['/tools/ultimate-canvas', '/tools/character-lab', '/multiview'] as const;

const shellRoutePrefixes = [
  '/tasks',
  '/projects',
  '/collections',
  '/assets',
  '/templates',
  '/template-generate',
  '/tools',
  '/generate/enhance',
  '/admin/users',
  '/admin/outputs',
  '/admin/image-studio',
  '/admin/costs',
  '/admin/integrations',
  '/admin/templates',
  '/admin/agent-runs',
  '/admin/usage-records',
] as const;

export const topbarQuickItems: NavItem[] = [
  { label: '创作首页', href: '/', match: ['/'] },
  { label: '生成', href: '/generate', match: ['/generate', '/generate/canvas'], externalHidden: true },
  { label: '模板工作台', href: '/template-studio', match: ['/template-studio', '/templates', '/template-generate'], prefixMatch: true, externalHidden: true },
  { label: '资产', href: '/assets', match: ['/assets'], prefixMatch: true },
  { label: 'IP生成', href: '/generate/ip', match: ['/generate/ip'], prefixMatch: true },
  { label: '无限画布', href: '/tools/ultimate-canvas', match: ['/tools/ultimate-canvas'], prefixMatch: true, externalHidden: true },
  { label: '工具', href: '/tools/avatar-studio', match: ['/cutout', '/tools/avatar-studio', '/tools/character-lab', '/multiview'], prefixMatch: true },
  { label: '管理中心', href: '/admin', match: ['/admin'], prefixMatch: true, adminOnly: true },
];

export const userNavGroups: NavGroup[] = [
  {
    title: '创作',
    items: [
      { label: '创作首页', href: '/', match: ['/'] },
      { label: '生成视频', href: '/generate', match: ['/generate', '/generate/canvas'], externalHidden: true },
      { label: '模板工作台', href: '/template-studio', match: ['/template-studio'], prefixMatch: true, externalHidden: true },
      { label: '视频超分', href: '/generate/enhance', match: ['/generate/enhance'], prefixMatch: true, adminOnly: true },
      { label: '模板生成', href: '/template-generate', prefixMatch: true, externalHidden: true },
      { label: '动画模板', href: '/templates', prefixMatch: true, externalHidden: true },
      { label: '无限画布', href: '/tools/ultimate-canvas', match: ['/tools/ultimate-canvas'], externalHidden: true },
      ...(showLegacyVideoWorkbenchEntry
        ? [{ label: '视频工作台', href: '/workbench', prefixMatch: true }]
        : []),
    ],
  },
  {
    title: '项目',
    items: [
      { label: '我的项目', href: '/projects', prefixMatch: true, externalHidden: true },
      { label: '我的用量', href: '/usage', prefixMatch: true },
      { label: 'IP生成', href: '/generate/ip' },
      { label: '我的任务', href: '/tasks', prefixMatch: true },
      { label: '资产管理', href: '/assets', prefixMatch: true },
      { label: '参考图集', href: '/collections', prefixMatch: true },
    ],
  },
  {
    title: '工具',
    items: [
      { label: '人物生成', href: '/tools/avatar-studio', prefixMatch: true, imageStudioOnly: true },
      { label: '角色参考图', href: '/tools/character-lab', prefixMatch: true, imageStudioOnly: true },
      { label: 'AI 抠图', href: '/cutout', prefixMatch: true, adminOnly: true },
      { label: '3D多视图', href: '/multiview', prefixMatch: true },
    ],
  },
];

export const adminNavGroups: NavGroup[] = [
  {
    title: '用户与项目',
    items: [
      { label: '使用总览', href: '/admin' },
      { label: '成员使用与账号', href: '/admin/users' },
      { label: '项目使用与管理', href: '/admin/projects', prefixMatch: true },
      { label: '周期额度', href: '/admin/users/quotas', prefixMatch: true },
    ],
  },
  {
    title: '生成与结果',
    items: [
      { label: '产出留存', href: '/admin/outputs', match: ['/admin/outputs', '/admin/usage-records'], prefixMatch: true },
      { label: '图片任务审计', href: '/admin/image-studio', prefixMatch: true },
      { label: '模板工作台', href: '/admin/templates', prefixMatch: true },
      { label: '执行链路与提示词', href: '/admin/agent-runs', prefixMatch: true },
    ],
  },
  {
    title: '费用与点数',
    items: [
      { label: '成本与账务', href: '/admin/costs', match: ['/admin/costs', '/admin/usage-costs'], prefixMatch: true },
      { label: '点数流水', href: '/admin/points', prefixMatch: true },
      { label: '点数与费率', href: '/admin/pricing', prefixMatch: true },
    ],
  },
  {
    title: '模型与接口',
    items: [
      { label: 'API 设置', href: '/admin/integrations', prefixMatch: true },
    ],
  },
  {
    title: '反馈与通知',
    items: [
      { label: '反馈管理', href: '/admin/feedback', prefixMatch: true },
      { label: '我的通知', href: '/notifications', prefixMatch: true },
    ],
  },
];

// These destinations have matching read-only filters; the legacy redirect pages do not.
export const adminExceptionLinks = {
  videoFailed: '/admin/outputs?status=failed',
  imageFailed: '/admin/image-studio?status=failed',
  videoCostPending: '/admin/outputs?cost_status=pending',
  videoCostConflict: '/admin/outputs?cost_status=conflict',
  imageCostPending: '/admin/image-studio?cost_status=pending',
  imageCostConflict: '/admin/image-studio?cost_status=conflict',
  ledgerCostPending: '/admin/costs?cost_status=pending',
  ledgerCostConflict: '/admin/costs?cost_status=conflict',
  videoResultNotReady: '/admin/outputs?result_status=not_ready',
  imageResultNotReady: '/admin/image-studio?result_status=not_ready',
  videoUnassigned: '/admin/outputs?project_id=unassigned',
  feedback: '/admin/feedback?status=new',
} as const;

export const userNavItems: NavItem[] = userNavGroups.flatMap((group) => group.items);
export const adminNavItems: NavItem[] = adminNavGroups.flatMap((group) => group.items);

export function isNavItemActive(pathname: string, item: NavItem) {
  const candidates = item.match?.length ? item.match : [item.href];

  return candidates.some((candidate) => (
    pathname === candidate || (item.prefixMatch ? pathname.startsWith(`${candidate}/`) : false)
  ));
}

export function isNavItemVisible(
  item: NavItem,
  viewer: boolean | (AccountScopedUser & {
    feishu?: { user_id?: string | null; open_id?: string | null; union_id?: string | null; tenant_key?: string | null } | null;
  }) | null | undefined,
) {
  const isAdmin = typeof viewer === 'boolean' ? viewer : viewer?.role === 'admin';
  const isExternal = typeof viewer === 'boolean'
    ? false
    : !viewer || isExternalUser(viewer);

  if (item.adminOnly && !isAdmin) return false;
  if (item.imageStudioOnly && (typeof viewer === 'boolean' ? !viewer : viewer?.account_type !== 'internal' || !isAdmin && !hasInternalEmailAuthorization(viewer) && (!viewer?.feishu?.tenant_key || !Boolean(viewer?.feishu?.user_id || viewer?.feishu?.open_id || viewer?.feishu?.union_id)))) return false;
  if ((item.externalHidden || item.externalOnlyHidden) && isExternal) return false;
  return true;
}

export function shouldUseNavigationShell(pathname: string) {
  return (
    shellRoutes.includes(pathname as (typeof shellRoutes)[number]) ||
    shellRoutePrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
  );
}

export function shouldUseTopbarOnlyShell(pathname: string) {
  return topbarOnlyShellRoutes.includes(pathname as (typeof topbarOnlyShellRoutes)[number]);
}
