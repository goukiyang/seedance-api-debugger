import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { authorizedImageResponse, discardHdViewingInterest, privateImageHeaders } from '@/lib/media/authorized-image-response';
import { performance } from 'node:perf_hooks';
import { canViewStudioPreset, canUseCompanyTemplates, type ImageStudioIdentity } from '@/lib/image-studio/access';
import { getStudioPresetsFixedReferences } from '@/lib/image-studio/fixed-references';
import { canReadStudioAsset } from '@/lib/image-studio/protected-assets';
import { homeTemplateCover } from '@/lib/content-reactions/home-templates';
import { studioPresetArchived } from '@/lib/image-studio/preset-lifecycle';
import { assertStudioActor } from '@/lib/image-studio/shared-contract';
import { getStudioPresetReferencePolicy } from '@/lib/image-studio/reference-policy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: { assetId: string } }) {
  const started = performance.now();
  const user = await getSession();
  if (!user) return new Response('Not found', { status: 404, headers: privateImageHeaders });
  const unavailable = async () => {
    await discardHdViewingInterest(_request, user.id);
    return new Response('Not found', { status: 404, headers: privateImageHeaders });
  };
  const homeKey = new URL(_request.url).searchParams.get('homeContentKey');
  if (homeKey !== null) {
    // This projection grants no original access: recheck the exact current
    // object/banner/file binding on every authorized thumbnail read.
    try {
      const asset = await homeTemplateCover(user, homeKey, params.assetId);
      if (!asset) return unavailable();
      return await authorizedImageResponse(_request, asset.original_url, 'thumbnail', asset.mime_type || 'application/octet-stream', asset.file_name, started);
    } catch { return unavailable(); }
  }
  const asset = await prisma.asset.findFirst({ where: { id: params.assetId, status: 'active', type: 'image' }, select: { id: true, owner_id: true, original_url: true, mime_type: true, file_name: true } });
  if (!asset) return unavailable();
  if (!await canReadStudioAsset(user, asset)) return unavailable();
  if (asset.owner_id !== user.id) {
    let actor: ImageStudioIdentity;
    try { actor = await assertStudioActor(user.id); }
    catch { return unavailable(); }
    if (!canUseCompanyTemplates(actor)) return unavailable();
    const presets = await prisma.imageStudioPreset.findMany({ where: { OR: [{ owner_id: actor.id }, { is_shared: true }] }, select: { id: true, owner_id: true, scope: true, is_shared: true, banner_asset_id: true, reference_ids: true } });
    const active = await Promise.all(presets.map(async preset => canViewStudioPreset(actor, preset) && preset.owner_id === asset.owner_id && !(await studioPresetArchived(preset.id))));
    const visiblePresets = presets.filter((_, index) => active[index]);
    let explicitAsset = false;
    for (const preset of visiblePresets) {
      if (preset.banner_asset_id === asset.id) { explicitAsset = true; break; }
      try {
        const ids = JSON.parse(preset.reference_ids);
        if (!Array.isArray(ids)) continue;
        const policy = await getStudioPresetReferencePolicy(preset.owner_id, preset.id, ids, undefined);
        if (ids.includes(asset.id) && !policy.primaryIds.includes(asset.id)) { explicitAsset = true; break; }
      } catch { return unavailable(); }
    }
    let fixedAsset = false;
    if (!explicitAsset) {
      try {
        const fixedByPreset = await getStudioPresetsFixedReferences(actor, visiblePresets);
        fixedAsset = Array.from(fixedByPreset.values()).some(references => references.some(reference => reference.assetId === asset.id));
      } catch { return unavailable(); }
    }
    if (!explicitAsset && !fixedAsset) return unavailable();
  }
  try {
    const thumbnail = new URL(_request.url).searchParams.get('thumbnail') === '1';
    const preview = new URL(_request.url).searchParams.get('preview') === '1';
    const detail = new URL(_request.url).searchParams.get('detail') === '1';
    const download = new URL(_request.url).searchParams.get('download') === '1';
    const hd = ['hd', 'hd-description', 'hd-download'].find(key => new URL(_request.url).searchParams.get(key) === '1') as 'hd' | 'hd-description' | 'hd-download' | undefined;
    return await authorizedImageResponse(_request, asset.original_url, hd || (thumbnail ? 'thumbnail' : preview ? 'preview' : detail ? 'detail' : download ? 'download' : 'original'), asset.mime_type || 'application/octet-stream', asset.file_name, started,
      { requesterId: user.id, owner: { kind: 'asset', id: asset.id, ownerId: asset.owner_id } });
  } catch {
    return new Response('Image unavailable', { status: 503, headers: privateImageHeaders });
  }
}
export const HEAD = GET;
