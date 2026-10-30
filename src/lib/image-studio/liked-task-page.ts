import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { studioTaskStates } from './pricing-state';

/** Correlated filtering keeps the viewer's all-history reactions in SQLite. */
export async function likedStudioTaskPage(db: Pick<PrismaClient, '$queryRaw' | 'imageStudioTask'>,
  owner: string, module: string, cursor: string | undefined, limit: number, excluded: string[] = [], ownAssets = false) {
  const scope = module === `default-${owner}` ? Prisma.sql`(t."module_id" = ${module} OR t."module_id" IS NULL)
    AND (t."snapshot_json" IS NULL OR instr(t."snapshot_json", '"avatar":') = 0 AND instr(t."snapshot_json", '"avatarLayout":') = 0)`
    : Prisma.sql`t."module_id" = ${module}`;
  const where = Prisma.sql`t."owner_id" = ${owner} AND t."deleted_at" IS NULL AND ${scope}
    AND (${excluded.length ? Prisma.sql`t."id" NOT IN (${Prisma.join(excluded)})` : Prisma.sql`1 = 1`})
    AND (t."status" = 'succeeded' OR t."status" IN (${Prisma.join(studioTaskStates(['failed', 'uncertain']))})
      AND t."asset_id" IS NOT NULL AND (instr(t."usage_json", '"generated_dimensions_mismatch"') > 0 OR instr(t."usage_json", '"generated_format_mismatch"') > 0))
    AND EXISTS (SELECT 1 FROM "Asset" a JOIN "ContentReaction" r ON r."content_key" = 'asset:' || a."id"
      WHERE a."id" = t."asset_id" AND a."status" = 'active' AND r."user_id" = ${owner} AND (r."liked" = 1 OR r."favorited" = 1)
      AND (${ownAssets ? Prisma.sql`a."owner_id" = ${owner}` : Prisma.sql`1 = 1`}))`;
  const anchor = cursor ? await db.$queryRaw<Array<{ id: string; created_at: Date | bigint | number }>>(Prisma.sql`
    SELECT t."id", t."created_at" FROM "ImageStudioTask" t WHERE ${where} AND t."id" = ${cursor} LIMIT 1`) : [];
  if (cursor && !anchor.length) return { valid: false, total: 0, rows: [] };
  const counts = await db.$queryRaw<Array<{ total: bigint | number }>>(Prisma.sql`SELECT COUNT(*) AS total FROM "ImageStudioTask" t WHERE ${where}`);
  const at = anchor[0]?.created_at;
  const rows = limit ? await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT t."id" FROM "ImageStudioTask" t WHERE ${where}
    AND (${at !== undefined ? Prisma.sql`(t."created_at" < ${at} OR t."created_at" = ${at} AND t."id" < ${cursor!})` : Prisma.sql`1 = 1`})
    ORDER BY t."created_at" DESC, t."id" DESC LIMIT ${limit}`) : [];
  const details = rows.length ? await db.imageStudioTask.findMany({ where: { id: { in: rows.map(row => row.id) }, owner_id: owner, deleted_at: null } }) : [];
  const byId = new Map(details.map(row => [row.id, row]));
  return { valid: true, total: Number(counts[0]?.total || 0), rows: rows.flatMap(row => byId.has(row.id) ? [byId.get(row.id)!] : []) };
}
