import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import ApiClientsClient from './ApiClientsClient';

export const dynamic = 'force-dynamic';
export default async function ApiClientsPage() {
  const user = await getSession();
  if (!user) redirect('/login');
  if (user.role !== 'admin') redirect('/');
  return <ApiClientsClient actorId={user.id} />;
}
