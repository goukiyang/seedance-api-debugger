import { Prisma } from '@prisma/client';
import type { SessionUser } from '@/lib/auth/session';
import type { UsageFact } from '@/lib/admin/usage-types';
import type { PublicUsageScope, UsageRecordDTO } from './dto';
import { canUseCompanyTemplates } from '@/lib/image-studio/access';
import { studioAssetUrl } from '@/lib/image-studio/media';
import { getProjectAccess } from '@/lib/projects/permissions';
import { isTaskHiddenFromRegularUsers } from '@/lib/tasks/retention';
import { isSafeTaskId } from '@/lib/video/thumbnail';
import { taskThumbnailProjection } from '@/lib/video/task-thumbnail-projection';

export interface UsageMediaProjection { available: number | null; media?: UsageRecordDTO['media'] }

/** No task DTO/raw snapshot or signed URL is needed to reuse the original asset route. */
export async function readUsageMedia(db: Prisma.TransactionClient, user: SessionUser, facts: UsageFact[], scope: PublicUsageScope) {
  const result = new Map<string, UsageMediaProjection>();
  if (scope.viewerId !== user.id || (scope.kind !== 'self' && scope.kind !== 'project')) return result;
  const scopedFacts = facts.filter(fact => scope.kind === 'self' ? fact.ownerUserId === user.id
    : fact.projectId === scope.projectId && (!scope.memberOwnerId || fact.ownerUserId === scope.memberOwnerId));
  const videos = scopedFacts.filter(fact => fact.sourceKind === 'video_task' && fact.leaf && isSafeTaskId(fact.sourceId));
  const videoIds = Array.from(new Set(videos.map(fact => fact.sourceId)));
  const projectAccess = new Map<string, boolean>();
  for (let offset = 0; offset < videoIds.length; offset += 500) {
    const tasks = await db.videoTask.findMany({ where: { id: { in: videoIds.slice(offset, offset + 500) } }, take: 500,
      select: { id: true, project_id: true, owner_user_id: true, user_id: true, retention_status: true,
        local_status: true, public_video_url: true, local_video_path: true, result_video_url: true,
        result_last_frame_url: true, delivery_status: true } });
    for (const task of tasks) {
      // Billing visibility never grants media access, even for an admin's self report.
      if (isTaskHiddenFromRegularUsers(task)) continue;
      const ownerId = task.owner_user_id || task.user_id;
      if (scope.kind === 'self' && ownerId !== user.id) continue;
      if (task.project_id) {
        if (!projectAccess.has(task.project_id)) {
          const access = await getProjectAccess(user, task.project_id, db);
          projectAccess.set(task.project_id, Boolean(access.project && access.canView));
        }
        if (!projectAccess.get(task.project_id)) continue;
      } else if (user.role !== 'admin' && ownerId !== user.id) continue;
      const projection = taskThumbnailProjection(task);
      const media: NonNullable<UsageRecordDTO['media']> = {
        ...(projection.thumbnail_url ? { thumbnailUrl: projection.thumbnail_url } : {}),
        ...(projection.play_url ? { videoUrl: projection.play_url } : {}),
        ...(projection.download_url ? { downloadUrl: projection.download_url } : {}),
      };
      result.set(`video_task:${task.id}`, {
        available: projection.playable_available ? 1 : null,
        ...(Object.keys(media).length ? { media } : {}),
      });
    }
  }
  if (!canUseCompanyTemplates(user)) return result;
  const ids = scopedFacts.filter(fact => fact.sourceKind === 'image_task' && fact.currentOwnerUserId === user.id
    && fact.retentionStatus === 'active' && fact.outputCount > 0).map(fact => fact.sourceId);
  if (!ids.length) return result;
  // Reduce private protection definitions to a boolean in SQLite. No reference
  // notes, prompt snapshots or original file paths leave this permission query.
  const corrupt = user.role === 'admin' ? [] : await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "PlatformSetting"
    WHERE ("key" GLOB 'studio_fixed_references_v1:*' OR "key" GLOB 'studio_style_group_v1:*' OR "key" GLOB 'studio_shared_reproduction_v1:*')
    AND CASE WHEN json_valid("value_json") THEN
      CASE WHEN "key" GLOB 'studio_shared_reproduction_v1:*' THEN
        json_type("value_json", '$.sourceOwnerId') IS NOT 'text' OR json_type("value_json", '$.templateFixedReferences') IS NOT 'array'
        OR EXISTS (SELECT 1 FROM json_each("value_json", '$.templateFixedReferences') r WHERE json_type(r.value, '$.assetId') IS NOT 'text')
      ELSE json_type("value_json", '$.ownerId') IS NOT 'text' OR json_type("value_json", '$.references') IS NOT 'array'
        OR EXISTS (SELECT 1 FROM json_each("value_json", '$.references') r WHERE json_type(r.value, '$.assetId') IS NOT 'text') END
    ELSE 1 END LIMIT 1`);
  if (corrupt.length) return result;
  for (let offset = 0; offset < ids.length; offset += 500) {
    const page = ids.slice(offset, offset + 500);
    const allowed = user.role === 'admin' ? Prisma.sql`1 = 1` : Prisma.sql`NOT EXISTS (
      SELECT 1 FROM "PlatformSetting" p,
        json_each(CASE WHEN json_valid(p."value_json") THEN p."value_json" ELSE '{}' END,
          CASE WHEN p."key" GLOB 'studio_shared_reproduction_v1:*' THEN '$.templateFixedReferences' ELSE '$.references' END) r
        JOIN "Asset" protected ON protected."id" = json_extract(r.value, '$.assetId')
      WHERE (p."key" GLOB 'studio_fixed_references_v1:*' OR p."key" GLOB 'studio_style_group_v1:*' OR p."key" GLOB 'studio_shared_reproduction_v1:*')
        AND (p."key" NOT GLOB 'studio_style_group_v1:*' OR json_extract(p."value_json", '$.ownerId') <> ${user.id}
          AND NOT EXISTS (SELECT 1 FROM "PlatformSetting" owned,
            json_each(CASE WHEN json_valid(owned."value_json") THEN owned."value_json" ELSE '{}' END, '$.references') ownref
            WHERE owned."key" GLOB 'studio_style_group_v1:*' AND json_extract(owned."value_json", '$.ownerId') = ${user.id}
              AND json_extract(ownref.value, '$.assetId') = json_extract(r.value, '$.assetId')))
        AND (protected."original_url" = a."original_url" OR protected."thumbnail_url" = a."original_url"
          OR instr(protected."original_url", '/uploads/') > 0 AND instr(a."original_url", '/uploads/') > 0
            AND substr(protected."original_url", instr(protected."original_url", '/uploads/')) = substr(a."original_url", instr(a."original_url", '/uploads/'))
          OR instr(protected."thumbnail_url", '/uploads/') > 0 AND instr(a."original_url", '/uploads/') > 0
            AND substr(protected."thumbnail_url", instr(protected."thumbnail_url", '/uploads/')) = substr(a."original_url", instr(a."original_url", '/uploads/'))))`;
    const assets = await db.$queryRaw<Array<{ id: string; asset_id: string }>>(Prisma.sql`SELECT t."id", t."asset_id" FROM "ImageStudioTask" t
      JOIN "Asset" a ON a."id" = t."asset_id" AND a."owner_id" = ${user.id} AND a."status" = 'active' AND a."type" = 'image'
      WHERE t."id" IN (${Prisma.join(page)}) AND t."owner_id" = ${user.id} AND t."deleted_at" IS NULL AND ${allowed} LIMIT 500`);
    for (const asset of assets) result.set(`image_task:${asset.id}`, { available: 1, media: {
      thumbnailUrl: studioAssetUrl(asset.asset_id, true), imageUrl: studioAssetUrl(asset.asset_id),
      downloadUrl: `${studioAssetUrl(asset.asset_id)}?download=1`,
    } });
  }
  return result;
}
