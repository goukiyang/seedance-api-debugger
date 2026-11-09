import 'server-only';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { SessionUser } from '@/lib/auth/session';
import { getAlbumAccess } from '@/lib/reference-albums/permissions';
import { canUseCompanyTemplates } from '@/lib/image-studio/access';
import { studioHiddenAssetUrls } from '@/lib/image-studio/protected-assets';
import { multiviewOutputFileAccess } from '@/lib/video/multiview-output-access.server';
import { getStudioTemplate } from '@/lib/template-studio/templates';
import { archivedPresetKey } from '@/lib/image-studio/preset-lifecycle';
import { tryContentKeyParts } from './key';
import type { ContentKey } from './types';

async function readBatches<T>(ids: string[], read: (batch: string[]) => Promise<T[]>): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; offset < ids.length; offset += 200) rows.push(...await read(ids.slice(offset, offset + 200)));
  return rows;
}
const byId = <T extends { id: string }>(rows: T[]) => new Map(rows.map(row => [row.id, row]));

const referenceInclude = () => ({ asset: true, album: { include: {
  owner: { select: { id: true, name: true, username: true, email: true, avatar_url: true, account_type: true } },
  project: { select: { id: true, name: true, owner_user_id: true, status: true } },
  shares: { where: { status: 'active', OR: [{ expires_at: null }, { expires_at: { gt: new Date() } }] } },
  _count: { select: { images: { where: { status: 'active' } } } },
} } } satisfies Prisma.ReferenceImageInclude);

