'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Folder, Image as ImageIcon, LayoutTemplate, ListTodo, Menu, Network, Plus, RotateCcw } from 'lucide-react';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import styles from '@/app/home.module.css';

export default function WorkspaceSidebar({ accountId, internal, images, worksEnabled, activeView, onReset, onReadyChange }: {
  accountId: string;
  internal: boolean;
  images: boolean;
  worksEnabled: boolean;
  activeView?: 'works' | 'overview' | 'assets';
  onReset?: () => void;
  onReadyChange?: (ready: boolean) => void;
}) {
  const { user, hasLoadedUser } = useAppSession();
  const identity = hasLoadedUser && user?.id === accountId ? accountId : '';
  const [open, setOpen] = useState(false);
  const [loadedIdentity, setLoadedIdentity] = useState('');
  const preferencesReady = Boolean(identity && loadedIdentity === identity);
  const workspaceOpen = Boolean(preferencesReady && open);
  const workspace = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  useDialogDismiss({ open: workspaceOpen, dialogRef: workspace, branchRefs: [menuButton], modal: false, onDismiss: () => setOpen(false) });

  useEffect(() => {
    setOpen(false);
    setLoadedIdentity('');
    if (!identity) return;
    try { setOpen(localStorage.getItem(`sd2-home-workspace:${identity}`) === 'open'); } catch { /* Keep the in-memory default. */ }
    setLoadedIdentity(identity);
  }, [identity]);

  useEffect(() => {
    if (!preferencesReady) return;
    try { localStorage.setItem(`sd2-home-workspace:${identity}`, open ? 'open' : 'closed'); } catch { /* The workspace remains usable without storage. */ }
  }, [identity, open, preferencesReady]);

  useEffect(() => { onReadyChange?.(preferencesReady); }, [onReadyChange, preferencesReady]);

  const links = [
    { title: '作品广场', href: '/', icon: LayoutTemplate, visible: worksEnabled && Boolean(identity), current: activeView === 'works' },
    { title: '创作概览', href: '/?view=overview', icon: Network, visible: worksEnabled && Boolean(identity), current: activeView === 'overview' },
    { title: '新建项目', href: '/projects#create-project', icon: Plus, visible: internal },
    { title: '我的项目', href: '/projects', icon: Folder, visible: internal },
    { title: '资产管理', href: '/assets', icon: ImageIcon, visible: true, current: activeView === 'assets' },
    { title: '模板工作台', href: '/template-studio?type=image&view=covers', icon: LayoutTemplate, visible: internal || images },
    { title: '我的任务', href: '/tasks', icon: ListTodo, visible: true },
  ];

  return <aside className={styles.sidebar} data-sidebar-scroll="page">
    <button ref={menuButton} type="button" className={styles.workspaceToggle} aria-expanded={workspaceOpen} aria-controls="home-workspace-links" onClick={() => setOpen(value => !value)}>
      <Menu size={18} aria-hidden="true" />工作区
    </button>
    <div ref={workspace} id="home-workspace-links" className={styles.workspaceLinks} data-open={workspaceOpen ? 'true' : 'false'}>
      <h1>工作区</h1>
      <nav aria-label="工作区">
        {links.filter(link => link.visible).map(link => <Link key={link.href} href={link.href} aria-current={link.current ? 'page' : undefined} className={link.icon === Plus ? styles.createLink : styles.sideLink} onClick={() => setOpen(false)}>
          <link.icon size={18} aria-hidden="true" /><span>{link.title}</span>
        </Link>)}
      </nav>
      {onReset && <button type="button" className={styles.reset} onClick={() => { setOpen(false); onReset(); }} title="重置首页位置" aria-label="重置首页位置">
        <RotateCcw size={15} aria-hidden="true" />重置位置
      </button>}
    </div>
  </aside>;
}
