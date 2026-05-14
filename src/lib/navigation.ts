export interface NavItem {
  label: string;
  href: string;
  match?: string[];
  prefixMatch?: boolean;
}

export const shellRoutes = [
  '/account',
  '/projects',
  '/collections',
  '/admin/projects',
  '/admin/costs',
  '/admin/feedback',
] as const;

const shellRoutePrefixes = [
  '/tasks',
  '/projects',
  '/collections',
  '/admin/users',
  '/admin/costs',
] as const;

export const userNavItems: NavItem[] = [
  { label: '生成视频', href: '/generate' },
  { label: '我的项目', href: '/projects', prefixMatch: true },
  { label: '参考图集', href: '/collections', prefixMatch: true },
  { label: '我的任务', href: '/tasks', prefixMatch: true },
];

export const adminNavItems: NavItem[] = [
  { label: '用户管理', href: '/admin/users' },
  { label: '项目管理', href: '/admin/projects' },
  { label: '成本复盘', href: '/admin/costs' },
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
