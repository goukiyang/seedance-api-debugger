import { redirect } from 'next/navigation';
import { TemplateLibraryClient } from '@/components/templates/TemplateLibraryClient';
import { externalFallbackPath, isExternalUser } from '@/lib/access/external-role';
import { getSession } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

export default async function TemplatesPage() {
  const user = await getSession();
  if (isExternalUser(user)) redirect(externalFallbackPath());
  return <TemplateLibraryClient />;
}
