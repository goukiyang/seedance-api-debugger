import { getSession } from '@/lib/auth/session';
import { studioStyleDraftAsset } from '@/lib/image-studio/style-groups';
import { authorizedImageResponse, discardHdViewingInterest, privateImageHeaders } from '@/lib/media/authorized-image-response';

export const dynamic = 'force-dynamic';
export async function GET(request: Request, { params }: { params: { id: string; assetId: string } }) {
  const user = await getSession();
  try {
    const asset = user && await studioStyleDraftAsset(user, params.id, params.assetId);
    if (!asset) {
      if (user) await discardHdViewingInterest(request, user.id);
      return new Response(null, { status: 404, headers: privateImageHeaders });
    }
    return await authorizedImageResponse(request, asset.original_url, new URL(request.url).searchParams.get('thumbnail') === '1' ? 'thumbnail' : 'original',
      asset.mime_type || 'application/octet-stream', asset.file_name, undefined, { requesterId: user.id, owner: { kind: 'asset', id: asset.id, ownerId: asset.owner_id } });
  } catch { return new Response(null, { status: 404, headers: privateImageHeaders }); }
}
export const HEAD = GET;
