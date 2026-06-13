import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import AdminPricingClient from './AdminPricingClient';

export default async function AdminPricingPage() {
  const user = await getSession();
  if (!user) redirect('/login');
  if (user.role !== 'admin') redirect('/generate');

  return <AdminPricingClient currentUser={user} />;
}
