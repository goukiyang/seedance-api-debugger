import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import AdminProjectsClient from './AdminProjectsClient';

export default async function AdminProjectsPage() {
  const user = await getSession();
  if (!user) redirect('/login');
  if (user.role !== 'admin') redirect('/generate');

  return <AdminProjectsClient />;
}
