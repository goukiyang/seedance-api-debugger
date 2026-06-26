import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import AdminIntegrationsClient from '../AdminIntegrationsClient';

export const dynamic = 'force-dynamic';

export default async function VolcengineIpIntegrationPage() {
  const user = await getSession();
  if (!user) redirect('/login');
  if (user.role !== 'admin') redirect('/generate');

  return <AdminIntegrationsClient />;
}
