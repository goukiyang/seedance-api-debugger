import type { ApprovalRecord } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { SessionUser } from '@/lib/auth/session';
import { getProjectAccess, logProjectActionInTransaction } from '@/lib/projects/permissions';
import { videoDeliveryStageForTask } from '@/lib/video/delivery-status';
import { canGenerateInVideoCardStatus } from '@/lib/video-cards/permissions';
import { CreationError, creationIdentity } from './contract';
import { assertVideoCreationReady, type CreationDb } from './context';
import { readCreationSource } from './lineage';
import { readCreationOperation, writeCreationOperation } from './receipts';

async function authority(db: CreationDb, user: SessionUser, taskId: string) {
  const task = await readCreationSource(db, user, taskId), rootId = task.lineage_root_task_id || task.id;
  const root = task.id === rootId ? task : await readCreationSource(db, user, rootId);
  if (!root.project_id || root.project_id !== task.project_id) throw new CreationError('此历史结果尚无可确认的交付范围', 409, 'creation_delivery_scope_unknown');
  const access = await getProjectAccess(user, root.project_id, db), ownerId = root.owner_user_id || root.user_id;
  if (!access.canView || !ownerId) throw new CreationError('交付范围不可用', 404);
  const canManage = access.project?.type === 'personal' ? ownerId === user.id || user.role === 'admin'
    : access.canManageProject;
  const selection = await db.videoDeliverySelection.findUnique({ where: {
    project_id_lineage_root_task_id: { project_id: root.project_id, lineage_root_task_id: root.id },
  } });
  if (selection && selection.owner_id !== ownerId) throw new CreationError('原交付作者关系无法确认，未修改交付', 503, 'creation_delivery_owner_conflict');
  const legacyCard = root.video_card_id ? await db.videoCard.findUnique({ where: { id: root.video_card_id }, select: { id: true, status: true } }) : null;
  return { task, root, ownerId, legacyCard, canManage, selection, projectId: root.project_id,
    target: `delivery:${root.project_id}:${root.id}` };
}
function command(body: Record<string, unknown>) {
  const action = body.action;
  if (!['select', 'clear', 'lock'].includes(String(action)) || !Number.isSafeInteger(body.expected_revision)
    || Number(body.expected_revision) < 0) throw new CreationError('交付操作或版本无效', 400);
  return { action: action as 'select' | 'clear' | 'lock', expected_revision: body.expected_revision as number,
    selected_task_id: action === 'select' ? creationIdentity(body.selected_task_id, 'selected_task_id') : null };
}
export async function getVideoDelivery(user: SessionUser, taskId: string, requestId?: string | null) {
  await assertVideoCreationReady(prisma, false);
  const value = await authority(prisma, user, taskId);
  const operation = requestId ? await readCreationOperation(prisma, user.id, value.target, requestId) : null;
  return { selection: value.selection, canManage: value.canManage, rootTaskId: value.root.id,
    operation, legacyCard: value.legacyCard, revision: value.selection?.revision || 0 };
}
export async function changeVideoDelivery(user: SessionUser, taskId: string, body: Record<string, unknown>) {
  await assertVideoCreationReady();
  const requestId = creationIdentity(body.request_id, 'request_id')!, input = command(body);
  return prisma.$transaction(async tx => {
    const value = await authority(tx, user, taskId);
    if (!value.canManage) throw new CreationError('只有原作者或有权项目管理者可以修改交付', 403);
    const original = await readCreationOperation(tx, user.id, value.target, requestId, input);
    if (original) return original;
    if (value.legacyCard && !canGenerateInVideoCardStatus(value.legacyCard.status)) throw new CreationError('原视频卡仍处于锁定状态，请从原卡申请重开', 409, 'creation_legacy_card_locked', 'video_card_id', 'reopen');
    const before = value.selection;
    if ((before?.revision || 0) !== input.expected_revision) throw new CreationError('交付已被另一操作修改，请重新读取', 409, 'creation_delivery_revision_conflict');
    if (before?.state === 'locked') throw new CreationError('这条创作链已锁定，请先申请重开', 409, 'creation_lineage_locked', 'delivery', 'reopen');
    const selectedId = input.action === 'clear' ? null : input.action === 'select' ? input.selected_task_id : before?.selected_task_id;
    if (input.action !== 'clear') {
      if (!selectedId) throw new CreationError('请先选择已就绪的交付成品', 409, 'creation_delivery_result_required');
      const selected = await readCreationSource(tx, user, selectedId);
      if (selected.project_id !== value.projectId || (selected.lineage_root_task_id || selected.id) !== value.root.id
        || selected.local_status !== 'succeeded' || !videoDeliveryStageForTask(selected).stableDownloadReady) {
        throw new CreationError('只能选择本条版本链中有权读取且稳定下载已就绪的成品', 409, 'creation_delivery_result_unavailable');
      }
    }
    const data = { selected_task_id: selectedId || null, state: input.action === 'lock' ? 'locked' : 'open',
      ...(input.action === 'select' || input.action === 'clear' ? { selected_by: user.id } : {}),
      ...(input.action === 'lock' ? { locked_by: user.id, locked_at: new Date() } : {}) };
    const selection = before ? await (async () => {
      const updated = await tx.videoDeliverySelection.updateMany({ where: { id: before.id, revision: before.revision, state: 'open' },
        data: { ...data, revision: { increment: 1 } } });
      if (updated.count !== 1) throw new CreationError('交付已变化，请核对原操作');
      return tx.videoDeliverySelection.findUniqueOrThrow({ where: { id: before.id } });
    })() : await tx.videoDeliverySelection.create({ data: { ...data, project_id: value.projectId,
      lineage_root_task_id: value.root.id, owner_id: value.ownerId, revision: 1 } });
    await logProjectActionInTransaction(tx, user.id, `video_delivery_${input.action}`, 'video_delivery', selection.id,
      { project_id: value.projectId, lineage_root_task_id: value.root.id, revision: selection.revision });
    return writeCreationOperation(tx, user.id, value.target, requestId, input, 'accepted', { selection });
  });
}
export async function closeVideoDeliveryOperation(user: SessionUser, taskId: string, requestId: string, body: Record<string, unknown>) {
  await assertVideoCreationReady();
  const input = command(body);
  return prisma.$transaction(async tx => {
    const value = await authority(tx, user, taskId);
    if (!value.canManage) throw new CreationError('无权结束此交付操作', 403);
    const original = await readCreationOperation(tx, user.id, value.target, requestId, input);
    if (original) return original;
    // The tombstone competes on the very same unique key as application.
    return writeCreationOperation(tx, user.id, value.target, requestId, input, 'closed', { ended: true });
  });
}
export async function requestVideoDeliveryReopen(user: SessionUser, taskId: string, body: Record<string, unknown>) {
  await assertVideoCreationReady();
  const requestId = creationIdentity(body.request_id, 'request_id')!, reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 2000) : '';
  if (!reason) throw new CreationError('请填写重开原因', 400);
  return prisma.$transaction(async tx => {
    const value = await authority(tx, user, taskId);
    const input = { action: 'reopen-request', expected_revision: body.expected_revision, reason };
    const original = await readCreationOperation(tx, user.id, value.target, requestId, input);
    if (original) return original;
    if (!value.selection || value.selection.state !== 'locked' || value.selection.revision !== body.expected_revision) throw new CreationError('当前交付已变化，请重新读取');
    const approval = await tx.approvalRecord.create({ data: { type: 'video_delivery_reopen', project_id: value.projectId,
      task_id: value.root.id, requester_user_id: user.id, reason, scope_json: JSON.stringify({ version: 2,
        delivery_id: value.selection.id, lineage_root_task_id: value.root.id, locked_revision: value.selection.revision }),
      expires_at: new Date(Date.now() + 14 * 86400000) } });
    return writeCreationOperation(tx, user.id, value.target, requestId, input, 'accepted', { approval_id: approval.id });
  });
}
export async function applyVideoDeliveryReopen(tx: CreationDb, approval: ApprovalRecord, approverId: string) {
  const scope = JSON.parse(approval.scope_json || '{}');
  if (scope.version !== 2 || typeof scope.delivery_id !== 'string' || !Number.isSafeInteger(scope.locked_revision)) throw new CreationError('重开批准范围无法确认');
  const selection = await tx.videoDeliverySelection.findUnique({ where: { id: scope.delivery_id } });
  if (!selection || selection.project_id !== approval.project_id || selection.lineage_root_task_id !== approval.task_id
    || scope.lineage_root_task_id !== selection.lineage_root_task_id) throw new CreationError('原交付锁范围已变化');
  const unlocked = await tx.videoDeliverySelection.updateMany({ where: { id: selection.id, revision: scope.locked_revision, state: 'locked' },
    data: { state: 'open', locked_by: null, locked_at: null, revision: { increment: 1 } } });
  if (unlocked.count !== 1) throw new CreationError('原锁已变化，此批准不能解开新的交付锁');
  await logProjectActionInTransaction(tx, approverId, 'video_delivery_reopen', 'video_delivery', selection.id,
    { approval_id: approval.id, previous_revision: scope.locked_revision });
}
