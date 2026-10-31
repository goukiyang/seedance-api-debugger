import { notFound, redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { canUseCompanyTemplates } from '@/lib/image-studio/access';
import { canReadStudioAsset } from '@/lib/image-studio/protected-assets';
import { studioOutputTaskWhere, studioTaskHasViewableOutput } from '@/lib/image-studio/dimension-mismatch';

export const dynamic = 'force-dynamic';

export default async function ImageStudioOriginalPage({ params }: { params: { assetId: string } }) {
  const assetId = params.assetId;
  const user = await getSession();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/image-studio/original/${encodeURIComponent(assetId)}`)}`);
  if (!canUseCompanyTemplates(user)) notFound();
  const task = await prisma.imageStudioTask.findFirst({
    where: { owner_id: user.id, asset_id: assetId, deleted_at: null, AND: [studioOutputTaskWhere] },
    select: { asset_id: true, status: true, usage_json: true },
  });
  if (!task || !studioTaskHasViewableOutput(task)) notFound();
  const asset = await prisma.asset.findFirst({
    where: { id: assetId, owner_id: user.id, status: 'active', type: 'image' },
    select: { id: true, owner_id: true, original_url: true, mime_type: true, file_name: true },
  });
  if (!asset || !await canReadStudioAsset(user, asset)) notFound();
  redirect(`/api/image-studio/assets/${encodeURIComponent(asset.id)}`);
}
