import 'server-only';
import { createHash } from 'node:crypto';
import type { Prisma, Work } from '@prisma/client';
import type { SessionUser } from '@/lib/auth/session';
import { canReadStudioAsset } from '@/lib/image-studio/protected-assets';
import { getOrCreateWorkspace, addAssetToWorkspace, normalizeWorkspaceTabId } from '@/lib/assets/workspace';
import { assertCanUseReferenceImage } from '@/lib/reference-albums/permissions';
import { getWorkAccess } from './access';
import { runWorkOperation } from './operations';
import { WorkError, type WorkLifecycleMutation } from './types';
import { invalidateWorkRecommendations } from './recommendation-events';

const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_:-]{1,180}$/.test(value);
async function assertSourceOwner(db: Prisma.TransactionClient, user: SessionUser, work: Work) {
  if (work.author_id !== user.id) throw new WorkError('只能管理本人作品', 403);
  const owner = work.source_kind === 'image_task' ? (await db.imageStudioTask.findUnique({ where: { id: work.source_id }, select: { owner_id: true } }))?.owner_id
    : work.source_kind === 'video_task' ? await db.videoTask.findUnique({ where: { id: work.source_id }, select: { owner_user_id: true, user_id: true } }).then(task => task?.owner_user_id || task?.user_id)
      : work.source_kind === 'multiview_work' ? (await db.multiviewWork.findUnique({ where: { id: work.source_id }, select: { owner_id: true } }))?.owner_id
        : work.source_kind === 'upload_asset' ? (await db.asset.findUnique({ where: { id: work.source_id }, select: { owner_id: true } }))?.owner_id : null;
  if (owner !== user.id) throw new WorkError('原作品归属已变化，未修改广场记录', 409);
}
export async function mutateWorkLifecycle(user: SessionUser, workId: string, input: WorkLifecycleMutation) {
  if (!input || !['exclude', 'restore-discovery', 'withdraw', 'restore-sharing'].includes(input.action)
    || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 || !id(input.expectedMediaVersion)) throw new WorkError('作品操作参数无效');
  return runWorkOperation(user, { ...input, intent: ['work-lifecycle-v1', workId, input.action, input.expectedRevision, input.expectedMediaVersion] }, async (tx, actor) => {
    const work = await tx.work.findUnique({ where: { id: workId } });
    if (!work) throw new WorkError('作品暂不可用', 404);
    await assertSourceOwner(tx, actor, work);
    if (work.current_version_id !== input.expectedMediaVersion || work.revision !== input.expectedRevision) throw new WorkError('作品版本已变化，请重新打开后操作', 409, 'WORKS_VERSION_CHANGED');
    const data = input.action === 'exclude' ? { discoverable: false } : input.action === 'restore-discovery' ? { discoverable: true }
      : input.action === 'withdraw' ? { withdrawn_at: new Date() } : { withdrawn_at: null };
    // Restoring a share retains its original frozen audience; it never publishes private history to a new audience.
    const changed = await tx.work.updateMany({ where: { id: workId, author_id: actor.id, revision: input.expectedRevision, current_version_id: input.expectedMediaVersion }, data: { ...data, revision: { increment: 1 } } });
    if (!changed.count) throw new WorkError('作品状态已变化，请重新打开后操作', 409);
    const fresh = await tx.work.findUniqueOrThrow({ where: { id: workId } });
    await invalidateWorkRecommendations(tx, workId);
    return { kind: 'lifecycle', workId, revision: fresh.revision, discoverable: fresh.discoverable, withdrawn: Boolean(fresh.withdrawn_at) };
  });
}

