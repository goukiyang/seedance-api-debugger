import { GeneratePageClient } from '@/components/generate/GeneratePageClient';
import { externalFallbackPath, isExternalUser } from '@/lib/access/external-role';
import { getSession } from '@/lib/auth/session';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function GeneratePage() {
  const user = await getSession();
  if (user && isExternalUser(user)) {
    redirect(externalFallbackPath());
  }

  return <GeneratePageClient />;
}
