'use client';

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

const navItems = [
  { label: '生成视频', href: '/generate', matches: ['/generate', '/generate/canvas'] },
  { label: '动画模板', href: '/templates', matches: ['/templates', '/template-generate'] },
  { label: '资产管理', href: '/assets', matches: ['/assets'] },
  { label: '我的项目', href: '/projects', matches: ['/projects'] },
  { label: '参考图集', href: '/collections', matches: ['/collections'] },
  { label: '我的任务', href: '/tasks', matches: ['/tasks'] },
] as const;

function formatCredit(value: number | undefined) {
  return Math.max(0, Math.floor(value || 0)).toString();
}

function isActivePath(pathname: string, matches: readonly string[]) {
  return matches.some((match) => pathname === match || pathname.startsWith(`${match}/`));
}

export default function ComposerTopbar({ user, loadingUser = false, credits }: ComposerTopbarProps) {
  const pathname = usePathname();

  return (
    <header className="composer-topbar">
      <div className="composer-topbar-left">
        <Link href="/" className="composer-topbar-logo">Seedance 2.0</Link>
        <nav className="composer-topbar-nav">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`composer-topbar-nav-btn${isActivePath(pathname, item.matches) ? ' active' : ''}`}
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
        <AccountMenu user={user} loading={loadingUser} variant="composer" />
      </div>
    </header>
  );
}
