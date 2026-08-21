import { redirect } from 'next/navigation';
import { TemplateGenerateClient } from '@/components/templates/TemplateGenerateClient';
import { externalFallbackPath, isExternalUser } from '@/lib/access/external-role';
import { getSession } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

export default async function TemplateGeneratePage() {
  const user = await getSession();
  if (isExternalUser(user)) redirect(externalFallbackPath());
  return <TemplateGenerateClient />;
}
