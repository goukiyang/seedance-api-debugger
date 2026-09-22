import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import AdminImageStudioClient from './AdminImageStudioClient';

export const dynamic = 'force-dynamic';

export default async function AdminImageStudioPage() {
  const user = await getSession();
  if (!user) redirect('/login');
  if (user.role !== 'admin') redirect('/generate');
  return <AdminImageStudioClient />;
}
