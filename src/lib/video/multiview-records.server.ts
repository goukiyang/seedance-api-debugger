import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { AuthError, type SessionUser } from '@/lib/auth/session';
import { USER_VISIBLE_TASK_RETENTION_STATUSES } from '@/lib/tasks/retention';
import { pageLimit, PaginationError, readPageCursor, writePageCursor } from '@/lib/pagination/cursor';
import { requireSecret } from '@/lib/security/secrets';
import { privateMultiviewTaskWhere } from './multiview-task-privacy';
import { currentMultiviewActor, assertMultiviewWorkReference, MultiviewWorkError } from './multiview-works';

export type MultiviewRecord = { id: string; taskId: string; sourceId: string | null; workId: string | null; sourceVersion: string | null;
  title: string; status: string; createdAt: string; projectId: string | null; projectTitle: string | null; schemeCount: number; removed: boolean; coverUrl: string | null };
type Input = { q: string; projectId: string; removed: boolean; cursor: string | null; limit?: string | null; directory?: 'projects' | 'records' };
type ProjectChoice = { id: string; title: string };
const batchSize = 100;
const taskSelect = { id: true, owner_user_id: true, user_id: true, retention_status: true, created_at: true, local_status: true,
  project_id: true, project: { select: { name: true } } } as const;
const workSelect = { id: true, owner_id: true, source_task_id: true, source_id: true, source_version: true, title: true,
  created_at: true, project_id: true, status: true } as const;
const taskWhere = (user: SessionUser, extra: Prisma.VideoTaskWhereInput = {}): Prisma.VideoTaskWhereInput => ({ AND: [privateMultiviewTaskWhere(),
  { OR: [{ owner_user_id: user.id }, { owner_user_id: null, user_id: user.id }] },
  { retention_status: { in: [...USER_VISIBLE_TASK_RETENTION_STATUSES] } }, extra] });
const workWhere = (user: SessionUser, removed: boolean, extra: Prisma.MultiviewWorkWhereInput = {}): Prisma.MultiviewWorkWhereInput => ({ AND: [
  { owner_id: user.id, save_state: { not: 'intent' }, removed_at: removed ? { not: null } : null }, extra] });
const taskSources: Prisma.MultiviewWorkWhereInput = { OR: [{ source_id: null }, { source_id: '' }] };
const workOrder = [{ created_at: 'desc' }, { id: 'desc' }] as const;
async function allowed(user: SessionUser, row: { owner_id: string; source_task_id: string; source_id: string | null }) {
  try { await assertMultiviewWorkReference(user, row); return true; }
  catch (error) { if (error instanceof AuthError && [403, 404].includes(error.status)) return false; throw error; }
}
async function privateTask(user: SessionUser, id: string) {
  return prisma.videoTask.findFirst({ where: taskWhere(user, { id }), select: { id: true, owner_user_id: true, user_id: true, retention_status: true } });
}
async function latestWork(where: Prisma.MultiviewWorkWhereInput) {
  return prisma.multiviewWork.findFirst({ where, orderBy: [...workOrder], select: workSelect });
}
async function* taskGroups(user: SessionUser, removed: boolean, projectId?: string) {
  let after: string | undefined;
  for (;;) {
    const rows = await prisma.multiviewWork.groupBy({ by: ['source_task_id'],
      where: workWhere(user, removed, { AND: [taskSources, ...(projectId ? [{ project_id: projectId }] : []), ...(after ? [{ source_task_id: { gt: after } }] : [])] }),
      orderBy: { source_task_id: 'asc' }, take: batchSize });
    if (rows.length > batchSize) throw new Error('Unbounded MV group source');
    for (const row of rows) yield row.source_task_id;
    if (rows.length < batchSize) return;
    const next = rows[rows.length - 1].source_task_id;
    if (next === after) throw new Error('MV groups did not advance');
    after = next;
  }
}