/** Only this request may reuse the current authorization projection; nothing is persisted in a reaction. */
export async function createReactionProjection(user: SessionUser, keys: ContentKey[]) {
  const parts = keys.flatMap(key => { const parsed = tryContentKeyParts(key); return parsed ? [parsed] : []; });
  const ids = (type: string) => Array.from(new Set(parts.filter(part => part.type === type).map(part => part.id)));
  const assetIds = ids('asset');
  const referenceIds = ids('reference_image');
  const definitionIds = ids('image_template');
  const moduleIds = Array.from(new Set([...ids('image_module'), ...definitionIds.filter(id => id.startsWith('module-source:')).map(id => id.slice('module-source:'.length))]));
  const [directAssets, references, modules, videoTemplates, drafts, legacy, runs, tasks, seedance] = await Promise.all([
    readBatches(assetIds, batch => prisma.asset.findMany({ where: { id: { in: batch } } })),
    readBatches([...referenceIds, ...assetIds], batch => prisma.referenceImage.findMany({
      where: { status: 'active', album: { status: { not: 'deleted' } }, OR: [{ id: { in: batch } }, { asset_id: { in: batch } }] },
      include: referenceInclude(),
    })),
    readBatches(moduleIds, batch => prisma.imageStudioModule.findMany({ where: { id: { in: batch } } })),
    readBatches(ids('video_template'), batch => prisma.videoStudioTemplate.findMany({ where: { id: { in: batch } },
      include: { published_version: { select: { name: true, version_number: true } } } })),
    readBatches(ids('video_draft'), batch => prisma.videoStudioDraft.findMany({ where: { id: { in: batch }, owner_user_id: user.id, purpose: 'studio' } })),
    readBatches(ids('legacy_template'), batch => prisma.generationTemplate.findMany({ where: { id: { in: batch }, status: 'active' } })),
    readBatches(ids('prompt'), batch => prisma.videoStudioRun.findMany({ where: { id: { in: batch }, owner_user_id: user.id, purpose: 'studio', status: 'succeeded' } })),
    readBatches(ids('video_task'), batch => prisma.videoTask.findMany({ where: { id: { in: batch } } })),
    readBatches(ids('seedance_asset'), batch => prisma.seedanceAsset.findMany({ where: { id: { in: batch }, local_status: 'Active' } })),
  ]);
  const referenceAssetIds = Array.from(new Set(references.flatMap(ref => ref.asset_id && !assetIds.includes(ref.asset_id) ? [ref.asset_id] : [])));
  // A reference key may resolve to an Asset; include its other albums so download/use retain the same union of grants.
  references.push(...await readBatches(referenceAssetIds, batch => prisma.referenceImage.findMany({
    where: { asset_id: { in: batch }, status: 'active', album: { status: { not: 'deleted' } } }, include: referenceInclude(),
  })));
  const assets = byId([...directAssets, ...references.flatMap(ref => ref.asset ? [ref.asset] : [])]);
  const albumAccess = new Map<string, ReturnType<typeof getAlbumAccess>>();
  const targetedAssets = new Set(assetIds);
  for (const ref of references) {
    if (!referenceIds.includes(ref.id) || !ref.asset_id || ref.asset?.status !== 'active') continue;
    let access = albumAccess.get(ref.album_id);
    if (!access) { access = getAlbumAccess(user, ref.album); albumAccess.set(ref.album_id, access); }
    if ((await access).permissions.view) targetedAssets.add(ref.asset_id);
  }
  const activeAssets = Array.from(assets.values()).filter(asset => targetedAssets.has(asset.id)
    && asset.status === 'active' && ['image', 'video', 'audio'].includes(asset.type));
  const sharedAssetIds = activeAssets.filter(asset => asset.owner_id !== user.id && user.role !== 'admin').map(asset => asset.id);
  // Select only presets explicitly referring to these assets, rather than loading the entire company directory per favorite.
  const assetPresets = sharedAssetIds.length && canUseCompanyTemplates(user)
    ? await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      WITH targets AS (SELECT value AS id FROM json_each(${JSON.stringify(sharedAssetIds)}))
      SELECT p.id FROM ImageStudioPreset p WHERE (p.owner_id = ${user.id} OR p.is_shared = 1)
        AND (p.banner_asset_id IN (SELECT id FROM targets) OR EXISTS (
          SELECT 1 FROM json_each(CASE WHEN json_valid(p.reference_ids)
            THEN CASE WHEN json_type(p.reference_ids) = 'array' THEN p.reference_ids ELSE '[]' END ELSE '[]' END) r
          JOIN targets t ON r.type = 'text' AND r.value = t.id))
    `) : [];
  const presetIds = Array.from(new Set([...definitionIds, ...modules.flatMap(row => row.source_preset_id ? [row.source_preset_id] : []), ...assetPresets.map(row => row.id)]));
  const [presets, archived, owners] = await Promise.all([
    readBatches(presetIds, batch => prisma.imageStudioPreset.findMany({ where: { id: { in: batch } } })),
    readBatches(presetIds.map(archivedPresetKey), batch => prisma.platformSetting.findMany({ where: { key: { in: batch } }, select: { key: true } })),
    readBatches(Array.from(new Set([user.id, ...Array.from(assets.values()).map(row => row.owner_id), ...references.map(row => row.owner_user_id),
      ...modules.map(row => row.owner_id), ...videoTemplates.map(row => row.owner_user_id), ...tasks.flatMap(row => [row.owner_user_id || row.user_id].filter((id): id is string => Boolean(id)))])),
      batch => prisma.user.findMany({ where: { id: { in: batch } }, select: { id: true, name: true, avatar_url: true } })),
  ]);
  const presetOwners = await readBatches(Array.from(new Set(presets.map(row => row.owner_id))).filter(id => !owners.some(row => row.id === id)),
    batch => prisma.user.findMany({ where: { id: { in: batch } }, select: { id: true, name: true, avatar_url: true } }));
  const hiddenUrls = new Set<string>();
  const allAssetIds = activeAssets.map(asset => asset.id);
  for (let offset = 0; offset < allAssetIds.length; offset += 200) {
    for (const url of await studioHiddenAssetUrls(user, prisma, allAssetIds.slice(offset, offset + 200))) hiddenUrls.add(url);
  }
  return {
    details: false, assets, references: byId(references), modules: byId(modules), presets: byId(presets),
    assetPresets: presets.filter(row => assetPresets.some(item => item.id === row.id)),
    archived: new Set(archived.map(row => row.key)), owners: byId([...owners, ...presetOwners]),
    videoTemplates: byId(videoTemplates), drafts: byId(drafts), legacy: byId(legacy), runs: byId(runs), tasks: byId(tasks), seedance: byId(seedance),
    hiddenUrls, outputAccess: new Map<string, ReturnType<typeof multiviewOutputFileAccess>>(),
    albumAccess,
    templateAccess: new Map<string, ReturnType<typeof getStudioTemplate>>(),
    taskAccess: new Map<string, Promise<void>>(),
  };
}
export type ReactionProjection = Awaited<ReturnType<typeof createReactionProjection>>;
