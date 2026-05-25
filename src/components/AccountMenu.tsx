'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

export interface AccountMenuUser {
  name?: string | null;
  username?: string | null;
  email?: string | null;
  avatar_url?: string | null;
  role?: 'admin' | 'user' | string | null;
}

interface AccountMenuProps {
  user?: AccountMenuUser | null;
  loading?: boolean;
  variant?: 'shell' | 'composer';
}

const avatarPalette = [
  '#324264',
  '#3f3a5f',
  '#2f4b45',
  '#4d3f32',
  '#3b4354',
  '#4a3745',
];

function avatarLabel(user: AccountMenuUser | null | undefined, displayName: string | undefined) {
  const raw = displayName || user?.email || user?.username || 'U';
  const localPart = raw.includes('@') ? raw.split('@')[0] : raw;
  const segments = localPart
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean);

  if (segments.length >= 2) {
    return `${segments[0][0] || ''}${segments[1][0] || ''}`.toUpperCase();
  }

  return Array.from(segments[0] || localPart.trim() || 'U').slice(0, 2).join('').toUpperCase();
}

function avatarColor(user: AccountMenuUser | null | undefined, displayName: string | undefined) {
  const source = `${user?.email || ''}${user?.username || ''}${displayName || ''}`;
  const hash = Array.from(source || 'user').reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return avatarPalette[hash % avatarPalette.length];
}

function roleLabel(user: AccountMenuUser | null | undefined) {
  if (user?.role === 'admin') return '管理员';
  if (user?.role === 'user') return '普通用户';
  return null;
}

export default function AccountMenu({ user, loading = false, variant = 'shell' }: AccountMenuProps) {
  const [loggingOut, setLoggingOut] = useState(false);
  const [avatarFailed, setAvatarFailed] = useState(false);

  const displayName = user?.name?.trim() || user?.username?.trim() || user?.email?.trim();
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
    setLoggingOut(true);

    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
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