export async function publishUploadedWork(user: SessionUser, input: { viewerId: unknown; requestId: unknown; assetId: unknown; title?: unknown }) {
  if (!id(input?.assetId) || input.title !== undefined && (typeof input.title !== 'string' || input.title.trim().length > 120)) throw new WorkError('作品信息无效');
  const assetId = input.assetId, title = typeof input.title === 'string' ? input.title.trim() : '';
  return runWorkOperation(user, { ...input, intent: ['work-upload-v1', assetId, title] }, async (tx, actor) => {
    const asset = await tx.asset.findUnique({ where: { id: assetId } });
    if (!asset || asset.owner_id !== actor.id || asset.status !== 'active' || !['image', 'video'].includes(asset.type)
      || !await canReadStudioAsset(actor, asset, tx)) throw new WorkError('只能加入本人有权使用的图片或视频', 403);
    // An explicit selection is required. Upload/reference-library reads never create catalog entries.
    const work = await tx.work.upsert({ where: { source_kind_source_id_output_role: { source_kind: 'upload_asset', source_id: asset.id, output_role: 'output' } },
      create: { source_kind: 'upload_asset', source_id: asset.id, author_id: actor.id, title: title || (asset.type === 'image' ? '图片作品' : '视频作品'), medium: asset.type,
        audience: 'source', completed_at: asset.created_at }, update: {} });
    const revision = createHash('sha256').update(JSON.stringify([asset.id, asset.hash, asset.original_url])).digest('hex');
    const media = await tx.workMediaVersion.upsert({ where: { work_id_source_revision: { work_id: work.id, source_revision: revision } },
      create: { work_id: work.id, source_revision: revision, asset_id: asset.id, source_url: asset.original_url, source_updated_at: asset.created_at,
        content_hash: asset.hash, width: asset.width, height: asset.height, thumbnail_url: asset.thumbnail_url,
        preview_status: asset.type === 'image' && asset.thumbnail_url ? 'ready' : 'pending' }, update: {} });
    if (work.current_version_id !== media.id) await tx.work.update({ where: { id: work.id }, data: { current_version_id: media.id, revision: { increment: 1 } } });
    if (asset.type === 'video' || !asset.thumbnail_url) await tx.workRegistrationJob.upsert({
      where: { source_kind_source_id_source_revision: { source_kind: 'media_preview', source_id: media.id, source_revision: media.id } },
      create: { source_kind: 'media_preview', source_id: media.id, source_revision: media.id, source_updated_at: asset.created_at }, update: {} });
    return { kind: 'publish', workId: work.id, mediaVersion: media.id };
  });
}

/** Native reference permission is checked in the same transaction as this append and its durable receipt. */
export async function addWorkReference(user: SessionUser, workId: string, input: { viewerId: unknown; requestId: unknown; expectedMediaVersion: unknown; tabId?: unknown }) {
  if (!id(input?.expectedMediaVersion)) throw new WorkError('作品版本无效');
  const expectedMediaVersion = input.expectedMediaVersion, tabId = normalizeWorkspaceTabId(input.tabId);
  return runWorkOperation(user, { ...input, intent: ['work-reference-v1', workId, expectedMediaVersion, tabId] }, async (tx, actor) => {
    const access = await getWorkAccess(actor, workId, tx);
    if (!access?.canPreview || !access.reuse || access.work.medium !== 'image') throw new WorkError('当前仅可查看成品，未获得用作参考的权限', 403);
    if (access.media.id !== expectedMediaVersion) throw new WorkError('作品版本已变化，未更换本次参考', 409, 'WORKS_VERSION_CHANGED');
    const referenceId = access.reuse.referenceImageId;
    const reference = referenceId ? await assertCanUseReferenceImage(actor, referenceId, tx) : null;
    const assetId = reference?.asset_id || access.reuse.assetId;
    if (!assetId || assetId !== access.media.asset_id || reference && (reference.asset?.status !== 'active' || reference.asset.original_url !== access.media.source_url)) throw new WorkError('参考成品已变化，当前输入保留', 409);
    const workspace = await getOrCreateWorkspace(tabId, actor.id, tx);
    const existing = await tx.workspaceAsset.findUnique({ where: { workspace_id_asset_id: { workspace_id: workspace.id, asset_id: assetId } }, select: { id: true } });
    // Reusing an existing image keeps its current role/order and all other draft inputs.
    const workspaceAssetId = existing?.id || await addAssetToWorkspace(workspace.id, assetId, 'reference_image', actor.id,
      { db: tx, ...(referenceId ? { referenceImageId: referenceId } : {}), allowSharedAsset: Boolean(referenceId) || actor.role === 'admin' });
    return { kind: 'reference', workId, mediaVersion: access.media.id, assetId, referenceImageId: referenceId || null, workspaceId: workspace.id, workspaceAssetId };
  });
}
