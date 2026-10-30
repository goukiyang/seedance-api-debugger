import { Prisma } from '@prisma/client';

export const catalogIdsSql = (column: Prisma.Sql, ids: string[]) => Prisma.sql`${column} IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`;

/** Keyset batches for the existing catalog domains. Only authorized projections are sorted or spooled. */
export async function* catalogKeyBatches(db: Prisma.TransactionClient, domain: 'templates' | 'picker' | 'library', ownerId: string) {
  const sources = domain === 'templates' ? [
    { table: 'ImageStudioModule', prefix: 'image_module:', where: Prisma.sql`"owner_id" = ${ownerId} AND "id" <> ${'default-' + ownerId}` },
    { table: 'ImageStudioPreset', prefix: 'image_template:', where: Prisma.sql`"owner_id" = ${ownerId} OR "is_shared" = 1 OR EXISTS
      (SELECT 1 FROM "ImageStudioModule" m WHERE m."owner_id" = ${ownerId} AND m."source_preset_id" = "ImageStudioPreset"."id")` },
  ] : [
    { table: 'Asset', prefix: 'asset:', where: Prisma.sql`1 = 1` },
    ...(domain === 'library' ? [{ table: 'MultiviewWork', prefix: 'multiview_work:', where: Prisma.sql`"owner_id" = ${ownerId}` }] : []),
    { table: 'ReferenceImage', prefix: 'reference_image:', where: Prisma.sql`1 = 1` },
    { table: 'VideoTask', prefix: 'video_task:', where: Prisma.sql`1 = 1` },
  ];
  if (domain === 'templates') yield ['image_module:default-' + ownerId];
  for (const source of sources) {
    let cursor = '';
    for (;;) {
      const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM ${Prisma.raw('"' + source.table + '"')}
        WHERE (${source.where}) AND "id" > ${cursor} ORDER BY "id" LIMIT 500`);
      if (rows.length) yield rows.map(row => source.prefix + row.id);
      if (rows.length < 500) break;
      cursor = rows.at(-1)!.id;
    }
  }
}
