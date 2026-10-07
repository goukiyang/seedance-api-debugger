import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { authorizedImageResponse, privateImageHeaders } from '@/lib/media/authorized-image-response';
import { performance } from 'node:perf_hooks';
import { canViewStudioPreset, canUseCompanyTemplates } from '@/lib/image-studio/access';
import { getStudioPresetsFixedReferences } from '@/lib/image-studio/fixed-references';
import { canReadStudioAsset } from '@/lib/image-studio/protected-assets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: { assetId: string } }) {
  const started = performance.now();
  const user = await getSession();
  if (!user) return new Response('Not found', { status: 404, headers: privateImageHeaders });
  const asset = await prisma.asset.findFirst({ where: { id: params.assetId, status: 'active', type: 'image' }, select: { id: true, owner_id: true, original_url: true, mime_type: true, file_name: true } });
  if (!asset) return new Response('Not found', { status: 404, headers: privateImageHeaders });
  if (!await canReadStudioAsset(user, asset)) return new Response('Not found', { status: 404, headers: privateImageHeaders });
  if (asset.owner_id !== user.id && !(user.role === 'admin' && canUseCompanyTemplates(user))) {
    if (!canUseCompanyTemplates(user)) return new Response('Not found', { status: 404, headers: privateImageHeaders });
    const presets = await prisma.imageStudioPreset.findMany({ where: { OR: [{ owner_id: user.id }, { is_shared: true }] }, select: { id: true, owner_id: true, scope: true, is_shared: true, banner_asset_id: true, reference_ids: true } });
    const visiblePresets = presets.filter(preset => canViewStudioPreset(user, preset));
    const explicitAsset = visiblePresets.some(preset => preset.banner_asset_id === asset.id
      || (() => { try { const ids = JSON.parse(preset.reference_ids); return Array.isArray(ids) && ids.includes(asset.id); } catch { return false; } })());
    let fixedAsset = false;
    if (!explicitAsset) {
      try {
        const fixedByPreset = await getStudioPresetsFixedReferences(user, visiblePresets);
        fixedAsset = Array.from(fixedByPreset.values()).some(references => references.some(reference => reference.assetId === asset.id));
      } catch { return new Response('Not found', { status: 404, headers: privateImageHeaders }); }
    }
    if (!explicitAsset && !fixedAsset) return new Response('Not found', { status: 404, headers: privateImageHeaders });
  }
  try {
    const thumbnail = new URL(_request.url).searchParams.get('thumbnail') === '1';
    const preview = new URL(_request.url).searchParams.get('preview') === '1';
    const detail = new URL(_request.url).searchParams.get('detail') === '1';
    const download = new URL(_request.url).searchParams.get('download') === '1';
    return await authorizedImageResponse(_request, asset.original_url, thumbnail ? 'thumbnail' : preview ? 'preview' : detail ? 'detail' : download ? 'download' : 'original', asset.mime_type || 'application/octet-stream', asset.file_name, started);
  } catch {
    return new Response('Image unavailable', { status: 503, headers: privateImageHeaders });
  }
}
export const HEAD = GET;
