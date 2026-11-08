import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import CharacterFusionStudio from './studio';

export const dynamic = 'force-dynamic';
export default async function CharacterFusionPage() {
  const user = await getSession();
  if (!user) redirect('/login?next=%2Ftools%2Fcharacter-fusion');
  if (user.status !== 'active') return <main style={{ padding: 24 }}>当前账号已被禁用。</main>;
  return <CharacterFusionStudio key={user.id} ownerId={user.id} />;
}
