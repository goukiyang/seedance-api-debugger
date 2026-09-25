'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  displayUserInitials,
  displayUserName,
  userAvatarColor,
} from '@/lib/users/display';

export interface AccountMenuUser {
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

export default function AccountMenu({
  user,
  loading = false,
  variant = 'shell',
  onSessionClear,
}: AccountMenuProps) {
  const [loggingOut, setLoggingOut] = useState(false);
  const [avatarFailed, setAvatarFailed] = useState(false);

  const displayName = user ? displayUserName(user) : '';
  const className = `account-menu account-menu-${variant}`;
  const label = avatarLabel(user, displayName);
  const fallbackColor = avatarColor(user, displayName);
  const avatarUrl = user?.avatar_url?.trim();
  const role = roleLabel(user);

  useEffect(() => {
    setAvatarFailed(false);
  }, [avatarUrl]);

  const handleLogout = async () => {
    if (loggingOut) return;
    const canvasDraftKeys: string[] = [];
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key?.startsWith('sd2:canvas-draft:') || key?.startsWith('sd2:canvas-conflict:')) canvasDraftKeys.push(key);
      }
    } catch { /* Storage may be unavailable in restricted browser sessions. */ }
    if (canvasDraftKeys.length && !window.confirm('这台设备有未同步的画布草稿。退出会清除这些本地草稿，服务器已保存内容不受影响。确认退出？')) return;
    setLoggingOut(true);

    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      try {
        canvasDraftKeys.forEach(key => localStorage.removeItem(key));
        localStorage.removeItem('ultimate-canvas:last-library-document');
      } catch { /* The next session still requires server authorization. */ }
      onSessionClear?.();
      window.location.href = '/login';
    }
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
      <Link href="/account" className="account-menu-name" title="进入个人页">
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
      </Link>
      <button
        type="button"
        className="account-menu-logout"
        onClick={handleLogout}
        disabled={loggingOut}
      >
        {loggingOut ? '退出中...' : '退出'}
      </button>
    </div>
  );
}
