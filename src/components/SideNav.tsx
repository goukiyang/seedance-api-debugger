'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { adminNavGroups, isNavItemActive, isNavItemVisible, userNavGroups, type NavGroup } from '@/lib/navigation';

interface SideNavProps {
  isAdmin: boolean;
  mobile?: boolean;
  onNavigate?: () => void;
  user?: {
    role?: string | null;
    account_type?: string | null;
    feature_profile_id?: string | null;
    feishu?: { user_id?: string | null; open_id?: string | null; union_id?: string | null } | null;
  } | null;
}

function SideNavGroup({
  group,
  user,
  onNavigate,
}: {
  group: NavGroup;
  onNavigate?: () => void;
  user?: {
    role?: string | null;
    account_type?: string | null;
    feature_profile_id?: string | null;
    feishu?: { user_id?: string | null; open_id?: string | null; union_id?: string | null } | null;
  } | null;
}) {
  const pathname = usePathname();
  const visibleItems = group.items.filter((item) => isNavItemVisible(item, user));

  if (visibleItems.length === 0) return null;

  return (
    <nav className="shell-nav-group" aria-label={group.title}>
      <div className="shell-nav-title">{group.title}</div>
      <div className="shell-nav-list">
        {visibleItems.map((item) => {
          const active = isNavItemActive(pathname, item);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`shell-nav-link${active ? ' active' : ''}`}
              aria-current={active ? 'page' : undefined}
              onClick={onNavigate}
            >
              {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

export default function SideNav({ isAdmin, user, mobile = false, onNavigate }: SideNavProps) {
  const pathname = usePathname();
  const inAdmin = isAdmin && (pathname === '/admin' || pathname.startsWith('/admin/'));
  return (
    <aside className={mobile ? 'shell-sidebar shell-sidebar-mobile' : 'shell-sidebar'} aria-label="页面导航">
      {(!inAdmin || mobile) && userNavGroups.map((group) => (
        <SideNavGroup group={group} user={user} onNavigate={onNavigate} key={group.title} />
      ))}

      {isAdmin && adminNavGroups.map((group) => (
        <SideNavGroup group={group} user={user} onNavigate={onNavigate} key={group.title} />
      ))}
    </aside>
  );
}
