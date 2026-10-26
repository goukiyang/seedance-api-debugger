import { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getTaskWhereForUser } from '@/lib/projects/permissions';
import { creationHttp } from '@/lib/creation/http';
import { assertVideoCreationReady } from '@/lib/creation/context';
import { CreationError } from '@/lib/creation/contract';
import { readCreationSource, creationVersionSummary } from '@/lib/creation/lineage';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  return creationHttp(async user => {
    await assertVideoCreationReady(prisma, false);
    const current = await readCreationSource(prisma, user, params.id), rootId = current.lineage_root_task_id || current.id;
    const limit = Math.min(50, Math.max(1, Number(request.nextUrl.searchParams.get('limit')) || 24));
    let after: { created_at: string; id: string; root: string } | null = null;
    const cursor = request.nextUrl.searchParams.get('cursor');
    if (cursor) {
      try {
        if (cursor.length > 1024) throw new Error();
        after = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        if (!after || after.root !== rootId || typeof after.id !== 'string' || !Number.isFinite(Date.parse(after.created_at))) throw new Error();
      } catch { throw new CreationError('版本页位置已失效，请重新读取', 400); }
    }
    const visible = await getTaskWhereForUser(user, current.project_id, { includeAdminAll: false });
    const where = { AND: [visible, { OR: [{ id: rootId }, { lineage_root_task_id: rootId }] }] };
    const rows = await prisma.videoTask.findMany({ where: { AND: [where, ...(after ? [{ OR: [
      { created_at: { lt: new Date(after.created_at) } }, { created_at: new Date(after.created_at), id: { lt: after.id } },
    ] }] : [])] }, orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: limit + 1 });
    const hasMore = rows.length > limit, page = rows.slice(0, limit), last = page.at(-1);
    const items = await Promise.all(page.map(async task => {
      let parentId: string | null = null, parentUnavailable = false;
      if (task.derived_from_task_id) {
        try { parentId = (await readCreationSource(prisma, user, task.derived_from_task_id)).id; }
        catch { parentUnavailable = true; }
      }
      return { ...creationVersionSummary(task), parentTaskId: parentId, parentUnavailable };
    }));
    const siblingSource = await prisma.canvasVideoBatchChild.findUnique({ where: { task_id: current.id }, select: { batch_id: true } });
    const siblingIds = siblingSource ? await prisma.canvasVideoBatchChild.findMany({ where: { batch_id: siblingSource.batch_id, task_id: { not: null } }, select: { task_id: true } }) : [];
    const siblingRows = siblingIds.length ? await prisma.videoTask.findMany({ where: { AND: [visible, { id: { in: siblingIds.flatMap(child => child.task_id && child.task_id !== current.id ? [child.task_id] : []) } }] } }) : [];
    const sameBatchItems = [];
    for (const task of siblingRows) { try { await readCreationSource(prisma, user, task.id); sameBatchItems.push(creationVersionSummary(task)); } catch { /* Omit unavailable siblings without disclosing count. */ } }
    return { items, sameBatchItems, total: await prisma.videoTask.count({ where }), hasMore,
      nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ root: rootId, id: last.id, created_at: last.created_at.toISOString() })).toString('base64url') : null };
  });
}
