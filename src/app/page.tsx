import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { isNavItemVisible } from '@/lib/navigation';
import { canAccessImageTemplates, canUseCompanyTemplates } from '@/lib/image-studio/access';
import HomeWorkspace from '@/components/home/HomeWorkspace';
import { canUseWorksPreview } from '@/lib/works/rollout.server';

export const dynamic = 'force-dynamic';

export default async function Home({ searchParams }: { searchParams: { view?: string; work?: string } }) {
  const user = await getSession();
  if (!user) redirect('/register');
  const worksEnabled = canUseWorksPreview(user);
  return <HomeWorkspace accountId={user.id} worksEnabled={worksEnabled} showWorks={false} detailOpen={worksEnabled && Boolean(searchParams.work)}
    internal={isNavItemVisible({ label: '创作', href: '/generate', externalHidden: true }, user)}
    images={canUseCompanyTemplates(user)} imageTemplates={canAccessImageTemplates(user)} admin={user.role === 'admin'} />;
}
