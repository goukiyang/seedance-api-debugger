import 'server-only';
import { Prisma } from '@prisma/client';
import type { SessionUser } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { getWorkAccess } from './access';
import { assertWorkViewer } from './operations';
import { WorkError, type WorkActivity } from './types';

const viewWindowMs = 30 * 60_000;
const receiptWork = Prisma.sql`(CASE WHEN json_valid(result_json) THEN json_extract(result_json, '$.workId') END)`;
const successfulMethod = Prisma.sql`(CASE WHEN json_valid(result_json) THEN json_extract(result_json, '$.kind') END) IN ('image-template','video-template')`;

export async function readWorkActivity(db: Prisma.TransactionClient, ids: string[]): Promise<Map<string, WorkActivity>> {
  if (!ids.length) return new Map();
  const keys = Prisma.join(ids);
  const rows = await db.$queryRaw<Array<{ work_id: string; views: bigint; reuses: bigint }>>(Prisma.sql`
    SELECT work_id, sum(views) AS views, sum(reuses) AS reuses FROM (
      SELECT work_id, sum(count) AS views, 0 AS reuses FROM WorkView WHERE work_id IN (${keys}) GROUP BY work_id
      UNION ALL
      SELECT ${receiptWork} AS work_id, 0, count(*) FROM WorkOperation
      WHERE ${successfulMethod} AND ${receiptWork} IN (${keys}) GROUP BY ${receiptWork}
    ) GROUP BY work_id`);
  return new Map(rows.map(row => [row.work_id, { views: Number(row.views), reuses: Number(row.reuses) }]));
}

export async function recordWorkView(user: SessionUser, id: string, input: Record<string, unknown>, db: Prisma.TransactionClient = prisma) {
  assertWorkViewer(user, input.viewerId);
  if (typeof input.mediaVersion !== 'string') throw new WorkError('作品版本无效');
  const access = await getWorkAccess(user, id, db);
  if (!access?.canPreview || !access.work.discoverable || access.media.id !== input.mediaVersion)
    throw new WorkError('作品不可查看或已换版', 404, 'WORKS_NOT_FOUND');
  const now = Date.now();
  // The request is a best-effort activity write, outside detail, media and generation requests.
  await db.$executeRaw(Prisma.sql`
    INSERT INTO WorkView(work_id,viewer_id,count,last_viewed_ms)
    SELECT id,${user.id},1,${now} FROM Work WHERE id=${id} AND current_version_id=${access.media.id}
      AND revision=${access.work.revision} AND discoverable=1 AND withdrawn_at IS NULL
    ON CONFLICT(work_id,viewer_id) DO UPDATE SET count=WorkView.count+1,last_viewed_ms=excluded.last_viewed_ms
    WHERE WorkView.last_viewed_ms <= ${now - viewWindowMs}`);
  return (await readWorkActivity(db, [id])).get(id) || { views: 0, reuses: 0 };
}
