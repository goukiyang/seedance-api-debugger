'use client';
import { useProductDialog } from '@/components/useProductDialog';

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Camera, X, LogOut, Link2 } from 'lucide-react';
import { AvatarEditor } from './AvatarEditor';
import { useOptionalAppSession } from '@/lib/context/AppSessionContext';
import Link from 'next/link';
import { useDialogDismiss } from './useDialogDismiss';
import { getPageExitRisk, runApprovedPageExit } from '@/lib/hooks/page-exit-guard';
import styles from './AccountMenu.module.css';
import { broadcastSessionExit, lockClientSession, logoutResponseOutcome, type LogoutOutcome } from '@/lib/auth/client-session-boundary';
import {
  displayUserInitials,
  displayUserName,
  userAvatarColor,
} from '@/lib/users/display';

export interface AccountMenuUser {
  id?: string;
  name?: string | null;
  username?: string | null;
  email?: string | null;
  avatar_url?: string | null;
  role?: 'admin' | 'user' | string | null;
  account_type?: 'internal' | 'external' | string | null;
  feishu?: { user_id?: string | null; open_id?: string | null; union_id?: string | null } | null;
}

interface AccountMenuProps {
  user?: AccountMenuUser | null;
  loading?: boolean;
  variant?: 'shell' | 'composer';
  onSessionClear?: () => void;
}

function avatarLabel(user: AccountMenuUser | null | undefined, displayName: string | undefined) {
  return displayUserInitials({ ...user, name: displayName || user?.name });
}

function avatarColor(user: AccountMenuUser | null | undefined, displayName: string | undefined) {
  return userAvatarColor({ ...user, name: displayName || user?.name });
}

function roleLabel(user: AccountMenuUser | null | undefined) {
  if (user?.role === 'admin') return '管理员';
  if (user?.role === 'user') return '普通用户';
  return null;
}

