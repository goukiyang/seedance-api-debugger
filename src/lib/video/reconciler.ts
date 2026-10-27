import type { VideoTask } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { findTaskHold } from '@/lib/billing/holds';
import { queueBillingAlert, deliverBillingAlerts } from '@/lib/billing/alerts';
import { runDailyBillingInspection } from '@/lib/billing/invariants';
import { transitionVideoTask, settleVideoTaskHold, terminalVideoState } from './task-state';
import { markProviderApiRequestAccepted } from '@/lib/costs/ledger';
import { settleVideoCreationBatch } from '@/lib/creation/settlement';
import { authorizeLegacyInflight } from '@/lib/billing/legacy-inflight';

async function repairAcceptedSideEffects(task: VideoTask) {
  if (!task.provider_task_id) return;
  const request = await prisma.providerApiRequest.findFirst({ where: { task_id: task.id, status: { in: ['pending', 'unknown', 'timeout', 'failed'] } }, orderBy: { created_at: 'desc' } });
  if (request) await markProviderApiRequestAccepted({ requestId: request.id, task, providerTaskId: task.provider_task_id,
    responseSummary: { recovered_by: 'billing_reconciler', provider_task_id: task.provider_task_id } });
  if (task.error_code !== 'SUBMISSION_AUXILIARY_PENDING') return;
  await prisma.$transaction(async tx => {
    const fresh = await tx.videoTask.findUniqueOrThrow({ where: { id: task.id } });
    if (fresh.error_code !== 'SUBMISSION_AUXILIARY_PENDING') return;
    if (fresh.agent_run_id) {
      const run = await tx.agentRun.findUnique({ where: { id: fresh.agent_run_id } });
      if (run && run.video_task_id === fresh.id) {
        await tx.agentRun.update({ where: { id: run.id }, data: { status: fresh.local_status, final_prompt_snapshot: fresh.final_prompt_snapshot, user_edited: fresh.prompt_user_edited } });
        if (!await tx.templateMemory.findFirst({ where: { agent_run_id: run.id, video_task_id: fresh.id, memory_type: 'task_result' } })) {
          await tx.templateMemory.create({ data: { template_id: fresh.template_id || run.template_id, user_id: fresh.user_id!, agent_run_id: run.id,
            video_task_id: fresh.id, memory_type: 'task_result', signal: 'neutral', summary: '原任务已受理，附属记录恢复', metadata_json: JSON.stringify({ provider: fresh.provider }) } });
        }
      }
    }
    await tx.videoTask.updateMany({ where: { id: fresh.id, error_code: 'SUBMISSION_AUXILIARY_PENDING' }, data: { error_code: null, error_message: null } });
  });
}

export type SubmissionLookup = { state: 'found'; providerTaskId: string } | { state: 'unknown' }
  | { state: 'absent'; requestId: string; provider: string; authoritativeNoCharge: true };
export async function lookupOriginalSubmission(task: VideoTask): Promise<SubmissionLookup> {
  if (task.provider_task_id) return { state: 'found', providerTaskId: task.provider_task_id };
  // These adapters have no verified request-id lookup/no-charge proof. A 404,
  // transport timeout or expired media is never translated into absence.
  if (task.provider !== 'seedance') return { state: 'unknown' };
  try {
    const { getVideoTaskStatusByClientRequestId } = await import('@/lib/provider/jimeng');
    const result = await getVideoTaskStatusByClientRequestId(task.provider_client_request_id || task.id);
    return result.provider_task_id && result.provider_task_id !== (task.provider_client_request_id || task.id)
      ? { state: 'found', providerTaskId: result.provider_task_id } : { state: 'unknown' };
  } catch { return { state: 'unknown' }; }
}
export async function reconcileVideoTask(taskId: string, options: {
  now?: Date; lookup?: (task: VideoTask) => Promise<SubmissionLookup>;
} = {}) {
  const now = options.now || new Date();
  const task = await prisma.videoTask.findUnique({ where: { id: taskId } });
  if (!task) return { repaired: false, reason: 'missing' };
  const hold = await findTaskHold(prisma, taskId);
  if (!hold) {
    if (terminalVideoState(task.local_status)) return { repaired: false, reason: 'historical_read_only' };
    const eligible = await prisma.$transaction(tx => authorizeLegacyInflight(tx, 'video', task.id));
    if (!eligible) return { repaired: false, reason: 'legacy_evidence_requires_review' };
  }
  await repairAcceptedSideEffects(task);
  if (terminalVideoState(task.local_status)) {
    await prisma.$transaction(async tx => {
      const fresh = await tx.videoTask.findUniqueOrThrow({ where: { id: taskId } });
      await settleVideoTaskHold(tx, fresh);
      await settleVideoCreationBatch(tx, taskId);
    });
    return { repaired: true, reason: 'terminal' };
  }
  if (['unknown', 'submitting', 'submitted'].includes(task.local_status) && (!task.provider_task_id || task.local_status === 'unknown')) {
    const lookup = await (options.lookup || lookupOriginalSubmission)(task);
    if (lookup.state === 'found') {
      await transitionVideoTask(taskId, task, 'submitted', { provider_task_id: lookup.providerTaskId, error_code: null, error_message: null });
      return { repaired: true, reason: 'accepted_original_request' };
    }
    if (lookup.state === 'absent' && lookup.authoritativeNoCharge && lookup.requestId === (task.provider_client_request_id || task.id)
      && lookup.provider === task.provider && +now - +task.created_at >= 30 * 60_000) {
      await transitionVideoTask(taskId, task, 'failed', { error_code: 'PROVIDER_CONFIRMED_NOT_ACCEPTED', error_message: '供应商确认未受理且未收费，已结束本次请求' });
      return { repaired: true, reason: 'authoritative_non_acceptance' };
    }
  }
  return { repaired: false, reason: 'unconfirmed' };
}
export async function reconcileVideoBilling(options: { limit?: number; now?: Date } = {}) {
  const now = options.now || new Date(), limit = options.limit || 50;
  const holds = await prisma.creditHold.findMany({ where: { OR: [{ state: 'held' }, { state: 'review', review_reason: 'held_over_24_hours' }] }, orderBy: { updated_at: 'asc' }, take: limit });
  for (const hold of holds) {
    // A row claiming this slot prevents concurrent reconcilers hammering lookup.
    const claimed = await prisma.creditHold.updateMany({ where: { id: hold.id, state: hold.state, version: hold.version, updated_at: { lte: new Date(+now - 120_000) } },
      data: { version: { increment: 1 }, updated_at: now } });
    if (!claimed.count) continue;
    await reconcileVideoTask(hold.business_id, { now });
    if (+now - +hold.created_at >= 24 * 60 * 60_000) await prisma.$transaction(async tx => {
      const fresh = await tx.creditHold.findUniqueOrThrow({ where: { id: hold.id } });
      if (!['held', 'review'].includes(fresh.state) || fresh.review_notified_at) return;
      await tx.creditHold.updateMany({ where: { id: fresh.id, version: fresh.version, state: fresh.state }, data: { review_notified_at: now, version: { increment: 1 } } });
      await queueBillingAlert(tx, `hold-review:${hold.id}`, { overdue_holds: 1 });
    });
  }
  const deferred = await prisma.videoTask.findMany({ where: { error_code: 'SUBMISSION_AUXILIARY_PENDING' }, take: limit });
  for (const task of deferred) if (await findTaskHold(prisma, task.id)) await repairAcceptedSideEffects(task);
  await runDailyBillingInspection(now);
  await deliverBillingAlerts(now);
  return { examined: holds.length };
}
