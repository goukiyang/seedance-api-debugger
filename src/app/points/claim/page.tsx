import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import ClaimPage from './ClaimPage';

export default async function Page({ searchParams }: { searchParams: { campaign?: string } }) {
  const campaignId = searchParams.campaign || '';
  const user = await getSession();
  if (!user) redirect(`/login?next=${encodeURIComponent('/points/claim' + (campaignId ? `?campaign=${encodeURIComponent(campaignId)}` : ''))}`);
  return <ClaimPage actorId={user.id} campaignId={campaignId} />;
}