// Preserve the old concatenation, with only q.length - 1 characters retained
// between bounded title reads, including later schemes and cross-title matches.
async function matchesSearch(group: MultiviewRecord, where: Prisma.MultiviewWorkWhereInput, query: string) {
  if (!query) return true;
  const q = query.toLowerCase(); let tail = '';
  const contains = (text: string) => {
    const joined = tail + text.toLowerCase();
    tail = q.length > 1 ? joined.slice(-(q.length - 1)) : '';
    return joined.includes(q);
  };
  if (contains(`${group.title} ${group.taskId} ${group.projectTitle || ''} `)) return true;
  let after: { created_at: Date; id: string } | undefined, first = true;
  for (;;) {
    const seek: Prisma.MultiviewWorkWhereInput = after ? { OR: [
      { created_at: { lt: after.created_at } }, { created_at: after.created_at, id: { lt: after.id } },
    ] } : {};
    const rows = await prisma.multiviewWork.findMany({ where: { AND: [where, seek] },
      orderBy: [...workOrder], take: batchSize, select: { id: true, created_at: true, title: true } });
    if (rows.length > batchSize) throw new Error('Unbounded MV titles');
    for (const row of rows) { if (contains(`${first ? '' : ' '}${row.title}`)) return true; first = false; }
    if (rows.length < batchSize) return false;
    after = rows[rows.length - 1];
  }
}
async function recordFromWork(user: SessionUser, input: Input, where: Prisma.MultiviewWorkWhereInput) {
  const row = await latestWork(where);
  if (!row || !await allowed(user, row)) return null;
  const project = row.project_id && !row.source_id ? await prisma.project.findUnique({ where: { id: row.project_id }, select: { name: true } }) : null;
  const group: MultiviewRecord = { id: row.source_id ? `source:${row.source_id}` : `task:${row.source_task_id}`,
    taskId: row.source_task_id, sourceId: row.source_id, workId: row.id, sourceVersion: row.source_version,
    title: row.title, status: row.status, createdAt: row.created_at.toISOString(), projectId: row.source_id ? null : row.project_id,
    projectTitle: project?.name || null, schemeCount: await prisma.multiviewWork.count({ where }), removed: input.removed, coverUrl: null };
  if (group.sourceVersion && !input.removed) group.coverUrl = `/api/video/multiview/works/${encodeURIComponent(row.id)}/source?version=${group.sourceVersion}&frame=0&thumbnail=1`;
  return group;
}
async function* records(user: SessionUser, input: Input) {
  if (!input.removed) {
    let after: string | undefined;
    for (;;) {
      const tasks = await prisma.videoTask.findMany({ where: taskWhere(user, { ...(input.projectId ? { project_id: input.projectId } : {}), ...(after ? { id: { gt: after } } : {}) }),
        orderBy: { id: 'asc' }, take: batchSize, select: taskSelect });
      if (tasks.length > batchSize) throw new Error('Unbounded MV tasks');
      for (const task of tasks) {
        const owner = task.owner_user_id || task.user_id;
        if (!owner || !await allowed(user, { owner_id: owner, source_task_id: task.id, source_id: null })) continue;
        const where = workWhere(user, false, { AND: [taskSources, { source_task_id: task.id }] });
        const latest = await latestWork(where);
        const group: MultiviewRecord = { id: `task:${task.id}`, taskId: task.id, sourceId: null, workId: latest?.id || null,
          sourceVersion: latest?.source_version ?? null, title: latest ? latest.title : '3D多视图', status: task.local_status,
          createdAt: task.created_at.toISOString(), projectId: task.project_id, projectTitle: task.project?.name || null,
          schemeCount: latest ? await prisma.multiviewWork.count({ where }) : 0, removed: false,
          coverUrl: latest?.source_version ? `/api/video/multiview/works/${encodeURIComponent(latest.id)}/source?version=${latest.source_version}&frame=0&thumbnail=1`
            : `/api/video/multiview/records/${encodeURIComponent(task.id)}/cover` };
        if ((!input.projectId || group.projectId === input.projectId) && await matchesSearch(group, where, input.q)) yield group;
      }
      if (tasks.length < batchSize) break;
      after = tasks[tasks.length - 1].id;
    }
  }
  for await (const taskId of taskGroups(user, input.removed, input.projectId || undefined)) {
    if (!input.removed && await privateTask(user, taskId)) continue;
    const where = workWhere(user, input.removed, { AND: [taskSources, { source_task_id: taskId }] });
    const group = await recordFromWork(user, input, where);
    if (group && (!input.projectId || group.projectId === input.projectId) && await matchesSearch(group, where, input.q)) yield group;
  }
  if (input.projectId) return;
  let after: { source_id: string; source_task_id: string } | undefined;
  for (;;) {
    const rows = await prisma.multiviewWork.groupBy({ by: ['source_id', 'source_task_id'],
      where: workWhere(user, input.removed, { AND: [{ source_id: { not: null } }, { source_id: { not: '' } }, ...(after ? [{ OR: [
        { source_id: { gt: after.source_id } }, { source_id: after.source_id, source_task_id: { gt: after.source_task_id } }] }] : [])] }),
      orderBy: [{ source_id: 'asc' }, { source_task_id: 'asc' }], take: batchSize });
    if (rows.length > batchSize) throw new Error('Unbounded MV source groups');
    for (const row of rows) {
      if (!row.source_id) throw new Error('Invalid MV independent group');
      const where = workWhere(user, input.removed, { source_id: row.source_id, source_task_id: row.source_task_id });
      const group = await recordFromWork(user, input, where);
      if (group && !input.projectId && await matchesSearch(group, where, input.q)) yield group;
    }
    if (rows.length < batchSize) return;
    const last = rows[rows.length - 1];
    after = { source_id: last.source_id!, source_task_id: last.source_task_id };
  }
}
async function* projectKeys(user: SessionUser, removed: boolean, kind: 'task' | 'work') {
  if (kind === 'task' && removed) return;
  let after: string | undefined;
  for (;;) {
    const projectKey = { AND: [{ project_id: { not: null } }, { project_id: { not: '' } }, ...(after ? [{ project_id: { gt: after } }] : [])] };
    const rows = kind === 'task'
      ? await prisma.videoTask.groupBy({ by: ['project_id'], where: taskWhere(user, projectKey), orderBy: { project_id: 'asc' }, take: batchSize })
      : await prisma.multiviewWork.groupBy({ by: ['project_id'], where: workWhere(user, removed, { AND: [taskSources, projectKey] }), orderBy: { project_id: 'asc' }, take: batchSize });
    if (rows.length > batchSize) throw new Error('Unbounded MV project keys');
    for (const row of rows) { if (!row.project_id) throw new Error('Invalid MV project key'); yield row.project_id; }
    if (rows.length < batchSize) return;
    after = rows[rows.length - 1].project_id!;
  }
}
async function projectHasRecord(user: SessionUser, removed: boolean, projectId: string) {
  if (!removed) {
    let after: string | undefined;
    for (;;) {
      const tasks = await prisma.videoTask.findMany({ where: taskWhere(user, { project_id: projectId, ...(after ? { id: { gt: after } } : {}) }),
        orderBy: { id: 'asc' }, take: batchSize, select: { id: true, owner_user_id: true, user_id: true, retention_status: true } });
      if (tasks.length > batchSize) throw new Error('Unbounded MV project tasks');
      for (const task of tasks) {
        const owner = task.owner_user_id || task.user_id;
        if (owner && await allowed(user, { owner_id: owner, source_task_id: task.id, source_id: null })) return true;
      }
      if (tasks.length < batchSize) break;
      after = tasks[tasks.length - 1].id;
    }
  }
  for await (const taskId of taskGroups(user, removed, projectId)) {
    if (!removed && await privateTask(user, taskId)) continue;
    const row = await latestWork(workWhere(user, removed, { AND: [taskSources, { source_task_id: taskId }] }));
    if (row?.project_id === projectId && await allowed(user, row)) return true;
  }
  return false;
}
async function* projects(user: SessionUser, input: Input) {
  const tasks = projectKeys(user, input.removed, 'task'), works = projectKeys(user, input.removed, 'work');
  let task = await tasks.next(), work = await works.next();
  while (!task.done || !work.done) {
    const taskId = task.done ? null : task.value, workId = work.done ? null : work.value;
    const id = taskId === null ? workId! : workId === null ? taskId : taskId < workId ? taskId : workId;
    if (!task.done && task.value === id) task = await tasks.next();
    if (!work.done && work.value === id) work = await works.next();
    if (!await projectHasRecord(user, input.removed, id)) continue;
    const project = await prisma.project.findUnique({ where: { id }, select: { name: true } });
    if (project) yield { id, title: project.name };
  }
}

