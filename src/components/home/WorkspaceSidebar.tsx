'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Bell, BookImage, ChevronDown, CircleHelp, Coins, Folder, Image as ImageIcon, LayoutTemplate, ListTodo, Menu, Network, Plus, RotateCcw, UserRound } from 'lucide-react';
import { workspaceSection, type WorkspaceSection } from '@/lib/navigation';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import styles from '@/app/home.module.css';

export default function WorkspaceSidebar({ accountId, internal, images, worksEnabled, activeView, onReset, onReadyChange }: {
  accountId: string;
  internal: boolean;
  images: boolean;
  worksEnabled: boolean;
  activeView?: 'works' | 'overview' | WorkspaceSection;
  onReset?: () => void;
  onReadyChange?: (ready: boolean) => void;
}) {
  const { user, hasLoadedUser } = useAppSession();
  const pathname = usePathname();
  const identity = hasLoadedUser && user?.id === accountId ? accountId : '';
  const [open, setOpen] = useState(false);
  const [loadedIdentity, setLoadedIdentity] = useState('');
  const [returnLinks, setReturnLinks] = useState<{ identity: string; links: Record<string, string> }>({ identity: '', links: {} });
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

  useEffect(() => {
    if (!identity) return;
    const key = `sd2-workspace-return:v1:${identity}`;
    let links: Record<string, string> = {};
    try {
      const saved = JSON.parse(sessionStorage.getItem(key) || '{}');
      for (const [section, href] of Object.entries(saved || {})) {
        if (typeof href !== 'string' || href.length > 8192) continue;
        const address = new URL(href, window.location.origin);
        if (address.origin === window.location.origin && address.pathname === `/${section}` && workspaceSection(address.pathname)) links[section] = `${address.pathname}${address.search}${address.hash}`;
      }
    } catch { /* Plain navigation remains available without storage. */ }
    setReturnLinks({ identity, links });
    const remember = () => {
      const section = workspaceSection(window.location.pathname);
      if (!section || window.location.pathname !== `/${section}` || window.location.hash === '#create-project') return;
      links = { ...links, [section]: `${window.location.pathname}${window.location.search}${window.location.hash}` };
      try { sessionStorage.setItem(key, JSON.stringify(links)); } catch { /* URL and page preferences still preserve the current view. */ }
    };
    // Capture before Next's Link changes the URL, including native replaceState filters.
    const onNavigate = (event: MouseEvent) => { if ((event.target as Element)?.closest?.('a[href]')) remember(); };
    document.addEventListener('click', onNavigate, true);
    window.addEventListener('pagehide', remember);
    return () => { document.removeEventListener('click', onNavigate, true); window.removeEventListener('pagehide', remember); };
  }, [identity, pathname]);

  const current = activeView || workspaceSection(pathname);
  const destination = (href: string) => {
    const section = workspaceSection(href);
    return section && returnLinks.identity === identity ? returnLinks.links[section] || href : href;
  };

  const links = [
    { title: '作品广场', href: '/', icon: LayoutTemplate, visible: worksEnabled && Boolean(identity), current: activeView === 'works' },
    { title: '创作概览', href: '/?view=overview', icon: Network, visible: worksEnabled && Boolean(identity), current: activeView === 'overview' },
    { title: '新建项目', href: '/projects#create-project', icon: Plus, visible: internal },
    { title: '我的项目', href: '/projects', icon: Folder, visible: internal, current: current === 'projects' },
    { title: '资产管理', href: '/assets', icon: ImageIcon, visible: true, current: activeView === 'assets' },
    { title: '模板工作台', href: '/template-studio', icon: LayoutTemplate, visible: internal || images },
    { title: '我的任务', href: '/tasks', icon: ListTodo, visible: true, current: current === 'tasks' },
    { title: '参考图集', href: '/collections', icon: BookImage, visible: true, current: current === 'collections' },
  ];
  const accountLinks = [
    { title: '我的用量', href: '/usage', icon: Coins, visible: true, current: current === 'usage' },
    { title: '费率说明', href: '/pricing', icon: Coins, visible: internal, current: current === 'pricing' },
    { title: '个人资料', href: '/account', icon: UserRound, visible: true, current: current === 'account' },
    { title: '通知', href: '/notifications', icon: Bell, visible: true, current: current === 'notifications' },
    { title: '帮助', href: '/help', icon: CircleHelp, visible: true, current: current === 'help' },
  ].filter(link => link.visible);

  return <aside className={styles.sidebar} data-sidebar-scroll="page">
    <button ref={menuButton} type="button" className={styles.workspaceToggle} aria-expanded={workspaceOpen} aria-controls="home-workspace-links" onClick={() => setOpen(value => !value)}>
      <Menu size={18} aria-hidden="true" />工作区
    </button>
    <div ref={workspace} id="home-workspace-links" className={styles.workspaceLinks} data-open={workspaceOpen ? 'true' : 'false'}>
      <h1>工作区</h1>
      <nav aria-label="工作区">
        {links.filter(link => link.visible).map(link => <Link key={link.href} href={destination(link.href)} aria-current={link.current ? 'page' : undefined} className={link.icon === Plus ? styles.createLink : styles.sideLink} onClick={() => setOpen(false)}>
          <link.icon size={18} aria-hidden="true" /><span>{link.title}</span>
        </Link>)}
      </nav>
      <details className={styles.sidebarMore} open={accountLinks.some(link => link.current)}>
        <summary>账户与帮助<ChevronDown size={15} aria-hidden="true" /></summary>
        <nav aria-label="账户与帮助">{accountLinks.map(link => <Link key={link.href} href={destination(link.href)} className={styles.sideLink} aria-current={link.current ? 'page' : undefined} onClick={() => setOpen(false)}>
          <link.icon size={18} aria-hidden="true" /><span>{link.title}</span>
        </Link>)}</nav>
      </details>
      {onReset && <button type="button" className={styles.reset} onClick={() => { setOpen(false); onReset(); }} title="重置首页位置" aria-label="重置首页位置">
        <RotateCcw size={15} aria-hidden="true" />重置位置
      </button>}
    </div>
  </aside>;
}
