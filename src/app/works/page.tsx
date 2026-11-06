import { notFound, redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { isNavItemVisible } from '@/lib/navigation';
import { canUseCompanyTemplates } from '@/lib/image-studio/access';
import HomeWorkspace from '@/components/home/HomeWorkspace';
import { canUseWorksPreview } from '@/lib/works/rollout.server';

export const dynamic = 'force-dynamic';

export default async function WorksPage() {
  const user = await getSession();
  if (!user) redirect('/register');
  if (!canUseWorksPreview(user)) notFound();
  return <HomeWorkspace accountId={user.id} worksEnabled showWorks
    internal={isNavItemVisible({ label: '创作', href: '/generate', externalHidden: true }, user)}
    images={canUseCompanyTemplates(user)} admin={user.role === 'admin'} />;
}
