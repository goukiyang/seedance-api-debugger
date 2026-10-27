import { route as declaredRoute } from '@/lib/http/route';
import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { canManageStudioStyle, getStudioStyleGroup } from '@/lib/image-studio/style-groups';
import { authorizedImageResponse, discardHdViewingInterest, privateImageHeaders } from '@/lib/media/authorized-image-response';
import { redirectMedia } from '@/lib/media/outlet';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = declaredRoute({ access: 'user', rateLimit: false, unauthenticatedStatus: 404 }, async function GET(
  request: Request,
  props: { params: Promise<{ groupId: string; assetId: string }> }
) {
  const params = await props.params;
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
    return await redirectMedia(request, user, { type: 'asset', id: asset.id }, variant);
  } catch { return unavailable(); }
});
export const HEAD = GET;
