import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { canUseCompanyTemplates } from '@/lib/image-studio/access';
import CharacterLabStudio from './studio';

export const dynamic = 'force-dynamic';

export default async function CharacterLabPage({ searchParams }: { searchParams: { workspace?: string; view?: string } }) {
  const user = await getSession();
  if (!user) {
    const query = new URLSearchParams();
    if (searchParams.workspace) query.set('workspace', searchParams.workspace);
    if (searchParams.view === 'body' || searchParams.view === 'prompts') query.set('view', searchParams.view);
    redirect('/login?next=' + encodeURIComponent('/tools/character-lab' + (query.size ? '?' + query : '')));
  }
  if (user.status !== 'active' || !canUseCompanyTemplates(user)) return <main style={{ padding: 24 }}>当前账号没有图片生成资格。</main>;
  return <CharacterLabStudio key={user.id} ownerId={user.id} isAdmin={user.role === 'admin'} initialWorkspaceId={searchParams.workspace} initialPrompts={searchParams.view === 'prompts'} initialBody={searchParams.view === 'body'} />;
}
