import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import ImageStudio from './studio';

export const dynamic = 'force-dynamic';

export default async function ImageStudioPage() {
  const user = await getSession();
  if (!user) redirect('/login');
  return <ImageStudio isAdmin={user.role === 'admin'} />;
}
