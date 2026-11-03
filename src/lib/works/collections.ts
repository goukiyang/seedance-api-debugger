import 'server-only';

import type { Prisma } from '@prisma/client';
import type { SessionUser } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { getWorkAccess } from './access';
import { assertWorkId } from './interactions';
import { runWorkOperation } from './operations';
import { WorkError, type WorkCollectionPage } from './types';

const createKeys = new Set(['viewerId', 'requestId', 'name', 'expectedRevision']);
const renameKeys = new Set(['viewerId', 'requestId', 'name', 'expectedRevision']);
const deleteKeys = new Set(['viewerId', 'requestId', 'expectedRevision']);
const addKeys = new Set(['viewerId', 'requestId', 'workId', 'expectedRevision', 'expectedStateVersion', 'expectedMediaVersion']);
const removeKeys = new Set(['viewerId', 'requestId', 'workId', 'expectedRevision']);

function assertExactKeys(input: Record<string, unknown>, allowed: Set<string>, code: string) {
  if (Object.keys(input).some(key => !allowed.has(key))) throw new WorkError('收藏集操作参数无效', 400, code);
}

function nameOf(value: unknown) {
  if (typeof value !== 'string') throw new WorkError('收藏集名称需为1至60字', 400, 'WORK_COLLECTION_NAME_INVALID');
  const name = value.trim();
  if (!name || name.length > 60) throw new WorkError('收藏集名称需为1至60字', 400, 'WORK_COLLECTION_NAME_INVALID');
  return name;
}

function revisionOf(value: unknown, allowZero = false) {
  if (!Number.isSafeInteger(value) || (value as number) < (allowZero ? 0 : 1)) {
    throw new WorkError('收藏集版本无效', 400, 'WORK_COLLECTION_REVISION_INVALID');
  }
  return value as number;
}

function cursorOf(value: string | null) {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid cursor');
    const cursor = parsed as Record<string, unknown>;
    if (Object.keys(cursor).sort().join(',') !== 'at,id' || typeof cursor.at !== 'string' || typeof cursor.id !== 'string') {
      throw new Error('invalid cursor');
    }
    const at = new Date(cursor.at);
    assertWorkId(cursor.id, '收藏集游标');
    if (Number.isNaN(at.getTime())) throw new Error('invalid cursor');
    return { at, id: cursor.id };
  } catch (error) {
    if (error instanceof WorkError) throw error;
    throw new WorkError('收藏集加载位置已失效，请刷新', 400, 'WORK_COLLECTION_CURSOR_INVALID');
  }
}

function encodeCursor(row: { created_at: Date; id: string }) {
  return Buffer.from(JSON.stringify({ at: row.created_at.toISOString(), id: row.id })).toString('base64url');
}

function limitOf(value: string | null) {
  if (value === null) return 20;
  if (!/^\d+$/.test(value)) throw new WorkError('收藏集页大小无效', 400, 'WORK_COLLECTION_LIMIT_INVALID');
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new WorkError('每页收藏集数量需为1至50', 400, 'WORK_COLLECTION_LIMIT_INVALID');
  }
  return limit;
}

async function ownedCollection(tx: Prisma.TransactionClient, ownerId: string, collectionId: string, expectedRevision: number) {
  const collection = await tx.workCollection.findFirst({ where: { id: collectionId, owner_id: ownerId } });
  if (!collection || collection.removed_at) {
    throw new WorkError('收藏集不存在或已删除', 404, 'WORK_COLLECTION_NOT_FOUND');
  }
  if (collection.revision !== expectedRevision) {
    throw new WorkError('收藏集已在其他页面变化，请保留当前选择并刷新', 409, 'WORK_COLLECTION_REVISION_CONFLICT');
  }
  return collection;
}

export async function listWorkCollections(user: SessionUser, params: URLSearchParams): Promise<WorkCollectionPage> {
  const limit = limitOf(params.get('limit'));
  const cursor = cursorOf(params.get('cursor'));
  const rows = await prisma.workCollection.findMany({
    where: {
      owner_id: user.id,
      removed_at: null,
      ...(cursor ? { OR: [
        { created_at: { lt: cursor.at } },
        { created_at: cursor.at, id: { lt: cursor.id } },
      ] } : {}),
    },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });
  const page = rows.slice(0, limit);
  return {
    viewerId: user.id,
    collections: page.map(row => ({ id: row.id, name: row.name, revision: row.revision, createdAt: row.created_at.toISOString() })),
    nextCursor: rows.length > limit && page.length ? encodeCursor(page[page.length - 1]) : null,
  };
}

