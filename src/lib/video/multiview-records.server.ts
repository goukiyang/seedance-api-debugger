import { createHash } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { AuthError, type SessionUser } from '@/lib/auth/session';
import { USER_VISIBLE_TASK_RETENTION_STATUSES } from '@/lib/tasks/retention';
import { privateMultiviewTaskWhere } from './multiview-task-privacy';
import { currentMultiviewActor, assertMultiviewWorkReference, MultiviewWorkError } from './multiview-works';

export type MultiviewRecord = { id: string; taskId: string; sourceId: string | null; workId: string | null; sourceVersion: string | null;
  title: string; status: string; createdAt: string; projectId: string | null; projectTitle: string | null; schemeCount: number; removed: boolean; coverUrl: string | null };
export async function listMultiviewRecords(user: SessionUser, input: { q: string; projectId: string; removed: boolean; cursor: string | null }) {
  await currentMultiviewActor(user);
  if (input.q.length > 120 || input.projectId.length > 100 || (input.cursor?.length || 0) > 512) throw new MultiviewWorkError('记录筛选无效。');
  const groups = new Map<string, MultiviewRecord>();
  const titles = new Map<string, string[]>();
  const projects = new Map<string, string>();
  if (!input.removed) {
    let after: string | undefined;
    do {
      const tasks = await prisma.videoTask.findMany({ where: { AND: [privateMultiviewTaskWhere(),
        { OR: [{ owner_user_id: user.id }, { owner_user_id: null, user_id: user.id }] },
        { retention_status: { in: [...USER_VISIBLE_TASK_RETENTION_STATUSES] } }] }, orderBy: { id: 'asc' }, take: 128,
        ...(after ? { cursor: { id: after }, skip: 1 } : {}),
        select: { id: true, created_at: true, local_status: true, project_id: true, project: { select: { name: true } } } });
      for (const task of tasks) {
        const id = `task:${task.id}`;
        groups.set(id, { id, taskId: task.id, sourceId: null, workId: null, sourceVersion: null,
          title: '3D多视图', status: task.local_status, createdAt: task.created_at.toISOString(), projectId: task.project_id,
          projectTitle: task.project?.name || null, schemeCount: 0, removed: false,
          coverUrl: `/api/video/multiview/records/${encodeURIComponent(task.id)}/cover` });
        if (task.project_id && task.project) projects.set(task.project_id, task.project.name);
      }
      after = tasks.length === 128 ? tasks[tasks.length - 1].id : undefined;
    } while (after);
  }
  let after: string | undefined;
  do {
    const rows = await prisma.multiviewWork.findMany({ where: { owner_id: user.id, save_state: { not: 'intent' }, removed_at: input.removed ? { not: null } : null },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: 128, ...(after ? { cursor: { id: after }, skip: 1 } : {}),
      select: { id: true, owner_id: true, source_task_id: true, source_id: true, source_version: true, title: true, created_at: true, project_id: true, status: true } });
    for (const row of rows) {
      try { await assertMultiviewWorkReference(user, row); }
      catch (error) { if (error instanceof AuthError && [403, 404].includes(error.status)) continue; throw error; }
      const id = row.source_id ? `source:${row.source_id}` : `task:${row.source_task_id}`;
      titles.set(id, [...(titles.get(id) || []), row.title]);
      let group = groups.get(id);
      if (!group) {
        const project = row.project_id && !row.source_id ? await prisma.project.findUnique({ where: { id: row.project_id }, select: { name: true } }) : null;
        group = { id, taskId: row.source_task_id, sourceId: row.source_id, workId: row.id, sourceVersion: row.source_version,
          title: row.title, status: row.status, createdAt: row.created_at.toISOString(), projectId: row.source_id ? null : row.project_id,
          projectTitle: project?.name || null, schemeCount: 0, removed: input.removed, coverUrl: null };
        groups.set(id, group);
        if (group.projectId && project) projects.set(group.projectId, project.name);
      }
      group.schemeCount++;
      if (!group.workId) { group.workId = row.id; group.sourceVersion = row.source_version; group.title = row.title; }
      if (group.sourceVersion && !input.removed) group.coverUrl = `/api/video/multiview/works/${encodeURIComponent(group.workId!)}/source?version=${group.sourceVersion}&frame=0&thumbnail=1`;
    }
    after = rows.length === 128 ? rows[rows.length - 1].id : undefined;
  } while (after);
  const scope = createHash('sha256').update(JSON.stringify([user.id, input.q, input.projectId, input.removed])).digest('hex');
  let offset = 0;
  if (input.cursor) {
    let cursor: { scope?: string; offset?: number };
    try { cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString()); } catch { throw new MultiviewWorkError('记录分页已失效，请刷新。'); }
    if (cursor.scope !== scope || !Number.isSafeInteger(cursor.offset) || cursor.offset! < 0) throw new MultiviewWorkError('记录分页已失效，请刷新。');
    offset = cursor.offset!;
  }
  const filtered = Array.from(groups.values()).filter(row => (!input.projectId || row.projectId === input.projectId)
    && (!input.q || `${row.title} ${row.taskId} ${row.projectTitle || ''} ${(titles.get(row.id) || []).join(' ')}`.toLowerCase().includes(input.q.toLowerCase())))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  return { items: filtered.slice(offset, offset + 24), total: filtered.length, projects: Array.from(projects, ([id, title]) => ({ id, title })),
    nextCursor: offset + 24 < filtered.length ? Buffer.from(JSON.stringify({ scope, offset: offset + 24 })).toString('base64url') : null };
}
