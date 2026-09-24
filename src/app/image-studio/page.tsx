import { notFound, redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { canUseCompanyTemplates } from '@/lib/image-studio/access';
import ImageStudio from './studio';

export const dynamic = 'force-dynamic';

export default async function ImageStudioPage() {
  const user = await getSession();
  if (!user) redirect('/login?next=/image-studio');
  if (!canUseCompanyTemplates(user)) notFound();
  return <ImageStudio isAdmin={user.role === 'admin'} userId={user.id} />;
}
