import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { canUseCompanyTemplates } from '@/lib/image-studio/access';
import { historicalStudioStyles } from '@/lib/image-studio/style-history';
import { canReadStudioAsset } from '@/lib/image-studio/protected-assets';
import { authorizedImageResponse, discardHdViewingInterest, privateImageHeaders } from '@/lib/media/authorized-image-response';

export const dynamic = 'force-dynamic';
export async function GET(request: Request, { params }: { params: { taskId: string; groupId: string; assetId: string } }) {
  const user = await getSession();
  const unavailable = async () => {
    if (user) await discardHdViewingInterest(request, user.id);
    return new Response(null, { status: 404, headers: privateImageHeaders });
  };
  if (!user || !canUseCompanyTemplates(user)) return unavailable();
  try {
    const task = await prisma.imageStudioTask.findFirst({ where: { id: params.taskId, ...(user.role === 'admin' ? {} : { owner_id: user.id }) }, select: { snapshot_json: true } });
    if (!task?.snapshot_json) return unavailable();
    const group = historicalStudioStyles(JSON.parse(task.snapshot_json), params.taskId, user).find(item => item.id === params.groupId);
    const reference = group?.canReadContent && group.references?.find(item => item.id === params.assetId);
    if (!reference) return unavailable();
    const asset = await prisma.asset.findFirst({ where: { id: reference.id, type: 'image', status: 'active' }, select: { id: true, owner_id: true, original_url: true, mime_type: true, file_name: true, hash: true } });
    if (!asset || reference.hash && reference.hash !== asset.hash || !await canReadStudioAsset(user, asset)) return unavailable();
    const query = new URL(request.url).searchParams;
    const variant = query.get('thumbnail') === '1' ? 'thumbnail' : query.get('download') === '1' ? 'download' : 'original';
    return await authorizedImageResponse(request, asset.original_url, variant, asset.mime_type || 'application/octet-stream', asset.file_name, undefined,
      { requesterId: user.id, owner: { kind: 'asset', id: asset.id, ownerId: asset.owner_id } });
  } catch { return unavailable(); }
}
export const HEAD = GET;
