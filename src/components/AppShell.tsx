'use client';

import { useEffect, useMemo } from 'react';
import { usePathname } from 'next/navigation';
import ComposerTopbar from './ComposerTopbar';
import SideNav from './SideNav';
import FeedbackWidget from './FeedbackWidget';
import templateStudioStyles from './template-studio/template-studio.module.css';
import { shouldUseNavigationShell, shouldUseTopbarOnlyShell } from '@/lib/navigation';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { rememberSettingsOrigin } from '@/lib/navigation/settings-return';

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  useEffect(() => { rememberSettingsOrigin(); }, [pathname]);
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
  const imageStudioShell = pathname === '/image-studio';
  const templateStudioShell = pathname === '/template-studio';
  const shellBodyClass = templateStudioShell
    ? templateStudioStyles.shellBody
    : `shell-body${topbarOnlyShell ? ' shell-body-topbar-only' : ''}${imageStudioShell ? ' shell-body-image-studio' : ''}`;
  const shellContentClass = templateStudioShell
    ? templateStudioStyles.shellContent
    : `shell-content${topbarOnlyShell ? ' shell-content-topbar-only' : ''}`;

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
      <div className={shellBodyClass}>
        {!topbarOnlyShell && !imageStudioShell && !templateStudioShell && <SideNav isAdmin={user?.role === 'admin'} user={user} />}
        <main className={shellContentClass}>
          {children}
        </main>
      </div>
      <FeedbackWidget />
    </div>
  );
}
