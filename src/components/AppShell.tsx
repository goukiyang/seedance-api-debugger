'use client';

import { useEffect, useMemo } from 'react';
import { usePathname } from 'next/navigation';
import ComposerTopbar from './ComposerTopbar';
import SideNav from './SideNav';
import FeedbackWidget from './FeedbackWidget';
import { shouldUseNavigationShell, shouldUseTopbarOnlyShell } from '@/lib/navigation';
import { useAppSession } from '@/lib/context/AppSessionContext';

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const {
    user,
    credits,
    loadingUser,
    hasLoadedUser,
    refreshUser,
    refreshCredits,
    clearSession,
  } = useAppSession();

  const showShell = useMemo(() => shouldUseNavigationShell(pathname), [pathname]);
  const topbarOnlyShell = useMemo(() => shouldUseTopbarOnlyShell(pathname), [pathname]);

  useEffect(() => {
    if (!showShell || hasLoadedUser || loadingUser) return;
    void refreshUser();
  }, [hasLoadedUser, loadingUser, refreshUser, showShell]);

  useEffect(() => {
    if (!showShell || !user) return;
    void refreshCredits();
  }, [refreshCredits, showShell, user]);

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
      <ComposerTopbar
        user={user}
        loadingUser={loadingUser}
        credits={credits}
        onSessionClear={clearSession}
      />
      <div className={`shell-body${topbarOnlyShell ? ' shell-body-topbar-only' : ''}`}>
        {!topbarOnlyShell && <SideNav isAdmin={user?.role === 'admin'} />}
        <main className={`shell-content${topbarOnlyShell ? ' shell-content-topbar-only' : ''}`}>
          {children}
        </main>
      </div>
      <FeedbackWidget />
    </div>
  );
}
