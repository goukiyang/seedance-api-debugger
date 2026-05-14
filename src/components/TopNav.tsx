import Link from 'next/link';
import AccountMenu, { type AccountMenuUser } from './AccountMenu';

interface TopNavProps {
  user?: AccountMenuUser | null;
  loadingUser?: boolean;
  availableCredits?: number | null;
}

export default function TopNav({ user, loadingUser, availableCredits }: TopNavProps) {
  return (
    <header className="shell-topbar">
      <div className="shell-topbar-brand">
        <Link href="/" className="shell-brand-link">
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

        <AccountMenu user={user} loading={loadingUser} />
      </div>
    </header>
  );
}
