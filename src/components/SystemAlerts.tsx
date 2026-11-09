import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import type { SystemAlert } from '@/lib/notifications/display';

export function SystemAlerts({ alerts }: { alerts: SystemAlert[] }) {
  return <>{alerts.map(alert => <div className={alert.id === 'hd_hard_pause' ? 'notification-dropdown-error' : 'notification-dropdown-meta'} role="alert" key={alert.id}>
    <AlertTriangle size={16} aria-hidden="true" />
    <Link href={alert.href} title={alert.body}>{alert.title} · 查看状态</Link>
  </div>)}</>;
}
