export interface NavItem {
  label: string;
  href: string;
  match?: string[];
  prefixMatch?: boolean;
  adminOnly?: boolean;
}

export interface NavGroup {
  title: string;
  items: NavItem[];
}

export const showLegacyVideoWorkbenchEntry = false;

export const shellRoutes = [
  '/workbench',
  '/account',
  '/notifications',
  '/assets',
  '/templates',
  '/template-generate',
  '/projects',
  '/collections',
  '/cutout',
  '/tools/ultimate-canvas',
  '/generate/enhance',
  '/admin',
  '/admin/projects',
  '/admin/outputs',
  '/admin/costs',
  '/admin/integrations',
  '/admin/templates',
  '/admin/agent-runs',
  '/admin/feedback',
] as const;

const topbarOnlyShellRoutes = [] as const;

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
  '/admin/costs',
  '/admin/integrations',
  '/admin/templates',
  '/admin/agent-runs',
] as const;

export const topbarQuickItems: NavItem[] = [
  { label: '生成', href: '/generate', match: ['/generate', '/generate/canvas'] },
  { label: '超分', href: '/generate/enhance', match: ['/generate/enhance'], prefixMatch: true },
  { label: '模板', href: '/templates', match: ['/templates', '/template-generate'], prefixMatch: true },
  { label: '项目', href: '/projects', match: ['/projects', '/tasks', '/assets', '/collections'], prefixMatch: true },
  { label: 'IP生成', href: '/generate/ip', match: ['/generate/ip'], prefixMatch: true },
  { label: '无线画布', href: '/tools/ultimate-canvas', match: ['/tools/ultimate-canvas'], prefixMatch: true },
  { label: '工具', href: '/cutout', match: ['/cutout'], prefixMatch: true },
  { label: '管理中心', href: '/admin', match: ['/admin'], prefixMatch: true, adminOnly: true },
];

export const userNavGroups: NavGroup[] = [
  {
    title: '创作',
    items: [
      { label: '生成视频', href: '/generate', prefixMatch: true },
      { label: '视频超分', href: '/generate/enhance', match: ['/generate/enhance'], prefixMatch: true },
      { label: '模板生成', href: '/template-generate', prefixMatch: true },
      { label: '动画模板', href: '/templates', prefixMatch: true },
      { label: '无线画布', href: '/tools/ultimate-canvas', match: ['/tools/ultimate-canvas'] },
      ...(showLegacyVideoWorkbenchEntry
        ? [{ label: '视频工作台', href: '/workbench', prefixMatch: true }]
        : []),
    ],
  },
  {
    title: '项目',
    items: [
      { label: '我的项目', href: '/projects', prefixMatch: true },
      { label: 'IP生成', href: '/generate/ip' },
      { label: '我的任务', href: '/tasks', prefixMatch: true },
      { label: '资产管理', href: '/assets', prefixMatch: true },
      { label: '参考图集', href: '/collections', prefixMatch: true },
    ],
  },
  {
    title: '工具',
    items: [
      { label: 'AI 抠图', href: '/cutout', prefixMatch: true },
    ],
  },
];

export const adminNavGroups: NavGroup[] = [
  {
    title: '管理中心',
    items: [
      { label: '管理中心', href: '/admin' },
      { label: '用户管理', href: '/admin/users', match: ['/admin/users', '/admin/points'] },
      { label: '项目管理', href: '/admin/projects', prefixMatch: true },
      { label: '产出与反馈', href: '/admin/outputs', match: ['/admin/outputs', '/admin/feedback'] },
      { label: '成本与接口', href: '/admin/costs', match: ['/admin/costs', '/admin/integrations'] },
      { label: '模板工作台', href: '/admin/templates', match: ['/admin/templates', '/admin/agent-runs'], prefixMatch: true },
    ],
  },
];

export const userNavItems: NavItem[] = userNavGroups.flatMap((group) => group.items);
export const adminNavItems: NavItem[] = adminNavGroups.flatMap((group) => group.items);

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
