import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { canManageStudioStyle, getStudioStyleGroup } from '@/lib/image-studio/style-groups';
import { authorizedImageResponse, discardHdViewingInterest, privateImageHeaders } from '@/lib/media/authorized-image-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, { params }: { params: { groupId: string; assetId: string } }) {
  const user = await getSession();
  if (!user) return new Response('Not found', { status: 404, headers: privateImageHeaders });
  const unavailable = async () => {
    await discardHdViewingInterest(request, user.id);
    return new Response('Not found', { status: 404, headers: privateImageHeaders });
  };
  try {
    const group = await getStudioStyleGroup(user, params.groupId);
    if (!canManageStudioStyle(user, group) || !group.references.some(ref => ref.assetId === params.assetId)) return unavailable();
    const asset = await prisma.asset.findFirst({ where: { id: params.assetId, status: 'active', type: 'image' }, select: { id: true, owner_id: true, original_url: true, mime_type: true, file_name: true } });
    if (!asset) return unavailable();
    const query = new URL(request.url).searchParams;
    const hd = ['hd', 'hd-description', 'hd-download'].find(key => query.get(key) === '1') as 'hd' | 'hd-description' | 'hd-download' | undefined;
    const variant = hd || (query.get('thumbnail') === '1' ? 'thumbnail' : query.get('preview') === '1' ? 'preview' : query.get('detail') === '1' ? 'detail' : query.get('download') === '1' ? 'download' : 'original');
    return await authorizedImageResponse(request, asset.original_url, variant, asset.mime_type || 'application/octet-stream', asset.file_name, undefined,
      { requesterId: user.id, owner: { kind: 'asset', id: asset.id, ownerId: asset.owner_id } });
  } catch { return unavailable(); }
}
export const HEAD = GET;