export async function createWorkCollection(user: SessionUser, input: Record<string, unknown>) {
  assertExactKeys(input, createKeys, 'WORK_COLLECTION_CREATE_INVALID');
  const name = nameOf(input.name);
  const expectedRevision = revisionOf(input.expectedRevision, true);
  if (expectedRevision !== 0) throw new WorkError('新收藏集版本必须为0', 409, 'WORK_COLLECTION_REVISION_CONFLICT');
  const operation = await runWorkOperation(user, {
    viewerId: input.viewerId,
    requestId: input.requestId,
    intent: ['work-collection-create-v1', name, expectedRevision],
  }, async (tx, actor) => {
    const collection = await tx.workCollection.create({ data: { owner_id: actor.id, name } });
    return { kind: 'collection-create', collectionId: collection.id, revision: collection.revision, created: true };
  });
  return { viewerId: user.id, operation };
}

export async function renameWorkCollection(user: SessionUser, collectionIdValue: unknown, input: Record<string, unknown>) {
  assertWorkId(collectionIdValue, '收藏集编号');
  const collectionId = collectionIdValue;
  assertExactKeys(input, renameKeys, 'WORK_COLLECTION_RENAME_INVALID');
  const name = nameOf(input.name);
  const expectedRevision = revisionOf(input.expectedRevision);
  const operation = await runWorkOperation(user, {
    viewerId: input.viewerId,
    requestId: input.requestId,
    intent: ['work-collection-rename-v1', collectionId, name, expectedRevision],
  }, async (tx, actor) => {
    await ownedCollection(tx, actor.id, collectionId, expectedRevision);
    const changed = await tx.workCollection.updateMany({
      where: { id: collectionId, owner_id: actor.id, removed_at: null, revision: expectedRevision },
      data: { name, revision: { increment: 1 } },
    });
    if (changed.count !== 1) {
      throw new WorkError('收藏集已在其他页面变化，请保留当前名称并刷新', 409, 'WORK_COLLECTION_REVISION_CONFLICT');
    }
    return { kind: 'collection-rename', collectionId, revision: expectedRevision + 1, renamed: true };
  });
  return { viewerId: user.id, operation };
}

export async function deleteWorkCollection(user: SessionUser, collectionIdValue: unknown, input: Record<string, unknown>) {
  assertWorkId(collectionIdValue, '收藏集编号');
  const collectionId = collectionIdValue;
  assertExactKeys(input, deleteKeys, 'WORK_COLLECTION_DELETE_INVALID');
  const expectedRevision = revisionOf(input.expectedRevision);
  const operation = await runWorkOperation(user, {
    viewerId: input.viewerId,
    requestId: input.requestId,
    intent: ['work-collection-delete-v1', collectionId, expectedRevision],
  }, async (tx, actor) => {
    await ownedCollection(tx, actor.id, collectionId, expectedRevision);
    const changed = await tx.workCollection.updateMany({
      where: { id: collectionId, owner_id: actor.id, removed_at: null, revision: expectedRevision },
      data: { removed_at: new Date(), revision: { increment: 1 } },
    });
    if (changed.count !== 1) {
      throw new WorkError('收藏集已在其他页面变化，请刷新后重试', 409, 'WORK_COLLECTION_REVISION_CONFLICT');
    }
    return { kind: 'collection-delete', collectionId, revision: expectedRevision + 1, removed: true };
  });
  return { viewerId: user.id, operation };
}