function AccountDetails({ children, busy, onClose }: { children: React.ReactNode; busy: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const title = useId();
  useDialogDismiss({ open: true, dialogRef: dialog, nativeDialog: true, initialFocusRef: close, onDismiss: () => { if (!busy) onClose(); } });
  useEffect(() => { dialog.current?.showModal(); }, []);
  return createPortal(<dialog ref={dialog} className={styles.dialog} aria-labelledby={title} aria-modal="true" aria-busy={busy}>
    <header className={styles.header}><h2 id={title}>个人信息</h2><button ref={close} type="button" disabled={busy} className={styles.close} onClick={onClose} aria-label="关闭个人信息"><X size={18} /></button></header>
    {children}
  </dialog>, document.body);
}

export default function AccountMenu({
  user,
  loading = false,
  variant = 'shell',
  onSessionClear,
}: AccountMenuProps) {
  const { confirm, productDialog } = useProductDialog();
  const [loggingOut, setLoggingOut] = useState(false);
  const [bindingFeishu, setBindingFeishu] = useState(false);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [avatarEditorOpen, setAvatarEditorOpen] = useState(false);
  const appSession = useOptionalAppSession();
  const [logoutError, setLogoutError] = useState('');
  const logoutLock = useRef(false);

  const displayName = user ? displayUserName(user) : '';
  const className = `account-menu account-menu-${variant}`;
  const label = avatarLabel(user, displayName);
  const fallbackColor = avatarColor(user, displayName);
  const avatarUrl = user?.avatar_url?.trim();
  const role = roleLabel(user);

  useEffect(() => {
    setAvatarFailed(false);
  }, [avatarUrl]);

  const handleLogout = async (switchAccount = false, allDevices = false) => {
    if (logoutLock.current) return;
    logoutLock.current = true;
    setDetailsOpen(true);
    setLogoutError('');
    let outcome: LogoutOutcome | 'not_requested' = 'not_requested';
    try {
      const risk = getPageExitRisk();
      if (risk.busy.length) {
        setLogoutError(`${risk.busy.join('、')}，请确认完成后再${switchAccount ? '切换账号' : '退出'}。`);
        return;
      }
      if (risk.unsaved.length && !await confirm(`${risk.unsaved.join('、')}尚未保存。${switchAccount ? '切换账号会退出当前账号并前往登录，同站其它已打开页面也会退出。' : ''}确定放弃并离开吗？`, { title: switchAccount ? '切换账号' : '退出账号', confirmLabel: '放弃并继续', anchor: null })) return;
      const currentRisk = getPageExitRisk();
      if (currentRisk.signature !== risk.signature || currentRisk.busy.length) {
        setLogoutError('页面内容或保存状态已变化，请确认后重试。');
        return;
      }
      setLoggingOut(true);
      outcome = 'unknown';
      const response = await fetch(allDevices ? '/api/auth/logout-all' : '/api/auth/logout', { method: 'POST', signal: AbortSignal.timeout(20000) });
      const result = await response.json();
      outcome = logoutResponseOutcome(response, result);
      if (outcome !== 'confirmed') throw new Error('退出未成功确认');
      broadcastSessionExit();
      try {
        localStorage.removeItem('ultimate-canvas:last-library-document');
      } catch { /* The next session still requires server authorization. */ }
      const left = runApprovedPageExit(() => { onSessionClear?.(); window.location.replace('/login'); }, currentRisk.signature);
      if (!left) lockClientSession();
    } catch {
      if (outcome === 'unknown') {
        setLogoutError('退出结果尚未确认，服务器可能已退出。本页输入仍保留，请前往登录重新确认账号。');
        broadcastSessionExit('unconfirmed');
        lockClientSession('unconfirmed');
      } else if (outcome === 'confirmed') lockClientSession('logged_out');
      else setLogoutError('退出未成功，请重试。当前输入仍保留。');
    } finally {
      logoutLock.current = false;
      setLoggingOut(false);
    }
  };

  const handleBindFeishu = async () => {
    if (logoutLock.current) return;
    logoutLock.current = true;
    setLogoutError('');
    try {
      const risk = getPageExitRisk();
      if (risk.busy.length) { setLogoutError('请等当前操作确认完成后再绑定飞书。'); return; }
      if (risk.unsaved.length && !await confirm('前往飞书会离开本页，尚未保存的输入可能丢失。确定继续吗？', { title: '绑定飞书', confirmLabel: '继续绑定', anchor: null })) return;
      setBindingFeishu(true);
      const response = await fetch('/api/auth/feishu/bind', { method: 'POST', signal: AbortSignal.timeout(20000) });
      const data = await response.json();
      if (!response.ok || typeof data.authorize_url !== 'string') { setLogoutError(data.error || '暂时无法发起绑定，请重试。'); return; }
      if (!runApprovedPageExit(() => window.location.assign(data.authorize_url), risk.signature)) setLogoutError('页面状态已变化，请确认后重试。');
    } catch { setLogoutError('暂时无法发起绑定，请重试。当前输入仍保留。'); }
    finally { logoutLock.current = false; setBindingFeishu(false); }
  };

  if (loading) {
    return (
      <div className={className} aria-busy="true">
        <span className="account-menu-avatar account-menu-avatar-loading" aria-hidden="true" />
        <span className="account-menu-placeholder">账号</span>
      </div>
    );
  }

  if (!displayName) {
    return (
      <div className={className}>
        <Link href="/login" className="account-menu-login">登录</Link>
      </div>
    );
  }

  return (
    <div className={className}>
      {productDialog}
      <button type="button" className={`account-menu-name ${styles.trigger}`} title="查看个人信息" aria-haspopup="dialog" aria-expanded={detailsOpen} onClick={() => setDetailsOpen(true)}>
        <span className="account-menu-avatar" style={{ backgroundColor: fallbackColor }} aria-hidden="true">
          {avatarUrl && !avatarFailed ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={avatarUrl} alt="" onError={() => setAvatarFailed(true)} />
          ) : (
            <span>{label}</span>
          )}
        </span>
        <span className="account-menu-identity">
          <span className="account-menu-display-name">{displayName}</span>
          {role && <span className="account-menu-role">{role}</span>}
        </span>
      </button>
      {detailsOpen && <AccountDetails busy={loggingOut || bindingFeishu} onClose={() => setDetailsOpen(false)}>
        <div className={styles.identity}><button type="button" className={styles.avatarButton} data-tip="更换头像" aria-label="更换头像" onClick={() => setAvatarEditorOpen(true)}><span className="account-menu-avatar" style={{ backgroundColor: fallbackColor }} aria-hidden="true">{avatarUrl && !avatarFailed ? <img src={avatarUrl} alt="" onError={() => setAvatarFailed(true)} /> : label}</span><span className={styles.avatarCamera} aria-hidden="true"><Camera size={12} /></span></button><strong>{displayName}</strong></div>
        <dl className={styles.info}>{user?.username && <><dt>账号</dt><dd>{user.username}</dd></>}{role && <><dt>角色</dt><dd>{role}</dd></>}</dl>
        {!user?.feishu?.open_id && <button type="button" className={styles.secondary} disabled={loggingOut || bindingFeishu} onClick={() => void handleBindFeishu()}><Link2 size={16} aria-hidden="true" />{bindingFeishu ? '正在前往飞书...' : '绑定飞书'}</button>}
        <p className={styles.hint}>切换账号会退出当前账号，再前往登录页选择账号。同站其它已打开的页面也会退出；按账号保存的草稿会保留。</p>
        {logoutError && <p className={styles.error} role="alert">{logoutError}</p>}
        <footer className={styles.actions}><Link href="/account" className={styles.secondary}>管理个人资料</Link><button type="button" className={styles.secondary} disabled={loggingOut || bindingFeishu} onClick={() => void handleLogout(false, true)}><LogOut size={16} aria-hidden="true" />退出所有设备</button><button type="button" className={styles.primary} disabled={loggingOut || bindingFeishu} onClick={() => void handleLogout(true)}>{loggingOut ? '退出中…' : '切换账号'}</button></footer>
      </AccountDetails>}
      {avatarEditorOpen && user?.id && <AvatarEditor userId={user.id} hasFeishu onClose={() => setAvatarEditorOpen(false)} onChanged={() => { if (appSession) void appSession.refreshUser(); else window.location.reload(); }} />}
      <button
        type="button"
        className="account-menu-logout"
        onClick={() => void handleLogout()}
        disabled={loggingOut || bindingFeishu}
      >
        {loggingOut ? '退出中...' : '退出'}
      </button>
    </div>
  );
}
