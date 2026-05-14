'use client';

import { useState } from 'react';
import Link from 'next/link';

export interface AccountMenuUser {
  name?: string | null;
  username?: string | null;
  email?: string | null;
}

interface AccountMenuProps {
  user?: AccountMenuUser | null;
  loading?: boolean;
  variant?: 'shell' | 'composer';
}

export default function AccountMenu({ user, loading = false, variant = 'shell' }: AccountMenuProps) {
  const [loggingOut, setLoggingOut] = useState(false);

  const displayName = user?.name?.trim() || user?.username?.trim() || user?.email?.trim();
  const className = `account-menu account-menu-${variant}`;

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
        {displayName}
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
