import 'server-only';

import type { Prisma } from '@prisma/client';
import type { SessionUser } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { getWorkAccess } from './access';
import { runWorkOperation } from './operations';
import { WorkError, type WorkPersonal } from './types';

const idPattern = /^[A-Za-z0-9_-]{1,100}$/;
const stateKeys = new Set(['viewerId', 'requestId', 'action', 'active', 'expectedVersion', 'expectedMediaVersion']);
type StateAction = 'like' | 'favorite' | 'hide';

export function assertWorkId(value: unknown, label = '作品编号'): asserts value is string {
  if (typeof value !== 'string' || !idPattern.test(value)) {
    throw new WorkError(`${label}无效`, 400, 'WORK_ID_INVALID');
  }
}

function assertExactKeys(input: Record<string, unknown>, allowed: Set<string>) {
  if (Object.keys(input).some(key => !allowed.has(key))) {
    throw new WorkError('互动参数无效', 400, 'WORK_STATE_INPUT_INVALID');
  }
}

function normalizeMutation(input: Record<string, unknown>) {
  assertExactKeys(input, stateKeys);
  if (!['like', 'favorite', 'hide'].includes(String(input.action)) || typeof input.active !== 'boolean'
    || !Number.isSafeInteger(input.expectedVersion) || (input.expectedVersion as number) < 0) {
    throw new WorkError('互动参数无效', 400, 'WORK_STATE_INPUT_INVALID');
  }
  assertWorkId(input.expectedMediaVersion, '作品版本');
  return {
    viewerId: input.viewerId,
    requestId: input.requestId,
    action: input.action as StateAction,
    active: input.active,
    expectedVersion: input.expectedVersion as number,
    expectedMediaVersion: input.expectedMediaVersion,
  };
}

async function collectionIdsFor(tx: Prisma.TransactionClient, ownerId: string, workId: string) {
  const rows = await tx.workCollectionItem.findMany({
    where: { work_id: workId, collection: { owner_id: ownerId, removed_at: null } },
    select: { collection_id: true },
    orderBy: [{ created_at: 'asc' }, { collection_id: 'asc' }],
  });
  return rows.map(row => row.collection_id);
}

function personalOf(row: { liked: boolean; favorited: boolean; hidden: boolean; version: number } | null): WorkPersonal {
  return row ? { liked: row.liked, favorited: row.favorited, hidden: row.hidden, version: row.version }
    : { liked: false, favorited: false, hidden: false, version: 0 };
}

export async function readWorkPersonalState(user: SessionUser, workIdValue: unknown) {
  assertWorkId(workIdValue);
  const workId = workIdValue;
  return prisma.$transaction(async tx => {
    const state = await tx.workPersonalState.findUnique({
      where: { owner_id_work_id: { owner_id: user.id, work_id: workId } },
    });
    if (!state) {
      const access = await getWorkAccess(user, workId, tx);
      if (!access?.canPreview) throw new WorkError('作品已不可用或你已无权访问', 404, 'WORK_UNAVAILABLE');
    }
    return {
      viewerId: user.id,
      workId,
      personal: personalOf(state),
      collectionIds: await collectionIdsFor(tx, user.id, workId),
    };
  }, { timeout: 15000 });
}

export async function mutateWorkPersonalState(user: SessionUser, workIdValue: unknown, input: Record<string, unknown>) {
  assertWorkId(workIdValue);
  const workId = workIdValue;
  const mutation = normalizeMutation(input);
  const operation = await runWorkOperation(user, {
    viewerId: mutation.viewerId,
    requestId: mutation.requestId,
    intent: ['work-state-v1', workId, mutation.action, mutation.active, mutation.expectedVersion, mutation.expectedMediaVersion],
  }, async (tx, actor) => {
    const current = await tx.workPersonalState.findUnique({
      where: { owner_id_work_id: { owner_id: actor.id, work_id: workId } },
    });
    if ((current?.version || 0) !== mutation.expectedVersion) {
      throw new WorkError('互动状态已变化，请保留当前操作并按最新状态重试', 409, 'WORK_STATE_VERSION_CONFLICT');
    }
    if (mutation.active) {
      const access = await getWorkAccess(actor, workId, tx);
      if (!access?.canPreview) throw new WorkError('作品已不可用或你已无权访问', 404, 'WORK_UNAVAILABLE');
      if (access.media.id !== mutation.expectedMediaVersion || access.work.current_version_id !== mutation.expectedMediaVersion) {
        throw new WorkError('作品版本已变化，当前操作未应用，请按新版本重试', 409, 'WORK_MEDIA_VERSION_CONFLICT');
      }
    } else if (!current) {
      throw new WorkError('个人互动状态不存在', 404, 'WORK_STATE_NOT_FOUND');
    }

    const next = {
      liked: mutation.action === 'like' ? mutation.active : current?.liked || false,
      favorited: mutation.action === 'favorite' ? mutation.active : current?.favorited || false,
      hidden: mutation.action === 'hide' ? mutation.active : current?.hidden || false,
    };
    const nextVersion = current ? current.version + 1 : 1;
    if (current) {
      const changed = await tx.workPersonalState.updateMany({
        where: { owner_id: actor.id, work_id: workId, version: mutation.expectedVersion },
        data: { ...next, version: { increment: 1 } },
      });
      if (changed.count !== 1) {
        throw new WorkError('互动状态已变化，请保留当前操作并按最新状态重试', 409, 'WORK_STATE_VERSION_CONFLICT');
      }
    } else {
      await tx.workPersonalState.create({ data: { owner_id: actor.id, work_id: workId, ...next } });
    }

    if (mutation.action === 'favorite' && !mutation.active) {
      const memberships = await tx.workCollectionItem.findMany({
        where: { work_id: workId, collection: { owner_id: actor.id } },
        select: { collection_id: true },
      });
      const collectionIds = Array.from(new Set(memberships.map(item => item.collection_id)));
      if (collectionIds.length) {
        await tx.workCollectionItem.deleteMany({ where: { work_id: workId, collection_id: { in: collectionIds } } });
        await tx.workCollection.updateMany({
          where: { owner_id: actor.id, id: { in: collectionIds } },
          data: { revision: { increment: 1 } },
        });
      }
    }

    return {
      kind: 'work-state',
      workId,
      action: mutation.action,
      active: mutation.active,
      liked: next.liked,
      favorited: next.favorited,
      hidden: next.hidden,
      stateVersion: nextVersion,
      collectionIds: await collectionIdsFor(tx, actor.id, workId),
    };
  });
  return { viewerId: user.id, operation };
}
