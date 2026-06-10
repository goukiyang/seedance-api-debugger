'use client';

import { useEffect, useState } from 'react';
import {
  displayUserInitials,
  displayUserName,
  displayUserSubtitle,
  type DisplayUser,
  userAvatarColor,
} from '@/lib/users/display';

interface UserIdentityBadgeProps {
  user?: DisplayUser | null;
  size?: 'sm' | 'md';
  subtitle?: string | null;
  showEmail?: boolean;
  className?: string;
}

export default function UserIdentityBadge({
  user,
  size = 'md',
  subtitle,
  showEmail = false,
  className = '',
}: UserIdentityBadgeProps) {
  const [avatarFailed, setAvatarFailed] = useState(false);
  const avatarUrl = user?.avatar_url?.trim();
  const name = displayUserName(user);
  const secondary = subtitle || (showEmail ? displayUserSubtitle(user) : '');

  useEffect(() => {
    setAvatarFailed(false);
  }, [avatarUrl]);

  return (
    <span className={`user-identity-badge user-identity-badge-${size} ${className}`.trim()}>
      <span className="user-identity-avatar" style={{ backgroundColor: userAvatarColor(user) }} aria-hidden="true">
        {avatarUrl && !avatarFailed ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={avatarUrl} alt="" onError={() => setAvatarFailed(true)} />
        ) : (
          <span>{displayUserInitials(user)}</span>
        )}
      </span>
      <span className="user-identity-copy">
        <span className="user-identity-name">{name}</span>
        {secondary && <span className="user-identity-subtitle">{secondary}</span>}
      </span>
    </span>
  );
}
