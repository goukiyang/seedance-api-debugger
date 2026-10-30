import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { studioTaskStates } from './pricing-state';
import { IMAGE_FEISHU_TYPE } from './feishu-contract';

type Cursor = { version: 1; owner: string; module: string | null; at: number; id: string; ceiling: number };
export async function activeStudioTaskPage(owner: string, module?: string, after?: string) {
  let cursor: Cursor | null = null;
  if (after) {
    try {
      if (after.length > 1500) throw new Error();
      cursor = JSON.parse(Buffer.from(after, 'base64url').toString());
      if (!cursor || cursor.version !== 1 || cursor.owner !== owner || cursor.module !== (module || null)
        || !Number.isSafeInteger(cursor.at) || !Number.isSafeInteger(cursor.ceiling) || cursor.at > cursor.ceiling
        || typeof cursor.id !== 'string' || cursor.id.length > 160) throw new Error();
    } catch { throw new Error('invalid_active_task_cursor'); }
  }
  const ceiling = cursor?.ceiling ?? Date.now();
  const scope = module ? module === `default-${owner}`
    ? Prisma.sql`(t."module_id" = ${module} OR t."module_id" IS NULL) AND (t."snapshot_json" IS NULL OR
      instr(t."snapshot_json", '"avatar":') = 0 AND instr(t."snapshot_json", '"avatarLayout":') = 0)` : Prisma.sql`t."module_id" = ${module}` : Prisma.sql`1 = 1`;
  const states = studioTaskStates(['queued', 'running', 'channel_queued', 'channel_running']);
  const rows = await prisma.$queryRaw<Array<{ id: string; created_at: bigint | number }>>(Prisma.sql`SELECT t."id", t."created_at"
    FROM "ImageStudioTask" t WHERE t."owner_id" = ${owner} AND t."deleted_at" IS NULL AND ${scope}
    AND t."created_at" <= ${ceiling}
    AND (${cursor ? Prisma.sql`(t."created_at" > ${cursor.at} OR t."created_at" = ${cursor.at} AND t."id" > ${cursor.id})` : Prisma.sql`1 = 1`})
    AND (t."status" IN (${Prisma.join(states)}) OR t."billing_next_check_at" IS NOT NULL
      OR EXISTS (SELECT 1 FROM "Notification" n WHERE n."type" = ${IMAGE_FEISHU_TYPE} AND n."target_user_id" = ${owner}
        AND n."status" = 'pending' AND json_extract(CASE WHEN json_valid(n."metadata_json") THEN n."metadata_json" ELSE '{}' END, '$.taskId') = t."id"))
    ORDER BY t."created_at" ASC, t."id" ASC LIMIT 25`);
  const page = rows.slice(0, 24), last = page.at(-1);
  const next: Cursor | null = rows.length > 24 && last ? { version: 1, owner, module: module || null,
    at: Number(last.created_at), id: last.id, ceiling } : null;
  return { ids: page.map(row => row.id), nextCursor: next ? Buffer.from(JSON.stringify(next)).toString('base64url') : null };
}
