import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { externalFallbackPath, isExternalUser } from '@/lib/access/external-role';
import StoryStudio from './story-studio';
import { canUseCompanyTemplates } from '@/lib/image-studio/access';
import { getMuskApiSettings } from '@/lib/integrations/musk';

export const dynamic = 'force-dynamic';

export default async function StoryStudioPage({ searchParams = {} }: {
  searchParams?: { document_id?: string; node_id?: string };
}) {
  const valid = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value) ? value : '';
  const documentId = valid(searchParams.document_id);
  const nodeId = valid(searchParams.node_id);
  const user = await getSession();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/story-studio?${new URLSearchParams({ document_id: documentId, node_id: nodeId })}`)}`);
  if (isExternalUser(user)) redirect(externalFallbackPath());
  const settings = await getMuskApiSettings();
  return <StoryStudio userId={user.id} documentId={documentId} nodeId={nodeId} imageAllowed={canUseCompanyTemplates(user)} defaultTextModel={settings.default_model} />;
}
