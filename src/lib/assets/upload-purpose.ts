import { Prisma } from '@prisma/client';

// Compatible rollback keeps original-request reads, but closes new feedback uploads.
export const FEEDBACK_UPLOADS_ENABLED = false;

// Server-owned canonical JSON markers. These affect material discovery only;
// feedback attachment and original-file permissions remain independent.
export const FEEDBACK_ONLY_MARKER = '"feedbackOnly":true';
const MATERIAL_IMPORTED_MARKER = '"materialImported":true';
export const isFeedbackOnlyAsset = (metadata: string | null) => Boolean(metadata?.includes(FEEDBACK_ONLY_MARKER));

// Old plugin uploads had no purpose. Require its fixed upload name, an exact
// owner/URL feedback association, and no other material binding. Never delete.
export async function legacyFeedbackAssetIds(db: Pick<Prisma.TransactionClient, '$queryRaw'>, ownerId?: string) {
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT a.id FROM Asset a
    WHERE a.status = 'active' AND a.file_name IN ('反馈截图.png', '反馈截图.jpg', '反馈截图.webp')
      AND ${ownerId ? Prisma.sql`a.owner_id = ${ownerId}` : Prisma.sql`1 = 1`}
      AND instr(COALESCE(a.metadata_json, ''), ${MATERIAL_IMPORTED_MARKER}) = 0
      AND EXISTS (SELECT 1 FROM Feedback f WHERE f.user_id = a.owner_id
        AND f.pathname IN ('/plugin/chatgpt', '/plugin/midjourney', '/plugin/jimeng')
        AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(f.image_urls_json) THEN f.image_urls_json ELSE '[]' END) j WHERE j.value = a.original_url))
      AND NOT EXISTS (SELECT 1 FROM WorkspaceAsset w WHERE w.asset_id = a.id)
      AND NOT EXISTS (SELECT 1 FROM ReferenceImage r WHERE r.asset_id = a.id)
      AND NOT EXISTS (SELECT 1 FROM AssetCollectionItem i WHERE i.asset_id = a.id)
      AND NOT EXISTS (SELECT 1 FROM AssetCollection c WHERE c.cover_asset_id = a.id)
      AND NOT EXISTS (SELECT 1 FROM ImageStudioTask t WHERE t.asset_id = a.id)`);
  return rows.map(row => row.id);
}

export function materialAssetWhere(legacyIds: string[]): Prisma.AssetWhereInput {
  return { AND: [
    { OR: [{ metadata_json: null }, { NOT: { metadata_json: { contains: FEEDBACK_ONLY_MARKER } } }] },
    ...(legacyIds.length ? [{ id: { notIn: legacyIds } }] : []),
  ] };
}
export const materialAssetSql = (metadata: Prisma.Sql, id: Prisma.Sql, legacyIds: string[]) => Prisma.sql`instr(COALESCE(${metadata}, ''), ${FEEDBACK_ONLY_MARKER}) = 0
  AND ${legacyIds.length ? Prisma.sql`${id} NOT IN (${Prisma.join(legacyIds)})` : Prisma.sql`1 = 1`}`;
