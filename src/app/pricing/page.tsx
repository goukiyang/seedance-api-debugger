import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { isExternalUser, externalFallbackPath } from '@/lib/access/external-role';
import PricingGuideClient from './PricingGuideClient';

export const dynamic = 'force-dynamic';

export default async function PricingGuidePage() {
  const user = await getSession();
  if (!user) redirect('/login?return_to=%2Fpricing');
  if (user.account_type !== 'internal' || isExternalUser(user)) redirect(externalFallbackPath());
  return <Suspense fallback={<p role="status">正在读取费率…</p>}>
    <PricingGuideClient actorId={user.id} isAdmin={user.role === 'admin'} />
  </Suspense>;
}
