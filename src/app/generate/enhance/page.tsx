import EnhanceVideoPageClient from '@/components/generate/EnhanceVideoPageClient';
import { externalFallbackPath, isExternalUser } from '@/lib/access/external-role';
import { getSession } from '@/lib/auth/session';
import { redirect } from 'next/navigation';

export default async function EnhanceVideoRoute() {
  const user = await getSession();
  if (!user) redirect('/login?next=/generate/enhance');
  if (isExternalUser(user)) redirect(externalFallbackPath());
  if (user.role !== 'admin') redirect('/generate');

  return <EnhanceVideoPageClient />;
}
