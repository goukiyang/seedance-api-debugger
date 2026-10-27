import type { Prisma, VideoTask } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { captureHold, releaseHold, findTaskHold, settleTaskCredits, settleProjectTaskBudget, HoldReviewRequired } from '@/lib/billing/holds';
import { authorizeLegacyInflight } from '@/lib/billing/legacy-inflight';
import { settleVideoCreationBatch } from '@/lib/creation/settlement';
import { recordTaskCostSettlement } from '@/lib/costs/ledger';
import { restoreMultiview1080pApproval } from './multiview-1080p-approval';

type Tx = Prisma.TransactionClient;
export const terminalVideoState = (state: string) => ['succeeded', 'failed', 'cancelled'].includes(state);
const allowed: Record<string, readonly string[]> = {
  draft: ['created', 'submitting'], created: ['submitting', 'failed', 'cancelled'],
  submitting: ['submitted', 'unknown', 'failed'], unknown: ['submitted', 'running', 'succeeded', 'failed', 'cancelled'],
  submitted: ['unknown', 'running', 'succeeded', 'failed', 'cancelled'], running: ['succeeded', 'failed', 'cancelled'],
};
export async function settleVideoTaskHold(tx: Tx, task: VideoTask, legacyCompletion = false) {
  if (!terminalVideoState(task.local_status)) return task;
  const hold = await findTaskHold(tx, task.id);
  // Only a fresh nonterminal-to-terminal transaction can finish old in-flight
  // money. Reconciler/terminal reads never authorize historical D4 repairs.
  if (!hold) {
    if (!legacyCompletion || !(task.frozen_cost && task.frozen_cost > 0)) return task;
    const result = task.billing_scope === 'project' && task.project_id
      ? await settleProjectTaskBudget(tx, { taskId: task.id, projectId: task.project_id, frozenAmount: task.frozen_cost, terminalStatus: task.local_status, freezeSnapshot: task.credit_freeze_snapshot, operatorId: task.user_id })
      : await settleTaskCredits(tx, { taskId: task.id, userId: task.user_id!, frozenAmount: task.frozen_cost, terminalStatus: task.local_status, freezeSnapshot: task.credit_freeze_snapshot });
    const settled = await tx.videoTask.update({ where: { id: task.id }, data: { frozen_cost: 0, actual_cost: result.actualCost, refund_amount: result.refundedAmount } });
    await recordTaskCostSettlement(tx, settled, task.local_status, task.user_id || null);
    return settled;
  }
  if (hold.state === 'review' && hold.review_reason !== 'held_over_24_hours') throw new HoldReviewRequired(task.id);
  if (hold.payer_type === 'user' && hold.payer_id !== task.user_id
    || hold.payer_type === 'project' && hold.payer_id !== task.project_id) throw new Error('AUD_BILLING_VIDEO_PAYER_MISMATCH');
  const receipt = task.local_status === 'succeeded' ? await captureHold(tx, hold.id) : await releaseHold(tx, hold.id);
  const settled = await tx.videoTask.update({ where: { id: task.id }, data: {
    frozen_cost: 0, actual_cost: receipt.actual_cost, refund_amount: receipt.refunded_amount,
  } });
  await recordTaskCostSettlement(tx, settled, task.local_status, task.user_id || task.owner_user_id || null);
  return settled;
}

export async function transitionVideoTask(
  taskId: string, from: string | { local_status: string; state_version: number }, to: string,
  patch: Prisma.VideoTaskUncheckedUpdateInput = {}, client?: Tx,
): Promise<{ changed: boolean; task: VideoTask | null }> {
  const apply = async (tx: Tx) => {
    const task = await tx.videoTask.findUnique({ where: { id: taskId } });
    if (!task) return { changed: false, task: null };
    const expected = typeof from === 'string' ? from : from.local_status;
    if (task.local_status !== expected || typeof from !== 'string' && task.state_version !== from.state_version) return { changed: false, task };
    if (terminalVideoState(task.local_status)) {
      if (to !== task.local_status) return { changed: false, task };
      const settled = await settleVideoTaskHold(tx, task);
      await settleVideoCreationBatch(tx, taskId);
      return { changed: false, task: settled };
    }
    if (to !== task.local_status && !allowed[task.local_status]?.includes(to)) throw new Error(`AUD_VIDEO_INVALID_TRANSITION:${task.local_status}:${to}`);
    if (terminalVideoState(to)) await authorizeLegacyInflight(tx, 'video', taskId);
    const { local_status: _status, state_version: _version, frozen_cost: _frozen, actual_cost: _actual, refund_amount: _refund, ...safePatch } = patch;
    const result = await tx.videoTask.updateMany({ where: { id: taskId, local_status: expected, state_version: task.state_version },
      data: { ...safePatch, local_status: to, state_version: { increment: 1 },
        ...(terminalVideoState(to) ? { completed_at: task.completed_at || new Date() } : {}) } });
    if (!result.count) return { changed: false, task: await tx.videoTask.findUnique({ where: { id: taskId } }) };
    if (to === 'failed' && ['created', 'submitting'].includes(task.local_status) && !task.provider_task_id) {
      if (task.idempotency_key && task.user_id) await restoreMultiview1080pApproval(tx, task.user_id, task.idempotency_key);
      const approvals = await tx.approvalUsage.findMany({ where: { task_id: taskId, creation_intent_id: null }, select: { approval_id: true } });
      await tx.approvalUsage.deleteMany({ where: { task_id: taskId, creation_intent_id: null } });
      for (const approval of approvals) await tx.approvalRecord.updateMany({ where: { id: approval.approval_id, used_count: { gt: 0 } }, data: { used_count: { decrement: 1 } } });
    }
    let updated = await tx.videoTask.findUniqueOrThrow({ where: { id: taskId } });
    if (terminalVideoState(to)) {
      updated = await settleVideoTaskHold(tx, updated, true);
      await settleVideoCreationBatch(tx, taskId);
    }
    return { changed: true, task: updated };
  };
  return client ? apply(client) : prisma.$transaction(apply);
}

export async function createVideoTaskRecord(tx: Tx, args: Prisma.VideoTaskCreateArgs) {
  return tx.videoTask.create({ ...args, data: { ...args.data, local_status: 'created', state_version: 0 } });
}

export async function claimProviderRefresh(taskId: string, callback = false, now = new Date()) {
  if (callback) return true;
  const result = await prisma.videoTask.updateMany({ where: { id: taskId,
    OR: [{ last_provider_refresh_at: null }, { last_provider_refresh_at: { lte: new Date(+now - 10_000) } }] },
    data: { last_provider_refresh_at: now } });
  return result.count === 1;
}
