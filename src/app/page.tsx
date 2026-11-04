import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { isNavItemVisible } from '@/lib/navigation';
import { canUseCompanyTemplates } from '@/lib/image-studio/access';
import HomeWorkspace from '@/components/home/HomeWorkspace';
import { canUseWorksPreview } from '@/lib/works/rollout.server';

export const dynamic = 'force-dynamic';

export default async function Home({ searchParams }: { searchParams: { view?: string } }) {
  const user = await getSession();
  if (!user) redirect('/register');
  const worksEnabled = canUseWorksPreview(user);
  return <HomeWorkspace accountId={user.id} worksEnabled={worksEnabled} showWorks={worksEnabled && searchParams.view !== 'overview'}
    internal={isNavItemVisible({ label: '创作', href: '/generate', externalHidden: true }, user)}
    images={canUseCompanyTemplates(user)} admin={user.role === 'admin'} />;
}
