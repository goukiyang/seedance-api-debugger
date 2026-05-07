'use client';

import { useState } from 'react';
import Link from 'next/link';

interface TopNavProps {
  userName?: string;
  availableCredits?: number | null;
}

export default function TopNav({ userName, availableCredits }: TopNavProps) {
  const [loggingOut, setLoggingOut] = useState(false);

  const handleLogout = async () => {
    if (loggingOut) return;
    setLoggingOut(true);

    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      window.location.href = '/login';
    }
  };

  return (
    <header className="shell-topbar">
      <div className="shell-topbar-brand">
        <Link href="/dashboard" className="shell-brand-link">
          <span className="shell-brand-mark">S2</span>
          <div>
            <div className="shell-brand-title">Seedance 2.0</div>
            <div className="shell-brand-subtitle">内部平台</div>
          </div>
        </Link>
      </div>

      <div className="shell-topbar-actions">
        <div className="shell-topbar-pill">
          <span className="shell-topbar-label">可用积分</span>
          <span className="shell-topbar-value">
            {typeof availableCredits === 'number' ? availableCredits : '--'}
          </span>
        </div>

        <button type="button" className="shell-icon-button" aria-label="通知">
          通知
        </button>

        <div className="shell-topbar-user">
          <span className="shell-topbar-user-name">{userName || '当前用户'}</span>
          <button
            type="button"
            className="shell-logout-button"
            onClick={handleLogout}
            disabled={loggingOut}
          >
            {loggingOut ? '退出中...' : '退出登录'}
          </button>
        </div>
      </div>
    </header>
  );
}
