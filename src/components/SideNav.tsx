'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { adminNavGroups, isNavItemActive, userNavGroups, type NavGroup } from '@/lib/navigation';

interface SideNavProps {
  isAdmin: boolean;
}

function SideNavGroup({ group }: { group: NavGroup }) {
  const pathname = usePathname();

  return (
    <nav className="shell-nav-group" aria-label={group.title}>
      <div className="shell-nav-title">{group.title}</div>
      <div className="shell-nav-list">
        {group.items.map((item) => {
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

export default function SideNav({ isAdmin }: SideNavProps) {
  return (
    <aside className="shell-sidebar">
      {userNavGroups.map((group) => (
        <SideNavGroup group={group} key={group.title} />
      ))}

      {isAdmin && adminNavGroups.map((group) => (
        <SideNavGroup group={group} key={group.title} />
      ))}
    </aside>
  );
}
