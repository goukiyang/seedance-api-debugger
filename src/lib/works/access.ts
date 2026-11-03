import 'server-only';
import { Prisma, type Work, type WorkMediaVersion } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { SessionUser } from '@/lib/auth/session';
import { directoryPermissionsSql, jsonField, validJson } from '@/lib/assets/directory-permissions-sql';
import { canUseCompanyTemplates } from '@/lib/image-studio/access';
import { studioViewableOutputSql } from '@/lib/image-studio/output-task-sql';
import { WorkError } from './types';

export type WorkAccess = {
  work: Work; media: WorkMediaVersion; canPreview: boolean; canDownload: boolean;
  nativePreview: boolean; reuse: { assetId?: string; referenceImageId?: string } | null;
};
export type WorkPermissionRow = { id: string; media_id: string; work_revision: number; can_preview: bigint | number; can_download: bigint | number;
  native_preview: bigint | number; can_reuse: bigint | number; reference_id: string | null };

/** One current source/permission predicate is used before paging and again at every media/action boundary. */
export async function workAccessSql(db: Prisma.TransactionClient, session: SessionUser) {
  const permission = await directoryPermissionsSql(db, session);
  const user = permission.user;
  const owner = Prisma.sql`w.author_id = ${user.id}`;
  const internalAdmin = user.role === 'admin' && user.account_type === 'internal' ? 1 : 0;
  const assetOwner = Prisma.sql`a.owner_id = ${user.id} OR ${user.role === 'admin' ? 1 : 0} = 1`;
  const album = (capability: 'view' | 'download' | 'use') => Prisma.sql`EXISTS (
    SELECT 1 FROM ReferenceImage ri JOIN authorized_albums aa ON aa.id = ri.album_id
    WHERE ri.asset_id = a.id AND ri.status = 'active' AND aa.${Prisma.raw('can_' + capability)} = 1)`;
  const referenceId = Prisma.sql`(SELECT ri.id FROM ReferenceImage ri JOIN authorized_albums aa ON aa.id = ri.album_id
    WHERE ri.asset_id = a.id AND ri.status = 'active' AND aa.can_use = 1 ORDER BY ri.id LIMIT 1)`;
  const pinIndex = Prisma.sql`CASE WHEN json_valid(pin_index.value_json) THEN pin_index.value_json ELSE '{}' END`;
  const pinDocument = Prisma.sql`CASE WHEN json_valid(pin_document.value_json) THEN pin_document.value_json ELSE '{}' END`;
  const pinned = canUseCompanyTemplates(user) ? Prisma.sql`EXISTS (
    SELECT 1 FROM PlatformSetting pin_index
    JOIN ImageStudioPreset preset ON preset.id = json_extract(${pinIndex}, '$.presetId')
    JOIN PlatformSetting pin_document ON pin_document.key = 'studio_result_pins_v1:' || preset.id
    JOIN json_each(${pinDocument}, '$.pins') pin
    WHERE pin_index.key = 'studio_result_pin_asset_v1:' || a.id AND json_extract(${pinIndex}, '$.version') = 1
      AND preset.is_shared = 1 AND (preset.owner_id = ${user.id} OR preset.scope IN ('admin','creator'))
      AND NOT EXISTS (SELECT 1 FROM PlatformSetting archived WHERE archived.key = 'studio_preset_archived_v1:' || preset.id)
      AND json_extract(${pinDocument}, '$.version') = 1 AND json_extract(${pinDocument}, '$.presetId') = preset.id
      AND json_extract(pin.value, '$.assetId') = a.id AND json_extract(pin.value, '$.taskId') = image_source.id
      AND json_extract(pin.value, '$.ownerId') = w.author_id AND json_extract(pin.value, '$.moduleId') = image_source.module_id
      AND (image_source.source_preset_id IS NULL OR image_source.source_preset_id = preset.id))` : Prisma.sql`0 = 1`;
  const nativeAssetView = Prisma.sql`(${assetOwner} OR ${album('view')})`;
  const nativeAssetDownload = Prisma.sql`(${assetOwner} OR ${album('download')})`;
  const nativeAssetUse = Prisma.sql`(${assetOwner} OR ${album('use')})`;
  const nativeVideo = Prisma.sql`(${user.role === 'admin' ? 1 : 0} = 1 OR
    (video_source.project_id IS NOT NULL AND ${permission.projectView(Prisma.sql`video_source.project_id`)}) OR
    (video_source.project_id IS NULL AND ${owner}))`;
  const nativePreview = Prisma.sql`CASE WHEN w.source_kind = 'video_task' THEN ${nativeVideo}
    WHEN w.source_kind = 'multiview_work' THEN (${owner} OR ${internalAdmin} = 1 OR ${album('view')})
    ELSE (${nativeAssetView} OR (w.source_kind = 'image_task' AND ${pinned})) END`;
  const nativeDownload = Prisma.sql`CASE WHEN w.source_kind = 'video_task' THEN ${nativeVideo}
    WHEN w.source_kind = 'multiview_work' THEN (${owner} OR ${internalAdmin} = 1 OR ${album('download')}) ELSE ${nativeAssetDownload} END`;
  const nativeUse = Prisma.sql`w.medium = 'image' AND ${user.account_type === 'internal' ? 1 : 0} = 1
    AND CASE WHEN w.source_kind = 'multiview_work' THEN (${owner} OR ${internalAdmin} = 1 OR ${album('use')}) ELSE ${nativeAssetUse} END`;
  const validAsset = Prisma.sql`a.id = v.asset_id AND a.owner_id = w.author_id AND a.status = 'active'
    AND a.original_url = v.source_url AND (v.content_hash IS NULL OR a.hash = v.content_hash)
    AND ${permission.visibility.visible(Prisma.sql`a.original_url`)}
    AND (a.thumbnail_url IS NULL OR ${permission.visibility.visible(Prisma.sql`a.thumbnail_url`)})`;
  const currentVideoUrl = Prisma.sql`CASE WHEN video_source.local_video_path IS NOT NULL AND video_source.local_video_path <> ''
    THEN video_source.local_video_path ELSE video_source.public_video_url END`;
  const sourceFresh = Prisma.sql`CASE
    WHEN w.source_kind = 'image_task' THEN ${validAsset} AND a.type = 'image'
      AND image_source.owner_id = w.author_id AND image_source.asset_id = a.id AND image_source.deleted_at IS NULL
      AND ${studioViewableOutputSql('image_source')}
      AND (SELECT project_id FROM UsageAttribution WHERE source_kind = 'image_task' AND source_id = image_source.id) IS w.project_id
    WHEN w.source_kind = 'video_task' THEN video_source.id = v.video_task_id AND video_source.local_status = 'succeeded'
      AND video_source.retention_status IN ('active','retained') AND COALESCE(video_source.owner_user_id,video_source.user_id) = w.author_id
      AND video_source.project_id IS w.project_id AND ${currentVideoUrl} = v.source_url
      AND COALESCE(video_source.public_video_cached_at,video_source.delivery_completed_at) = v.source_updated_at
      AND (video_source.local_video_path IS NOT NULL OR (video_source.public_video_storage_provider IN ('r2','tos','local-public')
        AND video_source.public_video_cached_at IS NOT NULL AND video_source.public_video_file_size > 0))
    WHEN w.source_kind = 'multiview_work' THEN ${validAsset} AND multiview_source.owner_id = w.author_id
      AND multiview_source.project_id IS w.project_id AND multiview_source.status = 'ready' AND multiview_source.save_state <> 'intent'
      AND multiview_source.removed_at IS NULL AND CAST(multiview_source.ready_revision AS TEXT) = v.source_revision
      AND EXISTS (SELECT 1 FROM PlatformSetting mr, json_each(${validJson(Prisma.sql`mr.value_json`)}, '$.outputs') mo
        WHERE mr.key = 'multiview_output_registration_v1:receipt:' || w.source_id || ':' || v.source_revision
          AND ${jsonField(Prisma.sql`mr.value_json`, '$.state')} = 'registered'
          AND json_extract(mo.value, '$.state') = 'registered' AND json_extract(mo.value, '$.role') = w.output_role
          AND json_extract(mo.value, '$.assetId') = v.asset_id AND json_extract(mo.value, '$.sha256') = v.content_hash)
    WHEN w.source_kind = 'upload_asset' THEN ${validAsset} AND a.id = w.source_id AND a.type IN ('image','video')
    ELSE 0 END`;
  const frozen = Prisma.sql`policy.id = v.policy_id AND policy.source_kind = w.source_kind AND policy.source_id = w.source_id
    AND policy.owner_id = w.author_id AND policy.project_id IS w.project_id AND policy.audience = w.audience
    AND policy.operation_id = CASE WHEN w.source_kind = 'multiview_work' THEN v.source_revision ELSE 'initial' END`;
  // A frozen grant can narrow with the current project, but a current wider label cannot enlarge the frozen audience.
  const internal = canUseCompanyTemplates(user) ? 1 : 0;
  const frozenGrant = Prisma.sql`CASE w.audience WHEN 'team' THEN ${internal} = 1
    WHEN 'project' THEN ${permission.projectView(Prisma.sql`w.project_id`)} WHEN 'private' THEN ${owner} ELSE ${nativePreview} END`;
  const currentCeiling = Prisma.sql`CASE WHEN project_source.type = 'personal' THEN ${owner}
    WHEN project_source.type = 'team' AND project_source.work_audience = 'team' THEN (${internal} = 1 OR ${nativePreview})
    WHEN project_source.type = 'team' AND project_source.work_audience = 'project' THEN ${permission.projectView(Prisma.sql`w.project_id`)}
    WHEN project_source.work_audience = 'private' THEN ${owner} ELSE ${nativePreview} END`;
  const audience = Prisma.sql`CASE WHEN w.audience <> 'source' AND (${frozen})
    THEN (${owner} OR (${frozenGrant} AND ${currentCeiling})) ELSE (${nativePreview} AND ${currentCeiling}) END`;
  const projectActive = Prisma.sql`w.project_id IS NULL OR (project_source.id = w.project_id AND project_source.status <> 'deleted')`;
  const canPreview = Prisma.sql`(${sourceFresh}) AND (${projectActive}) AND w.withdrawn_at IS NULL AND (${audience})`;
  const canDownload = Prisma.sql`(${canPreview}) AND (${nativeDownload})`;
  const canReuse = Prisma.sql`(${canPreview}) AND (${nativeUse})`;
  const joins = Prisma.sql`JOIN WorkMediaVersion v ON v.id = w.current_version_id AND v.work_id = w.id
    LEFT JOIN Asset a ON a.id = v.asset_id
    LEFT JOIN ImageStudioTask image_source ON w.source_kind = 'image_task' AND image_source.id = w.source_id
    LEFT JOIN VideoTask video_source ON w.source_kind = 'video_task' AND video_source.id = w.source_id
    LEFT JOIN MultiviewWork multiview_source ON w.source_kind = 'multiview_work' AND multiview_source.id = w.source_id
    LEFT JOIN Project project_source ON project_source.id = w.project_id
    LEFT JOIN WorkSourcePolicy policy ON policy.id = v.policy_id`;
  return { user, ctes: permission.ctes, joins, sourceFresh, canPreview, canDownload, canReuse, nativePreview,
    referenceId, owner, projectView: permission.projectView };
}

