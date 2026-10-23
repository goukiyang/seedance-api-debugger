import { videoDeliveryStageForTask } from '@/lib/video/delivery-status';
import type { VideoTask } from '@prisma/client';
import type { SessionUser } from '@/lib/auth/session';
import { assertCanViewTask, getProjectAccess } from '@/lib/projects/permissions';
import { isTaskHiddenFromRegularUsers } from '@/lib/tasks/retention';
import { CreationError, type VideoCreationSpec } from './contract';
import type { CreationDb } from './context';

export async function readCreationSource(db: CreationDb, user: SessionUser, taskId: string) {
  const task = await db.videoTask.findUnique({ where: { id: taskId } });
  if (!task || isTaskHiddenFromRegularUsers(task)) throw new CreationError('来源任务不可用，当前输入已保留', 404, 'creation_source_unavailable');
  if (task.project_id) {
    const access = await getProjectAccess(user, task.project_id, db);
    if (!access.canView) throw new CreationError('来源任务不可用，当前输入已保留', 404, 'creation_source_unavailable');
  } else if ((task.owner_user_id || task.user_id) !== user.id && user.role !== 'admin') {
    throw new CreationError('来源任务不可用，当前输入已保留', 404, 'creation_source_unavailable');
  }
  await assertCanViewTask(user, task);
  return task;
}
export async function assertCreationLineageUnlocked(db: CreationDb, user: SessionUser, parentTaskId: string, projectId: string) {
  const parent = await readCreationSource(db, user, parentTaskId);
  // A legacy result without a project can be used in an explicitly new destination,
  // but never silently grafted onto the old chain.
  if (!parent.project_id) return { parent, parentId: null, rootId: null };
  if (parent.project_id !== projectId) throw new CreationError('继续原链须保持原项目；跨项目请明确作为素材新建独立作品', 409, 'creation_lineage_destination_changed', 'project_id', 'select_project');
  const rootId = parent.lineage_root_task_id || parent.id;
  const root = rootId === parent.id ? parent : await readCreationSource(db, user, rootId);
  if (root.project_id !== projectId) throw new CreationError('原版本关系无法确认，请保留来源另作独立创作', 409, 'creation_lineage_invalid');
  const selection = await db.videoDeliverySelection.findUnique({ where: {
    project_id_lineage_root_task_id: { project_id: projectId, lineage_root_task_id: rootId },
  } });
  if (selection?.state === 'locked') throw new CreationError('这条创作链已锁定交付，请先申请重开', 409, 'creation_lineage_locked', 'continuation', 'reopen');
  if (parent.video_card_id) {
    const card = await db.videoCard.findUnique({ where: { id: parent.video_card_id }, select: { status: true } });
    if (!card || !['draft', 'active', 'reviewing'].includes(card.status)) {
      throw new CreationError('来源视频卡已锁定，继续原链须先重开', 409, 'creation_legacy_card_locked', 'video_card_id', 'reopen');
    }
  }
  return { parent, parentId: parent.id, rootId };
}
export function creationParent(spec: VideoCreationSpec) {
  return spec.continuation.mode === 'continue' ? spec.continuation.parent_task_id || null
    : spec.action === 'enhance' || spec.action === 'draft_upgrade'
      ? String(spec.input.source_task_id || spec.input.source_draft_task_id || '') || null : null;
}
export async function creationTaskLineage(db: CreationDb, user: SessionUser, spec: VideoCreationSpec, taskId: string) {
  const parentId = creationParent(spec);
  if (!parentId) return { derived_from_task_id: null, derivation_kind: 'new', lineage_root_task_id: taskId };
  const source = await assertCreationLineageUnlocked(db, user, parentId, spec.project_id);
  return { derived_from_task_id: source.parentId,
    derivation_kind: source.parentId ? spec.action === 'generate' ? 'continue' : spec.action : 'new',
    lineage_root_task_id: source.rootId || taskId };
}
export function creationVersionSummary(task: VideoTask) {
  // Relations do not grant prompts, provider payloads, costs or private recipe fields.
  return { id: task.id, project_id: task.project_id, local_status: task.local_status, model: task.model,
    created_at: task.created_at, play_url: task.local_video_path ? `/api/video/play/${task.id}` : task.public_video_url || null,
    stable_download_ready: videoDeliveryStageForTask(task).stableDownloadReady, derivation_kind: task.derivation_kind || null,
    isIndependent: !task.lineage_root_task_id || task.lineage_root_task_id === task.id };
}

/** A fresh legacy derivation must respect a new lock, while independent input provenance stays reusable. */
export async function assertLegacyCreationSourceLocks(db: CreationDb, user: SessionUser, body: Record<string, unknown>, projectId: string) {
  if (body.creation_contract_version === 2) return;
  const continuation = body.continuation as Record<string, unknown> | undefined;
  const parentId = continuation?.mode === 'continue' ? continuation.parent_task_id
    : body.source_draft_task_id || (body.generation_mode === 'enhance_video' || body.action === 'enhance' ? body.source_task_id : null);
  if (typeof parentId !== 'string' || !parentId) return;
  const parent = await readCreationSource(db, user, parentId);
  if (parent.project_id === projectId && parent.lineage_root_task_id) await assertCreationLineageUnlocked(db, user, parent.id, projectId);
}
