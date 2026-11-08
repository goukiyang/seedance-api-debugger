import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import WorkspaceSidebar from '@/components/home/WorkspaceSidebar';
import { isNavItemVisible } from '@/lib/navigation';
import { canUseWorksPreview } from '@/lib/works/rollout.server';
import homeStyles from '@/app/home.module.css';
import CharacterFusionStudio from './studio';

export const dynamic = 'force-dynamic';
export default async function CharacterFusionPage() {
  const user = await getSession();
  if (!user) redirect('/login?next=%2Ftools%2Fcharacter-fusion');
  if (user.status !== 'active') return <main style={{ padding: 24 }}>当前账号已被禁用。</main>;
  return <div className={homeStyles.page}>
    <WorkspaceSidebar accountId={user.id}
      internal={isNavItemVisible({ label: '创作', href: '/generate', externalHidden: true }, user)}
      images={isNavItemVisible({ label: '图片生成', href: '/image-studio', imageStudioOnly: true }, user)} worksEnabled={canUseWorksPreview(user)} />
    <CharacterFusionStudio key={user.id} ownerId={user.id} />
  </div>;
}
