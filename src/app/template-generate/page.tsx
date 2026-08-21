import { redirect } from 'next/navigation';
import { TemplateGenerateClient } from '@/components/templates/TemplateGenerateClient';
import { getSession } from '@/lib/auth/session';
import { isExternalUser } from '@/lib/access/external-user';

export const dynamic = 'force-dynamic';

export default async function TemplateGeneratePage() {
  const user = await getSession();
  if (isExternalUser(user)) redirect('/generate/ip');
  return <TemplateGenerateClient />;
}
