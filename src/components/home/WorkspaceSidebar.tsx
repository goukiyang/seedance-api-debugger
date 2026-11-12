'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Bell, BookImage, ChevronDown, CircleHelp, Coins, Folder, Gift, Image as ImageIcon, LayoutTemplate, ListTodo, Menu, Network, PanelLeftClose, PanelLeftOpen, Plus, ReceiptText, RotateCcw, UserRound } from 'lucide-react';
import { workspaceSection, type WorkspaceSection } from '@/lib/navigation';
import { useAppSession } from '@/lib/context/AppSessionContext';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import styles from '@/app/home.module.css';

export default function WorkspaceSidebar({ accountId, internal, images, imageTemplates = images, worksEnabled, activeView, onReset, onReadyChange }: {
  accountId: string;
  internal: boolean;
  images: boolean;
  imageTemplates?: boolean;
  worksEnabled: boolean;
  activeView?: 'works' | 'overview' | WorkspaceSection;
  onReset?: () => void;
  onReadyChange?: (ready: boolean) => void;
}) {
  const { user, hasLoadedUser } = useAppSession();
  const pathname = usePathname();
  const identity = hasLoadedUser && user?.id === accountId ? accountId : '';
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [loadedIdentity, setLoadedIdentity] = useState('');
  const [returnLinks, setReturnLinks] = useState<{ identity: string; links: Record<string, string> }>({ identity: '', links: {} });
  const preferencesReady = Boolean(identity && loadedIdentity === identity);
  const workspaceOpen = Boolean(preferencesReady && open);
  const sidebarCollapsed = Boolean(preferencesReady && collapsed);
  const workspace = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  useDialogDismiss({ open: workspaceOpen, dialogRef: workspace, branchRefs: [menuButton], modal: false, onDismiss: () => setOpen(false) });

  useEffect(() => {
    setOpen(false);
    setCollapsed(false);
    setLoadedIdentity('');
    if (!identity) return;
    try { setOpen(localStorage.getItem(`sd2-home-workspace:${identity}`) === 'open'); } catch { /* Keep the in-memory default. */ }
    const key = `sd2-workspace-sidebar:v1:${identity}`;
    try { setCollapsed(localStorage.getItem(key) === 'collapsed'); } catch { /* Keep the expanded default. */ }
    setLoadedIdentity(identity);
    const sync = (event: StorageEvent) => { if (event.key === key || event.key === null) setCollapsed(event.newValue === 'collapsed'); };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, [identity]);

  useEffect(() => {
    if (!preferencesReady) return;
    try { localStorage.setItem(`sd2-home-workspace:${identity}`, open ? 'open' : 'closed'); } catch { /* The workspace remains usable without storage. */ }
  }, [identity, open, preferencesReady]);

  useEffect(() => {
    if (!preferencesReady) return;
    try { localStorage.setItem(`sd2-workspace-sidebar:v1:${identity}`, collapsed ? 'collapsed' : 'expanded'); } catch { /* The toggle remains usable without storage. */ }
  }, [collapsed, identity, preferencesReady]);

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
    return section && section !== 'assets' && returnLinks.identity === identity ? returnLinks.links[section] || href : href;
  };
  const onLinkClick = (event: React.MouseEvent<HTMLAnchorElement>, href: string) => {
    if (workspaceSection(href) && window.location.pathname === href && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) event.preventDefault();
    setOpen(false);
  };

  const links = [
    { title: '创作首页', href: '/', icon: Network, visible: Boolean(identity), current: activeView === 'works' || activeView === 'overview' },
    { title: '新建项目', href: '/projects#create-project', icon: Plus, visible: internal },
    { title: '我的项目', href: '/projects', icon: Folder, visible: internal, current: current === 'projects' },
    { title: '资产管理', href: '/assets', icon: ImageIcon, visible: true, current: activeView === 'assets' },
    { title: internal ? '模板工作台' : '生图模板', href: '/template-studio?type=image&view=covers', icon: LayoutTemplate, visible: internal || imageTemplates },
    { title: '我的任务', href: '/tasks', icon: ListTodo, visible: true, current: current === 'tasks' },
    { title: '参考图集', href: '/collections', icon: BookImage, visible: true, current: current === 'collections' },
  ];
  const accountLinks = [
    { title: '我的用量', href: '/usage', icon: Coins, visible: true, current: current === 'usage' },
    { title: '领取积分', href: '/points/claim', icon: Gift, visible: true, current: current === 'points/claim' },
    { title: '费率说明', href: '/pricing', icon: ReceiptText, visible: internal, current: current === 'pricing' },
    { title: '个人资料', href: '/account', icon: UserRound, visible: true, current: current === 'account' },
    { title: '通知', href: '/notifications', icon: Bell, visible: true, current: current === 'notifications' },
    { title: '帮助', href: '/help', icon: CircleHelp, visible: true, current: current === 'help' },
  ].filter(link => link.visible);

  const renderLink = (link: (typeof links)[number] | (typeof accountLinks)[number]) => <Link key={link.href} href={destination(link.href)}
    aria-label={link.title} title={link.title} aria-current={link.current ? 'page' : undefined}
    className={link.icon === Plus ? styles.createLink : styles.sideLink} onClick={event => onLinkClick(event, link.href)}>
    <link.icon size={18} aria-hidden="true" /><span>{link.title}</span>
  </Link>;

  return <aside className={styles.sidebar} data-sidebar-scroll="page" data-collapsed={sidebarCollapsed ? 'true' : 'false'}>
    <button ref={menuButton} type="button" className={styles.workspaceToggle} aria-expanded={workspaceOpen} aria-controls="home-workspace-links" onClick={() => setOpen(value => !value)}>
      <Menu size={18} aria-hidden="true" />工作区
    </button>
    <div ref={workspace} id="home-workspace-links" className={styles.workspaceLinks} data-open={workspaceOpen ? 'true' : 'false'}>
      <div className={styles.sidebarHeader}>
        <h1>工作区</h1>
        <button type="button" className={styles.collapseToggle} disabled={!preferencesReady} aria-controls="home-workspace-links"
          aria-expanded={!sidebarCollapsed} aria-label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'} title={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
          onClick={() => setCollapsed(value => !value)}>
          {sidebarCollapsed ? <PanelLeftOpen size={18} aria-hidden="true" /> : <PanelLeftClose size={18} aria-hidden="true" />}
        </button>
      </div>
      <nav aria-label="工作区">
        {links.filter(link => link.visible).map(renderLink)}
      </nav>
      <details className={styles.sidebarMore} open={accountLinks.some(link => link.current)}>
        <summary>账户与帮助<ChevronDown size={15} aria-hidden="true" /></summary>
        <nav aria-label="账户与帮助">{accountLinks.map(renderLink)}</nav>
      </details>
      <nav className={styles.railAccountLinks} aria-label="账户与帮助">{accountLinks.map(renderLink)}</nav>
      {onReset && <button type="button" className={styles.reset} onClick={() => { setOpen(false); onReset(); }} title="重置首页位置" aria-label="重置首页位置">
        <RotateCcw size={15} aria-hidden="true" /><span>重置位置</span>
      </button>}
    </div>
  </aside>;
}
