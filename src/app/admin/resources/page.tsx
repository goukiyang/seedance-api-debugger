import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import AdminResourcesClient from './AdminResourcesClient';

export default async function AdminResourcesPage() {
  const user = await getSession();
  if (!user) redirect('/login');
  if (user.role !== 'admin') redirect('/generate');

  return <AdminResourcesClient currentUser={user} />;
}
