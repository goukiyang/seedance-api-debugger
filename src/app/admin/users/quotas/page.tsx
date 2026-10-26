import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import QuotaManager from './QuotaManager';

export default async function QuotaPage() {
  const user = await getSession();
  if (!user) redirect('/login');
  if (user.role !== 'admin') redirect('/generate');
  return <QuotaManager />;
}
