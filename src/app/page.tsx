import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { isNavItemVisible } from '@/lib/navigation';
import { canUseCompanyTemplates } from '@/lib/image-studio/access';
import HomeWorkspace from '@/components/home/HomeWorkspace';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const user = await getSession();
  if (!user) redirect('/register');
  return <HomeWorkspace accountId={user.id}
    internal={isNavItemVisible({ label: '创作', href: '/generate', externalHidden: true }, user)}
    images={canUseCompanyTemplates(user)} admin={user.role === 'admin'} />;
}
