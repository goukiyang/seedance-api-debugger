import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import AdminDashboardClient from './AdminDashboardClient';

export default async function AdminPage() {
  const user = await getSession();
  if (!user) redirect('/login');
  if (user.role !== 'admin') redirect('/generate');

  return <AdminDashboardClient currentUser={user} />;
}
