import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import AdminOutputsClient from './AdminOutputsClient';

export default async function AdminOutputsPage() {
  const user = await getSession();
  if (!user) redirect('/login');
  if (user.role !== 'admin') redirect('/generate');

  return <AdminOutputsClient />;
}
