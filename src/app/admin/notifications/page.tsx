import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import AdminNotificationsClient from './AdminNotificationsClient';

export const dynamic = 'force-dynamic';

export default async function AdminNotificationsPage() {
  const user = await getSession();
  if (!user) redirect('/login');
  if (user.role !== 'admin') redirect('/generate');

  return <AdminNotificationsClient />;
}
