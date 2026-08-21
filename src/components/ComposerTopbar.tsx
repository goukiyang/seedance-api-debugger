'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import AccountMenu, { type AccountMenuUser } from './AccountMenu';

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

interface ComposerNavItem {
  label: string;
  href: string;
  matches: readonly string[];
  exact?: boolean;
}

const navItems: ComposerNavItem[] = [
  { label: '生成视频', href: '/generate', matches: ['/generate', '/generate/canvas'], exact: true },
  { label: '动画模板', href: '/templates', matches: ['/templates', '/template-generate'] },
  { label: '资产管理', href: '/assets', matches: ['/assets'] },
  { label: '我的项目', href: '/projects', matches: ['/projects'] },
  { label: 'IP生成', href: '/generate/ip', matches: ['/generate/ip'], exact: true },
  { label: '参考图集', href: '/collections', matches: ['/collections'] },
  { label: '我的任务', href: '/tasks', matches: ['/tasks'] },
] as const;

function formatCredit(value: number | undefined) {
  return Math.max(0, Math.floor(value || 0)).toString();
}

function isActivePath(pathname: string, matches: readonly string[], exact = false) {
  return matches.some((match) => pathname === match || (!exact && pathname.startsWith(`${match}/`)));
}

export default function ComposerTopbar({ user, loadingUser = false, credits }: ComposerTopbarProps) {
  const pathname = usePathname();
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    if (!user) {
      setUnreadCount(0);
      return;
    }

    let cancelled = false;
    fetch('/api/me/notifications?limit=1', { cache: 'no-store' })
      .then((response) => response.ok ? response.json() : null)
      .then((data) => {
        if (!cancelled) setUnreadCount(data?.unread_count || 0);
      })
      .catch(() => {
        if (!cancelled) setUnreadCount(0);
      });

    return () => {
      cancelled = true;
    };
  }, [user, pathname]);

  return (
    <header className="composer-topbar">
      <div className="composer-topbar-left">
        <Link href="/" className="composer-topbar-logo">Seedance 2.0</Link>
        <nav className="composer-topbar-nav">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`composer-topbar-nav-btn${isActivePath(pathname, item.matches, item.exact) ? ' active' : ''}`}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </div>
      <div className="composer-topbar-right">
        {credits && (
          <div className="composer-topbar-nav-btn" title="当前点数">
            可用 {formatCredit(credits.available)} 点 ｜ 冻结 {formatCredit(credits.frozen_credits)} 点 ｜ 本月已用 {formatCredit(credits.monthly_used)} 点
          </div>
        )}
        {user && (
          <Link className={`composer-topbar-nav-btn${unreadCount > 0 ? ' has-unread' : ''}`} href="/notifications" title="通知">
            通知{unreadCount > 0 ? ` ${unreadCount}` : ''}
          </Link>
        )}
        <AccountMenu user={user} loading={loadingUser} variant="composer" />
      </div>
    </header>
  );
}
