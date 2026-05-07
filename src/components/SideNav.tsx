'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { adminNavItems, isNavItemActive, userNavItems } from '@/lib/navigation';

interface SideNavProps {
  isAdmin: boolean;
}

export default function SideNav({ isAdmin }: SideNavProps) {
  const pathname = usePathname();

  return (
    <aside className="shell-sidebar">
      <nav className="shell-nav-group" aria-label="Primary">
        <div className="shell-nav-title">工作台</div>
        <div className="shell-nav-list">
          {userNavItems.map((item) => {
            const active = isNavItemActive(pathname, item);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`shell-nav-link${active ? ' active' : ''}`}
              >
                {item.label}
              </Link>
            );
          })}
        </div>
      </nav>

      {isAdmin && (
        <nav className="shell-nav-group" aria-label="Admin">
          <div className="shell-nav-title">管理后台</div>
          <div className="shell-nav-list">
            {adminNavItems.map((item) => {
              const active = isNavItemActive(pathname, item);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`shell-nav-link${active ? ' active' : ''}`}
                >
                  {item.label}
                </Link>
              );
            })}
          </div>
        </nav>
      )}
    </aside>
  );
}
