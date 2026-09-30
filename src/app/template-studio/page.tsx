import { redirect } from 'next/navigation';
import { canUseCompanyTemplates } from '@/lib/image-studio/access';
import { isExternalUser, externalFallbackPath } from '@/lib/access/external-role';
import { getSession } from '@/lib/auth/session';
import TemplateStudioShell from '@/components/template-studio/TemplateStudioShell';

export const dynamic = 'force-dynamic';

type SearchParams = {
  type?: string;
  view?: string;
  runId?: string;
  draftId?: string;
  moduleId?: string;
  presetId?: string;
  templateId?: string;
  templateSource?: string;
};

function safeWorkbenchQuery(params: SearchParams) {
  const query = new URLSearchParams();
  for (const key of ['type', 'view', 'runId', 'draftId', 'moduleId', 'presetId', 'templateId', 'templateSource'] as const) {
    const value = params[key];
    if (!value || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) continue;
    query.set(key, value);
  }
  return query.toString();
}

export default async function TemplateStudioPage({ searchParams = {} }: { searchParams?: SearchParams }) {
  const query = safeWorkbenchQuery(searchParams);
  const next = `/template-studio${query ? `?${query}` : ''}`;
  const user = await getSession();
  if (!user) redirect(`/login?next=${encodeURIComponent(next)}`);

  const allowedTypes: Array<'image' | 'video'> = [];
  if (canUseCompanyTemplates(user)) allowedTypes.push('image');
  if (user.account_type === 'internal' && !isExternalUser(user)) allowedTypes.push('video');
  if (allowedTypes.length === 0) redirect(externalFallbackPath());

  const requestedType = searchParams.type === 'image' || searchParams.type === 'video'
    ? searchParams.type
    : allowedTypes[0];
  const initialType = allowedTypes.includes(requestedType) ? requestedType : allowedTypes[0];

  return (
    <TemplateStudioShell
      userId={user.id}
      isAdmin={user.role === 'admin'}
      allowedTypes={allowedTypes}
      initialType={initialType}
    />
  );
}
