import { redirect } from 'next/navigation';
import { externalFallbackPath, isExternalUser } from '@/lib/access/external-role';
import { getSession } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

export default async function WorkbenchPage() {
  const user = await getSession();
  if (!user) redirect('/login?next=/workbench');
  if (isExternalUser(user)) redirect(externalFallbackPath());
  redirect('/tools/ultimate-canvas');
  return null;
}
