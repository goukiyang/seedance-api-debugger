import { redirect } from 'next/navigation';
import { TemplateLibraryClient } from '@/components/templates/TemplateLibraryClient';
import { getSession } from '@/lib/auth/session';
import { isExternalUser } from '@/lib/access/external-user';

export const dynamic = 'force-dynamic';

export default async function TemplatesPage() {
  const user = await getSession();
  if (isExternalUser(user)) redirect('/generate/ip');
  return <TemplateLibraryClient />;
}
