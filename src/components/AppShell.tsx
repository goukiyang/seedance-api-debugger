'use client';

import { useEffect, useMemo, useState } from 'react';
import { usePathname } from 'next/navigation';
import ComposerTopbar from './ComposerTopbar';
import SideNav from './SideNav';
import FeedbackWidget from './FeedbackWidget';
import { shouldUseNavigationShell, shouldUseTopbarOnlyShell } from '@/lib/navigation';
import { isExternalAllowedPath, isExternalUser } from '@/lib/access/external-user';

interface SessionUserSummary {
  name: string | null;
  username: string | null;
  email: string | null;
  avatar_url?: string | null;
  role: 'admin' | 'user';
  account_type: 'internal' | 'external';
}

interface CreditSummary {
  available: number;
  frozen_credits: number;
  monthly_used: number;
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [user, setUser] = useState<SessionUserSummary | null>(null);
  const [credits, setCredits] = useState<CreditSummary | null>(null);
  const [loadingUser, setLoadingUser] = useState(false);

  const showShell = useMemo(() => shouldUseNavigationShell(pathname), [pathname]);
  const topbarOnlyShell = useMemo(() => shouldUseTopbarOnlyShell(pathname), [pathname]);
  const externalUser = isExternalUser(user);

  useEffect(() => {
    if (!showShell) return;

    let cancelled = false;
    setLoadingUser(true);

    fetch('/api/auth/me', { cache: 'no-store' })
      .then((response) => response.json())
      .then((data) => {
        if (!cancelled) {
          setUser(data.user || null);
          if (!data.user) {
            setCredits(null);
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          setUser(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingUser(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [showShell, pathname]);

  useEffect(() => {
    if (!showShell || !user) return;

    let cancelled = false;

    fetch('/api/me/credits', { cache: 'no-store' })
      .then((response) => response.ok ? response.json() : null)
      .then((data) => {
        if (!cancelled && data) {
          setCredits(data);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCredits(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [showShell, user, pathname]);

  useEffect(() => {
    if (!user || !externalUser || isExternalAllowedPath(pathname)) return;
    window.location.replace('/generate/ip');
  }, [externalUser, pathname, user]);

  if (!showShell) {
    return (
      <>
        {children}
        <FeedbackWidget />
      </>
    );
  }

  return (
    <div className="shell-root">
      <ComposerTopbar user={user} loadingUser={loadingUser} credits={credits} />
      <div className={`shell-body${topbarOnlyShell ? ' shell-body-topbar-only' : ''}`}>
        {!topbarOnlyShell && <SideNav isAdmin={user?.role === 'admin'} isExternal={externalUser} />}
        <main className={`shell-content${topbarOnlyShell ? ' shell-content-topbar-only' : ''}`}>
          {children}
        </main>
      </div>
      <FeedbackWidget />
    </div>
  );
}
