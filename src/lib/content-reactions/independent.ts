import 'server-only';
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { SessionUser } from '@/lib/auth/session';
import { ReactionError } from './content';
import { tryContentKeyParts } from './key';
import type { ReactionMutation, ReactionState } from './types';
import type { GalleryReactionKey } from '@/lib/image-studio/gallery-types';
import { assertStudioActor, sharedStudioAvailability, studioSharedBinding, StudioSharingError } from '@/lib/image-studio/shared-contract';
import { readStudioWorkspaceDeletion } from '@/lib/image-studio/workspace-deletion';

export type IndependentReactionMutation = ReactionMutation & { protocol: 2 };
const namespace = 'independent-v2:';
function keyOf(value: unknown): GalleryReactionKey {
  const parsed = tryContentKeyParts(value);
  if (!parsed || !['image_template', 'image_module'].includes(parsed.type)) throw new ReactionError('封面互动编号无效');
  return parsed.key as GalleryReactionKey;
}
function requestOf(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(value)) throw new ReactionError('原请求编号无效');
  return value;
}
async function availableTo(user: SessionUser, key: GalleryReactionKey, tx: Prisma.TransactionClient) {
  const actor = await assertStudioActor(user.id, tx), parsed = tryContentKeyParts(key)!;
  if (parsed.type === 'image_template') {
    const source = await tx.imageStudioPreset.findUnique({ where: { id: parsed.id } });
    return Boolean(source && await sharedStudioAvailability(actor, source, tx));
  }
  const module = await tx.imageStudioModule.findFirst({ where: { id: parsed.id, owner_id: actor.id } });
  if (!module || await readStudioWorkspaceDeletion(actor.id, module.id, tx)) return false;
  // Bound live/publisher objects must use their exact source key, never a second poll.
  try { if (await studioSharedBinding(actor.id, module.id, tx)) return false; }
  catch (error) { if (error instanceof StudioSharingError && error.status === 409) return false; throw error; }
  if (module.source_preset_id) {
    const source = await tx.imageStudioPreset.findUnique({ where: { id: module.source_preset_id } });
    return Boolean(source && await sharedStudioAvailability(actor, source, tx));
  }
  return true;
}
async function stateFor(user: SessionUser, key: GalleryReactionKey, available: boolean, tx: Prisma.TransactionClient): Promise<ReactionState> {
  const row = await tx.contentReaction.findUnique({ where: { user_id_content_key: { user_id: user.id, content_key: key } } });
  return { key, liked: row?.liked || false, favorited: row?.favorited || false, version: row?.version || 0, available,
    likeCount: available ? await tx.contentReaction.count({ where: { content_key: key, liked: true } }) : null };
}
export async function readIndependentReaction(user: SessionUser, input: { key: unknown; requestId?: unknown }) {
  const key = keyOf(input.key), requestId = input.requestId === undefined ? null : requestOf(input.requestId);
  return prisma.$transaction(async tx => {
    const available = await availableTo(user, key, tx);
    const event = requestId ? await tx.contentReactionEvent.findUnique({ where: { user_id_request_id: { user_id: user.id, request_id: requestId } } }) : null;
    if (event && (event.content_key !== key || !event.fingerprint.startsWith(namespace))) throw new ReactionError('原请求内容或协议不一致', 409);
    return { protocol: 2 as const, status: requestId ? event ? 'committed' as const : 'unknown' as const : 'current' as const,
      requestId, state: await stateFor(user, key, available, tx) };
  }, { timeout: 15000 });
}
export async function setIndependentReaction(user: SessionUser, input: IndependentReactionMutation) {
  if (input?.protocol !== 2 || input.viewerId !== user.id) throw new ReactionError('互动协议或账号已变化', 409);
  const key = keyOf(input.key), requestId = requestOf(input.requestId);
  if (!['like', 'favorite'].includes(input.action) || typeof input.active !== 'boolean'
    || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) throw new ReactionError('互动参数无效');
  const fingerprint = namespace + createHash('sha256').update(JSON.stringify(['independent-v2', key, input.action, input.active, input.expectedVersion])).digest('hex');
  return prisma.$transaction(async tx => {
    const available = await availableTo(user, key, tx);
    const previous = await tx.contentReactionEvent.findUnique({ where: { user_id_request_id: { user_id: user.id, request_id: requestId } } });
    if (previous) {
      if (previous.fingerprint !== fingerprint || previous.content_key !== key) throw new ReactionError('重复请求内容或协议不一致', 409);
      return { protocol: 2 as const, status: 'committed' as const, requestId, state: await stateFor(user, key, available, tx) };
    }
    const current = await tx.contentReaction.findUnique({ where: { user_id_content_key: { user_id: user.id, content_key: key } } });
    if (input.active && !available) throw new ReactionError('封面已不可用或你已无权访问', 404);
    if (!current && !available) throw new ReactionError('标记不存在', 404);
    if ((current?.version || 0) !== input.expectedVersion) throw new ReactionError('状态已变化，请按最新状态重试', 409);
    const now = new Date();
    const data = input.action === 'like' ? { liked: input.active, liked_at: input.active ? current?.liked_at || now : null }
      : { favorited: input.active, favorited_at: input.active ? current?.favorited_at || now : null };
    if (current) {
      const changed = await tx.contentReaction.updateMany({ where: { id: current.id, version: input.expectedVersion }, data: { ...data, version: { increment: 1 } } });
      if (changed.count !== 1) throw new ReactionError('状态已变化，请按最新状态重试', 409);
    } else await tx.contentReaction.create({ data: { user_id: user.id, content_key: key, category: 'template', ...data } });
    await tx.contentReactionEvent.create({ data: { user_id: user.id, content_key: key, request_id: requestId, fingerprint, action: input.action, active: input.active } });
    return { protocol: 2 as const, status: 'committed' as const, requestId, state: await stateFor(user, key, available, tx) };
  }, { timeout: 15000 });
}
