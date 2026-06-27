import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import AdminIntegrationsClient from '../AdminIntegrationsClient';

export default async function AiMediaKitIntegrationPage() {
  const user = await getSession();
  if (!user || user.role !== 'admin') redirect('/login');

  return <AdminIntegrationsClient />;
}
