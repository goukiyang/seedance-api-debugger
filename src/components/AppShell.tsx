'use client';

import { useEffect, useMemo } from 'react';
import { usePathname } from 'next/navigation';
import ComposerTopbar, { ComposerTopbarProvided } from './ComposerTopbar';
import SideNav from './SideNav';
import WorkspaceSidebar from './home/WorkspaceSidebar';
import FeedbackWidget from './FeedbackWidget';
import homeStyles from '@/app/home.module.css';
import templateStudioStyles from './template-studio/template-studio.module.css';
import { isNavItemVisible, shouldUseNavigationShell, shouldUseTopbarOnlyShell, workspaceSection } from '@/lib/navigation';
import { useWorkspaceScroll } from '@/lib/hooks/use-workspace-scroll';
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
  const topbarOnlyShell = useMemo(() => pathname === '/' || shouldUseTopbarOnlyShell(pathname), [pathname]);
  const imageStudioShell = pathname === '/image-studio';
  const templateStudioShell = pathname === '/template-studio';
  const workspace = workspaceSection(pathname);
  useWorkspaceScroll(user?.id || '', pathname, Boolean(hasLoadedUser && (workspace === 'account' || workspace === 'help')));
  const projectsWorkspace = /^\/(?:projects(?:\/|$)|usage(?:\/|$)|tasks\/[^/]+$|collections(?:\/|$))/.test(pathname);
  const shellBodyClass = workspace ? homeStyles.page : templateStudioShell
    ? templateStudioStyles.shellBody
    : `shell-body${topbarOnlyShell ? ' shell-body-topbar-only' : ''}${imageStudioShell ? ' shell-body-image-studio' : ''}`;
  const shellContentClass = templateStudioShell
    ? templateStudioStyles.shellContent
    : `shell-content${topbarOnlyShell || workspace ? ' shell-content-topbar-only' : ''}${workspace && workspace !== 'assets' ? ` ${homeStyles.workspaceContent}` : ''}`;

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
    <div className={`shell-root${projectsWorkspace ? ' shell-projects-workspace' : ''}`}>
      <ComposerTopbar
        user={user}
        loadingUser={loadingUser}
        credits={credits}
        onSessionClear={clearSession}
      />
      <div className={shellBodyClass}>
        {workspace && <WorkspaceSidebar accountId={user?.id || ''}
          internal={isNavItemVisible({ label: '创作', href: '/generate', externalHidden: true }, user)}
          images={isNavItemVisible({ label: '图片生成', href: '/image-studio', imageStudioOnly: true }, user)}
          worksEnabled={user?.works_preview === true} activeView={workspace} />}
        {!workspace && !topbarOnlyShell && !imageStudioShell && !templateStudioShell && <SideNav isAdmin={user?.role === 'admin'} user={user} />}
        <main className={shellContentClass}>
          <ComposerTopbarProvided.Provider value>{children}</ComposerTopbarProvided.Provider>
        </main>
      </div>
      <FeedbackWidget />
    </div>
  );
}
