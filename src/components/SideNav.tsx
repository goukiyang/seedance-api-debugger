'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { adminNavGroups, isNavItemActive, isNavItemVisible, userNavGroups, type NavGroup } from '@/lib/navigation';

interface SideNavProps {
  isAdmin: boolean;
  user?: { role?: string | null; account_type?: string | null } | null;
}

function SideNavGroup({
  group,
  user,
}: {
  group: NavGroup;
  user?: { role?: string | null; account_type?: string | null } | null;
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
            >
              {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

export default function SideNav({ isAdmin, user }: SideNavProps) {
  return (
    <aside className="shell-sidebar">
      {userNavGroups.map((group) => (
        <SideNavGroup group={group} user={user} key={group.title} />
      ))}

      {isAdmin && adminNavGroups.map((group) => (
        <SideNavGroup group={group} user={user} key={group.title} />
      ))}
    </aside>
  );
}
