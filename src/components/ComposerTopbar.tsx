'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Menu, X } from 'lucide-react';
import AccountMenu, { type AccountMenuUser } from './AccountMenu';
import NotificationBell from './NotificationBell';
import CreditRequestDialog from './CreditRequestDialog';
import { isNavItemVisible, topbarQuickItems } from '@/lib/navigation';
import { release } from '@/lib/release';
import ToolsMenu from './ToolsMenu';
import SideNav from './SideNav';
import { useDialogDismiss } from './useDialogDismiss';
import mobileStyles from './mobile-navigation.module.css';

export const ComposerTopbarProvided = createContext(false);

export interface ComposerCreditSummary {
  available?: number;
  frozen_credits?: number;
  monthly_used?: number;
}

interface ComposerTopbarProps {
  user?: AccountMenuUser | null;
  loadingUser?: boolean;
  credits?: ComposerCreditSummary | null;
  onSessionClear?: () => void;
}

function isActivePath(pathname: string, item: typeof topbarQuickItems[number]) {
  const candidates = item.match?.length ? item.match : [item.href];
  return candidates.some((match) => pathname === match || (item.prefixMatch ? pathname.startsWith(`${match}/`) : false));
}

export default function ComposerTopbar(props: ComposerTopbarProps) {
  const provided = useContext(ComposerTopbarProvided);
  return provided ? null : <ComposerTopbarContent {...props} />;
}

function ComposerTopbarContent({
  user,
  loadingUser = false,
  credits,
  onSessionClear,
}: ComposerTopbarProps) {
  const pathname = usePathname();
  const header = useRef<HTMLElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menu = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  useEffect(closeMenu, [pathname, user?.id, closeMenu]);
  useEffect(() => {
    const narrow = window.matchMedia('(max-width: 980px)');
    const changed = () => { if (!narrow.matches) closeMenu(); };
    narrow.addEventListener('change', changed);
    return () => narrow.removeEventListener('change', changed);
  }, [closeMenu]);
  useEffect(() => {
    const dialog = menu.current;
    if (!menuOpen || !dialog) return;
    dialog.showModal();
    dialog.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({ block: 'nearest' });
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { dialog.close(); document.body.style.overflow = previous; };
  }, [menuOpen]);
  useDialogDismiss({ open: menuOpen, dialogRef: menu, nativeDialog: true,
    initialFocusRef: closeButton, onDismiss: closeMenu });
  useEffect(() => {
    const element = header.current;
    const shell = element?.parentElement;
    if (!element || !shell) return;
    const update = () => shell.style.setProperty('--composer-topbar-height', `${element.getBoundingClientRect().height}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return <>
    <header ref={header} className="composer-topbar">
      <div className="composer-topbar-left">
        <button type="button" className={`composer-topbar-icon-btn ${mobileStyles.trigger}`} aria-label="打开导航" title="打开导航"
          aria-expanded={menuOpen} aria-controls={menuId} onClick={() => setMenuOpen(true)}><Menu size={20} /></button>
        <Link href="/" className="composer-topbar-logo" aria-label={`Seedance 2.0 v${release.version}`}>Seedance 2.0 <span className="composer-topbar-version">v{release.version}</span></Link>
        <Link href="/" className={`composer-topbar-nav-btn composer-topbar-home${pathname === '/' ? ' active' : ''}`} aria-current={pathname === '/' ? 'page' : undefined}>创作首页</Link>
        <nav className="composer-topbar-nav" aria-label="快捷入口">
          {topbarQuickItems
            .filter((item) => item.href !== '/' && isNavItemVisible(item, user))
            .map((item) => item.label === '工具' ? <ToolsMenu key="tools" user={user} /> : (
            <Link
              key={item.href}
              href={item.href}
              className={`composer-topbar-nav-btn${isActivePath(pathname, item) ? ' active' : ''}`}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </div>
      <div className="composer-topbar-right">
        {user && <CreditRequestDialog />}
        <NotificationBell enabled={Boolean(user && !loadingUser)} />
        <AccountMenu
          user={user}
          loading={loadingUser}
          variant="composer"
          onSessionClear={onSessionClear}
        />
      </div>
    </header>
    {menuOpen && createPortal(<dialog ref={menu} id={menuId} className={mobileStyles.dialog} aria-labelledby={`${menuId}-title`}>
      <header className={mobileStyles.header}><h2 id={`${menuId}-title`}>导航</h2>
        <button ref={closeButton} type="button" className={mobileStyles.close} aria-label="关闭导航" title="关闭导航" onClick={closeMenu}><X size={20} /></button>
      </header>
      <div className={mobileStyles.content}>
        <SideNav isAdmin={user?.role === 'admin'} user={user} mobile onNavigate={closeMenu} />
      </div>
    </dialog>, document.body)}
  </>;
}