export async function getWorkAccess(user: SessionUser, id: string, db: Prisma.TransactionClient = prisma, includeManaged = false): Promise<WorkAccess | null> {
  const sql = await workAccessSql(db, user);
  const rows = await db.$queryRaw<WorkPermissionRow[]>(Prisma.sql`WITH ${sql.ctes}
    SELECT w.id, v.id AS media_id, w.revision AS work_revision, (${sql.canPreview}) AS can_preview, (${sql.canDownload}) AS can_download,
      (${sql.nativePreview}) AS native_preview, (${sql.canReuse}) AS can_reuse, ${sql.referenceId} AS reference_id
    FROM Work w ${sql.joins} WHERE w.id = ${id} AND ((${sql.canPreview}) ${includeManaged ? Prisma.sql`OR ${sql.owner}` : Prisma.empty}) LIMIT 1`);
  const row = rows[0];
  if (!row) return null;
  const work = await db.work.findUnique({ where: { id } });
  if (!work?.current_version_id) return null;
  if (work.current_version_id !== row.media_id || work.revision !== Number(row.work_revision)) throw new WorkError('作品版本已变化，请重新打开当前成品', 409, 'WORKS_VERSION_CHANGED');
  const media = await db.workMediaVersion.findUnique({ where: { id: work.current_version_id } });
  if (!media || media.work_id !== work.id) return null;
  return { work, media, canPreview: Boolean(row.can_preview), canDownload: Boolean(row.can_download), nativePreview: Boolean(row.native_preview),
    reuse: row.can_reuse ? row.reference_id ? { referenceImageId: row.reference_id } : media.asset_id ? { assetId: media.asset_id } : null : null };
}
