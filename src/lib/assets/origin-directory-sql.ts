import { Prisma } from '@prisma/client';
import type { SessionUser } from '@/lib/auth/session';
import { canUseCompanyTemplates } from '@/lib/image-studio/access';
import { studioViewableOutputSql } from '@/lib/image-studio/output-task-sql';
import { jsonField } from './directory-permissions-sql';
import { catalogIdsSql } from './catalog-batches';

/** The same one-provable-task rule as generationOrigins, reduced to filter columns. */
export function originDirectorySql(user: SessionUser, assetIds?: string[]) {
  const snapshot = Prisma.sql`t."snapshot_json"`, metadata = Prisma.sql`a."metadata_json"`;
  const presetId = Prisma.sql`COALESCE(NULLIF(t."source_preset_id", ''), CASE WHEN json_type(CASE WHEN json_valid(t."snapshot_json") THEN t."snapshot_json" ELSE '{}' END, '$.sourcePresetId') = 'text'
    THEN NULLIF(${jsonField(snapshot, '$.sourcePresetId')}, '') ELSE NULL END, NULLIF(w."source_preset_id", ''))`;
  const visible = Prisma.sql`${canUseCompanyTemplates(user) ? 1 : 0} = 1 AND (p."owner_id" = ${user.id} OR p."scope" IN ('admin', 'creator') AND p."is_shared" = 1)
    AND NOT EXISTS (SELECT 1 FROM "PlatformSetting" archived WHERE archived."key" = 'studio_preset_archived_v1:' || p."id")`;
  return Prisma.sql`origin_task_links AS MATERIALIZED (
    SELECT a."id" AS asset_id, t."id" AS task_id FROM "ImageStudioTask" t CROSS JOIN "Asset" a
      WHERE a."id" = t."asset_id" AND (${assetIds ? catalogIdsSql(Prisma.sql`a."id"`, assetIds) : Prisma.sql`1 = 1`}) AND t."owner_id" = a."owner_id" AND t."deleted_at" IS NULL AND ${studioViewableOutputSql('t')}
    UNION SELECT a."id", t."id" FROM "Asset" a JOIN "ImageStudioTask" t ON t."id" = ${jsonField(metadata, '$.studioTaskId')}
      WHERE json_type(CASE WHEN json_valid(a."metadata_json") THEN a."metadata_json" ELSE '{}' END, '$.studioTaskId') = 'text'
        AND (${assetIds ? catalogIdsSql(Prisma.sql`a."id"`, assetIds) : Prisma.sql`1 = 1`})
        AND t."owner_id" = a."owner_id" AND t."deleted_at" IS NULL AND ${studioViewableOutputSql('t')}
  ), unique_origin_tasks AS MATERIALIZED (
    SELECT asset_id, min(task_id) AS task_id FROM origin_task_links GROUP BY asset_id HAVING count(DISTINCT task_id) = 1
  ), owned_generated_assets AS MATERIALIZED (
    SELECT DISTINCT generated."asset_id" FROM "ImageStudioTask" generated WHERE generated."owner_id" = ${user.id} AND ${studioViewableOutputSql('generated')}
      AND (${assetIds ? catalogIdsSql(Prisma.sql`generated."asset_id"`, assetIds) : Prisma.sql`1 = 1`})
  ), asset_origins AS MATERIALIZED (
    SELECT a."id" AS asset_id,
      CASE WHEN ${jsonField(metadata, '$.multiviewOutput.schema')} = 1 THEN 'multiview-output'
        WHEN t."id" IS NULL OR NOT json_valid(t."snapshot_json") OR json_type(t."snapshot_json") <> 'object' THEN NULL
        WHEN json_type(t."snapshot_json", '$.avatar') IS NOT NULL THEN CASE WHEN json_type(t."snapshot_json", '$.avatar') = 'object' THEN 'random-person' ELSE NULL END
        WHEN ${presetId} IS NOT NULL OR NULLIF(t."module_id", '') IS NOT NULL THEN 'template-image' ELSE 'other-generated' END AS origin_kind,
      CASE WHEN COALESCE(${jsonField(metadata, '$.multiviewOutput.schema')}, 0) <> 1 AND json_valid(t."snapshot_json") AND json_type(t."snapshot_json") = 'object' AND json_type(t."snapshot_json", '$.avatar') IS NULL
        THEN CASE WHEN ${presetId} IS NOT NULL AND ${visible} THEN p."id" ELSE w."id" END ELSE NULL END AS template_id,
      CASE WHEN COALESCE(${jsonField(metadata, '$.multiviewOutput.schema')}, 0) <> 1 AND json_valid(t."snapshot_json") AND json_type(t."snapshot_json") = 'object' AND json_type(t."snapshot_json", '$.avatar') IS NULL
        THEN CASE WHEN ${presetId} IS NOT NULL AND ${visible} THEN p."name" ELSE w."name" END ELSE NULL END AS template_name,
      CASE WHEN COALESCE(${jsonField(metadata, '$.multiviewOutput.schema')}, 0) <> 1 AND json_valid(t."snapshot_json") AND json_type(t."snapshot_json") = 'object'
        AND json_type(t."snapshot_json", '$.avatar') IS NULL AND ${visible} AND w."source_preset_id" = p."id" THEN w."id" ELSE NULL END AS template_alias,
      CASE WHEN ${jsonField(metadata, '$.multiviewOutput.schema')} = 1 OR t."id" IS NOT NULL AND json_valid(t."snapshot_json") AND json_type(t."snapshot_json") = 'object'
          AND (json_type(t."snapshot_json", '$.avatar') IS NULL OR json_type(t."snapshot_json", '$.avatar') = 'object')
        OR json_type(CASE WHEN json_valid(a."metadata_json") THEN a."metadata_json" ELSE '{}' END, '$.studioTaskId') = 'text'
        OR ${jsonField(metadata, '$.source')} IN ('image_generation_api', 'workspace_generation')
        OR owned_generated."asset_id" IS NOT NULL
        THEN 1 ELSE 0 END AS generated
    FROM "Asset" a LEFT JOIN unique_origin_tasks linked ON linked.asset_id = a."id" LEFT JOIN "ImageStudioTask" t ON t."id" = linked.task_id
      LEFT JOIN owned_generated_assets owned_generated ON owned_generated."asset_id" = a."id"
      LEFT JOIN "ImageStudioModule" w ON w."id" = t."module_id" AND w."owner_id" = ${user.id} AND w."owner_id" = t."owner_id"
      LEFT JOIN "ImageStudioPreset" p ON p."id" = ${presetId}
    WHERE ${assetIds ? catalogIdsSql(Prisma.sql`a."id"`, assetIds) : Prisma.sql`1 = 1`}
  )`;
}
