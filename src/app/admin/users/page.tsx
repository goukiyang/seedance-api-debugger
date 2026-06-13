import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import AdminUsersClient from './AdminUsersClient';

export default async function AdminUsersPage() {
  const user = await getSession();
  if (!user) redirect('/login');
  if (user.role !== 'admin') redirect('/generate');

  return <AdminUsersClient currentUser={user} />;
}