// Canonical producer order includes every display-order key in the fingerprint.
// Only the best limit candidates are retained, never a full group/title map.
function boundedPage<T>(input: Input, context: string, secret: Buffer, limit: number,
  key: (row: T) => string[], compare: (left: string[], right: string[]) => number) {
  const raw = input.cursor === null ? null : readPageCursor(input.cursor, context, secret);
  const width = input.directory === 'projects' ? 1 : 2;
  if (raw && (raw.length !== width + 1 || raw.some(item => typeof item !== 'string' || !item) || !/^[a-f0-9]{64}$/.test(String(raw[width]))
    || width === 2 && (!Number.isFinite(Date.parse(String(raw[0]))) || new Date(String(raw[0])).toISOString() !== raw[0]))) throw new PaginationError();
  const anchor = raw ? raw.slice(0, width) as string[] : null;
  const hash = createHash('sha256'), items: T[] = [];
  let total = 0, remaining = 0, found = !anchor;
  return {
    visit(row: T) {
      const value = key(row); total++;
      hash.update(JSON.stringify([value, row]) + '\n');
      if (anchor && value.every((part, index) => part === anchor[index])) found = true;
      if (anchor && compare(value, anchor) <= 0) return;
      remaining++;
      if (items.length === limit) {
        if (compare(value, key(items[items.length - 1])) >= 0) return;
        items.pop();
      }
      const position = items.findIndex(item => compare(value, key(item)) < 0);
      items.splice(position === -1 ? items.length : position, 0, row);
    },
    finish() {
      const fingerprint = hash.digest('hex');
      if (!found || raw && raw[width] !== fingerprint) throw new PaginationError('记录已变化，请刷新列表。', 409);
      const hasMore = remaining > items.length;
      const pagination = { limit, total, hasMore, nextCursor: hasMore ? writePageCursor([...key(items[items.length - 1]), fingerprint], context, secret) : null };
      return { items, total, nextCursor: pagination.nextCursor, pagination };
    },
  };
}
export async function listMultiviewRecords(user: SessionUser, input: Input) {
  const actor = await currentMultiviewActor(user);
  if (input.q.length > 120 || input.projectId.length > 100 || (input.cursor?.length || 0) > 2048
    || input.directory && !['records', 'projects'].includes(input.directory)) throw new MultiviewWorkError('记录筛选无效。');
  const params = new URLSearchParams(); if (input.limit !== undefined && input.limit !== null) params.set('limit', input.limit);
  const limit = pageLimit(params), directory = input.directory || 'records', secret = requireSecret('media');
  const context = JSON.stringify(['multiview-record-page-v2', actor.id, actor.role, actor.account_type, actor.user_profile,
    actor.feature_profile_id, actor.expires_at?.toISOString() || null, actor.feishu?.user_id || null, actor.feishu?.open_id || null,
    actor.feishu?.union_id || null, directory, input.q, input.projectId, input.removed]);
  if (directory === 'projects') {
    const page = boundedPage<ProjectChoice>({ ...input, directory }, context, secret, limit, row => [row.id], (a, b) => a[0].localeCompare(b[0]));
    for await (const project of projects(actor, input)) page.visit(project);
    const result = page.finish();
    return { projects: result.items, total: result.total, nextCursor: result.nextCursor, pagination: result.pagination };
  }
  const page = boundedPage<MultiviewRecord>(input, context, secret, limit, row => [row.createdAt, row.id],
    (a, b) => b[0].localeCompare(a[0]) || b[1].localeCompare(a[1]));
  for await (const record of records(actor, input)) page.visit(record);
  return { ...page.finish(), projects: [] };
}
