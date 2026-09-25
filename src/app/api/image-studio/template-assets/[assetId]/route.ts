import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { readStudioImage, readStudioThumbnail, readStudioPreview } from '@/lib/image-studio/media';
import { canViewStudioPreset, canUseCompanyTemplates } from '@/lib/image-studio/access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: { assetId: string } }) {
  const user = await getSession();
  if (!user) return new Response('Not found', { status: 404 });
  const asset = await prisma.asset.findFirst({ where: { id: params.assetId, status: 'active', type: 'image' }, select: { id: true, owner_id: true, original_url: true } });
  if (!asset) return new Response('Not found', { status: 404 });
  if (asset.owner_id !== user.id) {
    if (!canUseCompanyTemplates(user)) return new Response('Not found', { status: 404 });
    const presets = await prisma.imageStudioPreset.findMany({ where: { OR: [{ banner_asset_id: asset.id }, { reference_ids: { contains: `\"${asset.id}\"` } }] }, select: { owner_id: true, scope: true, is_shared: true } });
    if (!presets.some(preset => canViewStudioPreset(user, preset))) return new Response('Not found', { status: 404 });
  }
  try {
    const thumbnail = new URL(_request.url).searchParams.get('thumbnail') === '1';
    const preview = new URL(_request.url).searchParams.get('preview') === '1';
    const bytes = await (thumbnail ? readStudioThumbnail(asset.original_url) : preview ? readStudioPreview(asset.original_url) : readStudioImage(asset.original_url));
    return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': thumbnail || preview ? 'image/webp' : 'image/png', 'Content-Length': String(bytes.length), 'Cache-Control': 'private, no-store', 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff' } });
  } catch {
    return new Response('Image unavailable', { status: 503 });
  }
}