export async function addWorkCollectionMembership(user: SessionUser, collectionIdValue: unknown, input: Record<string, unknown>) {
  assertWorkId(collectionIdValue, '收藏集编号');
  const collectionId = collectionIdValue;
  assertExactKeys(input, addKeys, 'WORK_COLLECTION_MEMBERSHIP_INVALID');
  assertWorkId(input.workId);
  assertWorkId(input.expectedMediaVersion, '作品版本');
  const workId = input.workId;
  const expectedMediaVersion = input.expectedMediaVersion;
  const expectedRevision = revisionOf(input.expectedRevision);
  const expectedStateVersion = revisionOf(input.expectedStateVersion, true);
  const operation = await runWorkOperation(user, {
    viewerId: input.viewerId,
    requestId: input.requestId,
    intent: ['work-collection-add-v1', collectionId, workId, expectedRevision, expectedStateVersion, expectedMediaVersion],
  }, async (tx, actor) => {
    await ownedCollection(tx, actor.id, collectionId, expectedRevision);
    const access = await getWorkAccess(actor, workId, tx);
    if (!access?.canPreview) throw new WorkError('作品已不可用或你已无权访问', 404, 'WORK_UNAVAILABLE');
    if (access.media.id !== expectedMediaVersion || access.work.current_version_id !== expectedMediaVersion) {
      throw new WorkError('作品版本已变化，当前归类未应用，请按新版本重试', 409, 'WORK_MEDIA_VERSION_CONFLICT');
    }
    const state = await tx.workPersonalState.findUnique({
      where: { owner_id_work_id: { owner_id: actor.id, work_id: workId } },
    });
    if ((state?.version || 0) !== expectedStateVersion) {
      throw new WorkError('收藏状态已变化，请保留当前选择并刷新', 409, 'WORK_STATE_VERSION_CONFLICT');
    }
    const existing = await tx.workCollectionItem.findUnique({
      where: { collection_id_work_id: { collection_id: collectionId, work_id: workId } },
    });
    if (existing) throw new WorkError('作品已在该收藏集，请刷新收藏集', 409, 'WORK_COLLECTION_MEMBERSHIP_EXISTS');

    const nextStateVersion = state ? state.version + 1 : 1;
    if (state) {
      const stateChanged = await tx.workPersonalState.updateMany({
        where: { owner_id: actor.id, work_id: workId, version: expectedStateVersion },
        data: { favorited: true, version: { increment: 1 } },
      });
      if (stateChanged.count !== 1) {
        throw new WorkError('收藏状态已变化，请保留当前选择并刷新', 409, 'WORK_STATE_VERSION_CONFLICT');
      }
    } else {
      await tx.workPersonalState.create({ data: { owner_id: actor.id, work_id: workId, favorited: true } });
    }
    await tx.workCollectionItem.create({ data: { collection_id: collectionId, work_id: workId } });
    const collectionChanged = await tx.workCollection.updateMany({
      where: { id: collectionId, owner_id: actor.id, removed_at: null, revision: expectedRevision },
      data: { revision: { increment: 1 } },
    });
    if (collectionChanged.count !== 1) {
      throw new WorkError('收藏集已在其他页面变化，请保留当前选择并刷新', 409, 'WORK_COLLECTION_REVISION_CONFLICT');
    }
    return {
      kind: 'collection-membership', collectionId, workId, active: true,
      collectionRevision: expectedRevision + 1, stateVersion: nextStateVersion, favorited: true,
    };
  });
  return { viewerId: user.id, operation };
}

export async function removeWorkCollectionMembership(user: SessionUser, collectionIdValue: unknown, input: Record<string, unknown>) {
  assertWorkId(collectionIdValue, '收藏集编号');
  const collectionId = collectionIdValue;
  assertExactKeys(input, removeKeys, 'WORK_COLLECTION_MEMBERSHIP_INVALID');
  assertWorkId(input.workId);
  const workId = input.workId;
  const expectedRevision = revisionOf(input.expectedRevision);
  const operation = await runWorkOperation(user, {
    viewerId: input.viewerId,
    requestId: input.requestId,
    intent: ['work-collection-remove-v1', collectionId, workId, expectedRevision],
  }, async (tx, actor) => {
    await ownedCollection(tx, actor.id, collectionId, expectedRevision);
    const existing = await tx.workCollectionItem.findUnique({
      where: { collection_id_work_id: { collection_id: collectionId, work_id: workId } },
    });
    if (!existing) throw new WorkError('作品已不在该收藏集，请刷新收藏集', 409, 'WORK_COLLECTION_MEMBERSHIP_MISSING');
    const state = await tx.workPersonalState.findUnique({
      where: { owner_id_work_id: { owner_id: actor.id, work_id: workId } },
    });
    if (!state?.favorited) throw new WorkError('收藏状态不一致，请刷新后重试', 409, 'WORK_STATE_VERSION_CONFLICT');
    const removed = await tx.workCollectionItem.deleteMany({ where: { collection_id: collectionId, work_id: workId } });
    if (removed.count !== 1) throw new WorkError('收藏集已在其他页面变化，请刷新后重试', 409, 'WORK_COLLECTION_REVISION_CONFLICT');
    const collectionChanged = await tx.workCollection.updateMany({
      where: { id: collectionId, owner_id: actor.id, removed_at: null, revision: expectedRevision },
      data: { revision: { increment: 1 } },
    });
    if (collectionChanged.count !== 1) {
      throw new WorkError('收藏集已在其他页面变化，请刷新后重试', 409, 'WORK_COLLECTION_REVISION_CONFLICT');
    }
    return {
      kind: 'collection-membership', collectionId, workId, active: false,
      collectionRevision: expectedRevision + 1, stateVersion: state.version, favorited: true,
    };
  });
  return { viewerId: user.id, operation };
}
