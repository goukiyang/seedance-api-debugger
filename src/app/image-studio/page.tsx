import { notFound, redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { canUseCompanyTemplates } from '@/lib/image-studio/access';

export const dynamic = 'force-dynamic';

type ImageStudioSearchParams = {
  moduleId?: string;
  presetId?: string;
};

function safeImageStudioParams(searchParams: ImageStudioSearchParams) {
  const params = new URLSearchParams();
  params.set('type', 'image');
  for (const [key, maxLength] of [['moduleId', 100], ['presetId', 200]] as const) {
    const value = searchParams[key];
    if (!value || value.length > maxLength || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) continue;
    params.set(key, value);
  }
  return params.toString();
}

export default async function ImageStudioPage({
  searchParams = {},
}: {
  searchParams?: ImageStudioSearchParams;
}) {
  const legacyQuery = new URLSearchParams();
  for (const key of ['moduleId', 'presetId'] as const) {
    const value = searchParams[key];
    if (value && value.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) legacyQuery.set(key, value);
  }
  const legacyPath = `/image-studio${legacyQuery.size ? `?${legacyQuery.toString()}` : ''}`;
  const user = await getSession();
  if (!user) redirect(`/login?next=${encodeURIComponent(legacyPath)}`);
  if (!canUseCompanyTemplates(user)) notFound();
  redirect(`/template-studio?${safeImageStudioParams(searchParams)}`);
}
