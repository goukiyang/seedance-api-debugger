'use client';

import { useEffect, useMemo, useState } from 'react';
import { usePathname } from 'next/navigation';
import TopNav from './TopNav';
import SideNav from './SideNav';
import FeedbackWidget from './FeedbackWidget';
import { shouldUseNavigationShell } from '@/lib/navigation';

interface SessionUserSummary {
  name: string;
  username: string;
  role: 'admin' | 'user';
}

interface CreditSummary {
  available: number;
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [user, setUser] = useState<SessionUserSummary | null>(null);
  const [credits, setCredits] = useState<CreditSummary | null>(null);

  const showShell = useMemo(() => shouldUseNavigationShell(pathname), [pathname]);

  useEffect(() => {
    if (!showShell) return;

    let cancelled = false;

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
      <TopNav userName={user?.name || user?.username} availableCredits={credits?.available ?? null} />
      <div className="shell-body">
        <SideNav isAdmin={user?.role === 'admin'} />
        <main className="shell-content">
          {children}
        </main>
      </div>
      <FeedbackWidget />
    </div>
  );
}
