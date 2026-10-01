import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { readStudioImage, readStudioThumbnail, readStudioPreview } from '@/lib/image-studio/media';
import { canViewStudioPreset, canUseCompanyTemplates } from '@/lib/image-studio/access';
import { getStudioPresetsFixedReferences } from '@/lib/image-studio/fixed-references';
import { canReadStudioAsset } from '@/lib/image-studio/protected-assets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: { assetId: string } }) {
  const user = await getSession();
  if (!user) return new Response('Not found', { status: 404 });
  const asset = await prisma.asset.findFirst({ where: { id: params.assetId, status: 'active', type: 'image' }, select: { id: true, owner_id: true, original_url: true } });
  if (!asset) return new Response('Not found', { status: 404 });
  if (!await canReadStudioAsset(user, asset)) return new Response('Not found', { status: 404 });
  if (asset.owner_id !== user.id && !(user.role === 'admin' && canUseCompanyTemplates(user))) {
    if (!canUseCompanyTemplates(user)) return new Response('Not found', { status: 404 });
    const presets = await prisma.imageStudioPreset.findMany({ where: { OR: [{ owner_id: user.id }, { is_shared: true }] }, select: { id: true, owner_id: true, scope: true, is_shared: true, banner_asset_id: true, reference_ids: true } });
    const visiblePresets = presets.filter(preset => canViewStudioPreset(user, preset));
    const explicitAsset = visiblePresets.some(preset => preset.banner_asset_id === asset.id
      || (() => { try { const ids = JSON.parse(preset.reference_ids); return Array.isArray(ids) && ids.includes(asset.id); } catch { return false; } })());
    let fixedAsset = false;
    if (!explicitAsset) {
      try {
        const fixedByPreset = await getStudioPresetsFixedReferences(user, visiblePresets);
        fixedAsset = Array.from(fixedByPreset.values()).some(references => references.some(reference => reference.assetId === asset.id));
      } catch { return new Response('Not found', { status: 404 }); }
    }
    if (!explicitAsset && !fixedAsset) return new Response('Not found', { status: 404 });
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
