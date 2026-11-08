import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import ClaimManager from './ClaimManager';

export default async function Page() {
  const user = await getSession();
  if (!user) redirect('/login?next=%2Fadmin%2Fpoints%2Fclaims');
  if (user.role !== 'admin') redirect('/');
  return <ClaimManager actorId={user.id} />;
}
