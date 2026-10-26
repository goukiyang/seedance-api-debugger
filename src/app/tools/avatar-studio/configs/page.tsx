import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { canUseCompanyTemplates } from '@/lib/image-studio/access';
import AvatarStudio from '../studio';
export const dynamic = 'force-dynamic';
export default async function AvatarConfigsPage() {
  const user = await getSession();
  if (!user) redirect('/login?next=%2Ftools%2Favatar-studio%2Fconfigs');
  if (user.status!=='active'||!canUseCompanyTemplates(user)) return <main style={{ padding: 24 }}>当前账号没有图片生成资格。</main>;
  return <AvatarStudio ownerId={user.id} management />;
}
