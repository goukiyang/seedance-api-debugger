import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { isExternalUser } from '@/lib/access/external-user';

export const dynamic = 'force-dynamic';

export default async function WorkbenchPage() {
  const user = await getSession();
  if (isExternalUser(user)) redirect('/generate/ip');
  redirect('/generate/canvas');
  return null;
}
