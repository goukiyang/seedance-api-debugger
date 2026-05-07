export interface NavItem {
  label: string;
  href: string;
  match?: string[];
  prefixMatch?: boolean;
}

export const userNavItems: NavItem[] = [
  { label: '控制台', href: '/dashboard' },
  { label: '快速生成', href: '/generate/quick' },
  { label: '生成视频', href: '/generate' },
  { label: '我的任务', href: '/tasks', prefixMatch: true },
  { label: '视频库', href: '/videos' },
  { label: '素材分组', href: '/collections' },
  { label: '模板中心', href: '/templates' },
  { label: '积分流水', href: '/points' },
  { label: '反馈帮助', href: '/help' },
];

export const adminNavItems: NavItem[] = [
  { label: '管理总览', href: '/admin' },
  { label: '用户管理', href: '/admin/users' },
  { label: '积分管理', href: '/admin/points' },
  { label: '任务管理', href: '/admin/tasks' },
  { label: '异常任务', href: '/admin/exceptions' },
  { label: '资源管理', href: '/admin/resources' },
  { label: '计费规则', href: '/admin/pricing' },
  { label: '反馈管理', href: '/admin/feedback' },
];

export function isNavItemActive(pathname: string, item: NavItem) {
  const candidates = item.match?.length ? item.match : [item.href];

  return candidates.some((candidate) => (
    pathname === candidate || (item.prefixMatch ? pathname.startsWith(`${candidate}/`) : false)
  ));
}
