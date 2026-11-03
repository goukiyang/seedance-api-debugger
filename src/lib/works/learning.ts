import 'server-only';

import type { Prisma, WorkLearningEntry as LearningRow } from '@prisma/client';
import type { SessionUser } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { getWorkAccess } from './access';
import { assertWorkId } from './interactions';
import { runWorkOperation } from './operations';
import { WorkError } from './types';
import type { WorkLearningEntry, WorkLearningKind, WorkLearningPage } from './learning-types';

const keys = new Set(['viewerId', 'requestId', 'expectedMediaVersion', 'kind', 'parentId', 'body', 'timeSeconds', 'entryId', 'expectedRevision']);
const invalid = () => new WorkError('学习记录参数无效', 400, 'WORK_LEARNING_INPUT_INVALID');
const conflict = () => new WorkError('记录已变化，输入已保留，请重新读取后再修改', 409, 'WORK_LEARNING_VERSION_CONFLICT');

function normalize(input: Record<string, unknown>, action: 'create' | 'edit' | 'remove') {
  if (Object.keys(input).some(key => !keys.has(key))) throw invalid();
  assertWorkId(input.expectedMediaVersion, '作品版本');
  if (action !== 'create') {
    assertWorkId(input.entryId, '记录编号');
    if (!Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 1) throw invalid();
  }
  if (action === 'create' && !['experience', 'question', 'answer'].includes(String(input.kind))) throw invalid();
  if (action !== 'remove' && (typeof input.body !== 'string' || !input.body.trim() || input.body.trim().length > 4000)) throw invalid();
  if (input.parentId != null) assertWorkId(input.parentId, '问题编号');
  if (input.timeSeconds != null && (typeof input.timeSeconds !== 'number' || !Number.isFinite(input.timeSeconds) || input.timeSeconds < 0)) throw invalid();
  return {
    viewerId: input.viewerId, requestId: input.requestId, expectedMediaVersion: input.expectedMediaVersion,
    entryId: action === 'create' ? null : input.entryId as string, expectedRevision: action === 'create' ? 0 : input.expectedRevision as number,
    kind: action === 'create' ? input.kind as WorkLearningKind : null,
    parentId: (input.parentId as string | null | undefined) ?? null,
    body: action === 'remove' ? null : (input.body as string).trim(), timeSeconds: (input.timeSeconds as number | null | undefined) ?? null,
  };
}
function cursorFor(row: LearningRow) {
  return Buffer.from(JSON.stringify({ id: row.id, at: row.created_at.toISOString() })).toString('base64url');
}
function parseCursor(value: string | null) {
  if (!value) return null;
  try {
    if (value.length > 500) throw new Error();
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString()) as { id: unknown; at: unknown };
    assertWorkId(parsed.id, '浏览位置');
    if (typeof parsed.at !== 'string' || !Number.isFinite(Date.parse(parsed.at))) throw new Error();
    return { id: parsed.id, at: new Date(parsed.at) };
  } catch { throw new WorkError('浏览位置无效，请重新读取讨论', 400, 'WORK_LEARNING_CURSOR_INVALID'); }
}
async function projectEntries(tx: Prisma.TransactionClient, rows: LearningRow[], viewerId: string): Promise<WorkLearningEntry[]> {
  const authors = await tx.user.findMany({ where: { id: { in: Array.from(new Set(rows.map(row => row.author_id))) } }, select: { id: true, name: true } });
  const names = new Map(authors.map(author => {
    const name = author.name?.trim();
    return [author.id, name && !name.includes('@') && !/^\+?[\d\s-]{7,}$/.test(name) ? name : '同事'];
  }));
  return rows.map(row => ({
    id: row.id, workId: row.work_id, mediaVersion: row.media_version_id, kind: row.kind as WorkLearningKind,
    parentId: row.parent_id, body: row.body, timeSeconds: row.time_seconds, revision: row.revision,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    author: { id: row.author_id, name: names.get(row.author_id) || '同事' }, canEdit: row.author_id === viewerId,
  }));
}
/** Reading is limited to the exact current media, and never creates an entry or a job. */
export async function readWorkLearning(user: SessionUser, workId: string, params: URLSearchParams): Promise<WorkLearningPage> {
  assertWorkId(workId);
  const expected = params.get('version'); assertWorkId(expected, '作品版本');
  const parentId = params.get('parentId'); if (parentId) assertWorkId(parentId, '问题编号');
  const cursor = parseCursor(params.get('after'));
  return prisma.$transaction(async tx => {
    const access = await getWorkAccess(user, workId, tx);
    if (!access?.canPreview) throw new WorkError('作品已不可用或当前无权查看', 404, 'WORK_UNAVAILABLE');
    if (access.media.id !== expected) throw new WorkError('作品版本已变化，请重新打开当前作品', 409, 'WORK_MEDIA_VERSION_CONFLICT');
    if (parentId && !await tx.workLearningEntry.findFirst({ where: {
      id: parentId, work_id: workId, media_version_id: expected, kind: 'question', removed_at: null,
    }, select: { id: true } })) throw new WorkError('问题已不可用，请重新读取讨论', 404, 'WORK_QUESTION_UNAVAILABLE');
    const where: Prisma.WorkLearningEntryWhereInput = {
      work_id: workId, media_version_id: expected, removed_at: null,
      kind: parentId ? 'answer' : 'question', parent_id: parentId,
      ...(cursor ? { OR: [{ created_at: parentId ? { gt: cursor.at } : { lt: cursor.at } }, { created_at: cursor.at, id: parentId ? { gt: cursor.id } : { lt: cursor.id } }] } : {}),
    };
    const [experience, rows] = await Promise.all([
      parentId ? null : tx.workLearningEntry.findFirst({ where: {
        work_id: workId, media_version_id: expected, kind: 'experience', removed_at: null, author_id: access.work.author_id,
      }, orderBy: [{ created_at: 'asc' }, { id: 'asc' }] }),
      tx.workLearningEntry.findMany({ where, orderBy: [{ created_at: parentId ? 'asc' : 'desc' }, { id: parentId ? 'asc' : 'desc' }], take: 21 }),
    ]);
    const projected = await projectEntries(tx, [...(experience ? [experience] : []), ...rows.slice(0, 20)], user.id);
    return { viewerId: user.id, workId, mediaVersion: expected, experience: experience ? projected[0] : null,
      items: experience ? projected.slice(1) : projected, nextCursor: rows.length > 20 ? cursorFor(rows[19]) : null };
  }, { timeout: 15000 });
}
export async function mutateWorkLearning(user: SessionUser, workId: string, input: Record<string, unknown>, action: 'create' | 'edit' | 'remove') {
  assertWorkId(workId);
  const mutation = normalize(input, action);
  const operation = await runWorkOperation(user, {
    viewerId: mutation.viewerId, requestId: mutation.requestId, intent: { kind: 'work-learning', action, workId, mutation },
  }, async (tx, actor) => {
    const access = await getWorkAccess(actor, workId, tx);
    if (!access?.canPreview) throw new WorkError('作品已不可用或当前无权查看', 404, 'WORK_UNAVAILABLE');
    if (access.media.id !== mutation.expectedMediaVersion) throw new WorkError('作品版本已变化，输入已保留，请重新打开当前作品', 409, 'WORK_MEDIA_VERSION_CONFLICT');
    const current = mutation.entryId ? await tx.workLearningEntry.findFirst({ where: {
      id: mutation.entryId, work_id: workId, media_version_id: mutation.expectedMediaVersion, removed_at: null,
    } }) : null;
    if (action !== 'create' && (!current || current.author_id !== actor.id)) throw new WorkError('只能修改或删除本人的记录', 403, 'WORK_LEARNING_NOT_OWNED');
    if (current && current.revision !== mutation.expectedRevision) throw conflict();
    const kind = current?.kind || mutation.kind!;
    if (kind === 'experience' && access.work.author_id !== actor.id) throw new WorkError('只有作品作者能记录经验', 403, 'WORK_EXPERIENCE_NOT_OWNED');
    if (kind === 'experience' && mutation.body && mutation.body.length > 500) throw new WorkError('经验请控制在500字内', 400, 'WORK_EXPERIENCE_TOO_LONG');
    const parentId = current?.parent_id ?? mutation.parentId;
    if (kind === 'answer' && action !== 'remove') {
      if (!parentId || !await tx.workLearningEntry.findFirst({ where: {
        id: parentId, work_id: workId, media_version_id: mutation.expectedMediaVersion, kind: 'question', removed_at: null,
      }, select: { id: true } })) throw new WorkError('问题已不可用，当前回答未保存', 409, 'WORK_QUESTION_UNAVAILABLE');
    } else if (kind !== 'answer' && parentId) throw invalid();
    if (action !== 'remove' && mutation.timeSeconds !== null && (kind === 'experience' || access.work.medium !== 'video'
      || access.media.duration === null || !Number.isFinite(access.media.duration) || access.media.duration <= 0
      || mutation.timeSeconds > access.media.duration)) throw new WorkError('时间点须在当前视频的已知时长内', 400, 'WORK_LEARNING_TIME_INVALID');
    if (action === 'create') {
      if (kind === 'experience' && await tx.workLearningEntry.findFirst({ where: {
        work_id: workId, media_version_id: mutation.expectedMediaVersion, kind: 'experience', removed_at: null,
      }, select: { id: true } })) throw conflict();
      const row = await tx.workLearningEntry.create({ data: {
        work_id: workId, media_version_id: mutation.expectedMediaVersion, author_id: actor.id, kind,
        parent_id: parentId, body: mutation.body!, time_seconds: mutation.timeSeconds,
      } });
      return { kind: 'work-learning', workId, mediaVersion: mutation.expectedMediaVersion, entryId: row.id, entryKind: kind, revision: row.revision, removed: false };
    }
    const changed = await tx.workLearningEntry.updateMany({
      where: { id: current!.id, author_id: actor.id, revision: mutation.expectedRevision, removed_at: null, media_version_id: mutation.expectedMediaVersion },
      data: action === 'remove' ? { removed_at: new Date(), revision: { increment: 1 } }
        : { body: mutation.body!, time_seconds: mutation.timeSeconds, revision: { increment: 1 } },
    });
    if (changed.count !== 1) throw conflict();
    return { kind: 'work-learning', workId, mediaVersion: mutation.expectedMediaVersion, entryId: current!.id, entryKind: kind,
      revision: mutation.expectedRevision + 1, removed: action === 'remove' };
  });
  return { viewerId: user.id, operation };
}
