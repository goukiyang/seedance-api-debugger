'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import AccountMenu, { type AccountMenuUser } from './AccountMenu';
import NotificationBell from './NotificationBell';
import { topbarQuickItems } from '@/lib/navigation';

export interface ComposerCreditSummary {
  available?: number;
  frozen_credits?: number;
  monthly_used?: number;
}

interface ComposerTopbarProps {
  user?: AccountMenuUser | null;
  loadingUser?: boolean;
  credits?: ComposerCreditSummary | null;
}

function formatCredit(value: number | undefined) {
  return Math.max(0, Math.floor(value || 0)).toString();
}

function isActivePath(pathname: string, item: typeof topbarQuickItems[number]) {
  const candidates = item.match?.length ? item.match : [item.href];
  return candidates.some((match) => pathname === match || pathname.startsWith(`${match}/`));
}

export default function ComposerTopbar({ user, loadingUser = false, credits }: ComposerTopbarProps) {
  const pathname = usePathname();

  return (
    <header className="composer-topbar">
      <div className="composer-topbar-left">
        <Link href="/" className="composer-topbar-logo">Seedance 2.0</Link>
        <nav className="composer-topbar-nav" aria-label="快捷入口">
          {topbarQuickItems
            .filter((item) => !item.adminOnly || user?.role === 'admin')
            .map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`composer-topbar-nav-btn${isActivePath(pathname, item) ? ' active' : ''}`}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </div>
      <div className="composer-topbar-right">
        {credits && (
          <div
            className="composer-topbar-credit"
            title={`冻结 ${formatCredit(credits.frozen_credits)} 点，本月已用 ${formatCredit(credits.monthly_used)} 点`}
          >
            可用 {formatCredit(credits.available)}
          </div>
        )}
        <NotificationBell enabled={Boolean(user && !loadingUser)} />
        <AccountMenu user={user} loading={loadingUser} variant="composer" />
      </div>
    </header>
  );
}
