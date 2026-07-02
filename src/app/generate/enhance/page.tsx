import EnhanceVideoPageClient from '@/components/generate/EnhanceVideoPageClient';
import { getSession } from '@/lib/auth/session';
import { redirect } from 'next/navigation';

export default async function EnhanceVideoRoute() {
  const user = await getSession();
  if (!user) redirect('/login?next=/generate/enhance');
  if (user.role !== 'admin') redirect('/generate');

  return <EnhanceVideoPageClient />;
}
