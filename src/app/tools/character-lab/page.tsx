import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { canUseCompanyTemplates } from '@/lib/image-studio/access';
import CharacterLabStudio from './studio';

export const dynamic = 'force-dynamic';

export default async function CharacterLabPage({ searchParams }: { searchParams: { workspace?: string; view?: string } }) {
  const user = await getSession();
  if (!user) redirect('/login?next=%2Ftools%2Fcharacter-lab');
  if (user.status !== 'active' || !canUseCompanyTemplates(user)) return <main style={{ padding: 24 }}>当前账号没有图片生成资格。</main>;
  return <CharacterLabStudio key={user.id} ownerId={user.id} isAdmin={user.role === 'admin'} initialWorkspaceId={searchParams.workspace} initialPrompts={searchParams.view === 'prompts'} />;
}
