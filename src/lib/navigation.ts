export interface NavItem {
  label: string;
  href: string;
  match?: string[];
  prefixMatch?: boolean;
}

export const shellRoutes = [
  '/workbench',
  '/account',
  '/notifications',
  '/assets',
  '/templates',
  '/projects',
  '/collections',
  '/cutout',
  '/generate/canvas',
  '/admin',
  '/admin/projects',
  '/admin/outputs',
  '/admin/costs',
  '/admin/integrations',
  '/admin/settings',
  '/admin/notifications',
  '/admin/agent-runs',
  '/admin/modules',
  '/admin/feedback',
] as const;

const topbarOnlyShellRoutes = [
  '/generate/canvas',
] as const;

const shellRoutePrefixes = [
  '/tasks',
  '/projects',
  '/collections',
  '/admin/users',
  '/admin/outputs',
  '/admin/costs',
  '/admin/integrations',
  '/admin/settings',
  '/admin/notifications',
  '/admin/agent-runs',
  '/admin/modules',
] as const;

export const userNavItems: NavItem[] = [
  { label: '生成视频', href: '/generate', match: ['/generate', '/generate/canvas'] },
  { label: '动画模板', href: '/templates', prefixMatch: true },
  { label: '视频工作台', href: '/workbench', prefixMatch: true },
  { label: 'AI 抠图', href: '/cutout', prefixMatch: true },
  { label: '资产管理', href: '/assets', prefixMatch: true },
  { label: '我的项目', href: '/projects', prefixMatch: true },
  { label: 'IP生成', href: '/generate/ip' },
  { label: '参考图集', href: '/collections', prefixMatch: true },
  { label: '我的任务', href: '/tasks', prefixMatch: true },
  { label: '通知', href: '/notifications' },
];

export const externalUserNavItems: NavItem[] = [
  { label: '资产管理', href: '/assets', prefixMatch: true },
  { label: '我的任务', href: '/tasks', prefixMatch: true },
  { label: '参考图集', href: '/collections', prefixMatch: true },
];

export const adminNavItems: NavItem[] = [
  { label: '后台总览', href: '/admin' },
  { label: '用户管理', href: '/admin/users' },
  { label: '项目管理', href: '/admin/projects' },
  { label: '模板管理', href: '/templates', prefixMatch: true },
  { label: '模块库', href: '/admin/modules', prefixMatch: true },
  { label: '执行链路', href: '/admin/agent-runs', prefixMatch: true },
  { label: '产出留存', href: '/admin/outputs' },
  { label: '计费与成本', href: '/admin/costs' },
  { label: 'API 设置', href: '/admin/integrations', match: ['/admin/integrations', '/admin/settings'] },
  { label: '通知公告', href: '/admin/notifications' },
  { label: '反馈管理', href: '/admin/feedback' },
];

export function isNavItemActive(pathname: string, item: NavItem) {
  const candidates = item.match?.length ? item.match : [item.href];

  return candidates.some((candidate) => (
    pathname === candidate || (item.prefixMatch ? pathname.startsWith(`${candidate}/`) : false)
  ));
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
