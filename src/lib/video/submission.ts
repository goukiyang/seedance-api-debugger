import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { transitionVideoTask } from './task-state';

export type SubmissionResult<T> = { state: 'accepted'; value: T } | { state: 'rejected' | 'unknown'; error: unknown; value?: T };
export function isExplicitProviderRejection(error: unknown) {
  const candidate = error as { statusCode?: number; status?: number; httpStatus?: number } | null;
  const status = candidate?.statusCode ?? candidate?.status ?? candidate?.httpStatus;
  return typeof status === 'number' && status >= 400 && status < 500 && ![408, 409, 425, 429].includes(status);
}
export class ProviderSubmissionError extends Error {
  constructor(public outcome: 'rejected' | 'unknown', public cause: unknown, public providerTaskId?: string) { super(outcome === 'unknown' ? '提交待确认，请勿重复提交' : '供应商明确拒绝'); }
}
export async function submitToProvider<T extends { provider_task_id: string }>(input: {
  taskId: string; send: () => Promise<T>; acceptedPatch?: (value: T) => Prisma.VideoTaskUncheckedUpdateInput;
}): Promise<SubmissionResult<T>> {
  const before = await prisma.videoTask.findUniqueOrThrow({ where: { id: input.taskId } });
  // The durable CAS happens before any network side effect. Retrying a reader
  // cannot submit an existing/unknown operation a second time.
  if (before.local_status !== 'created') return { state: 'unknown', error: new Error('AUD_VIDEO_ALREADY_DISPATCHED') };
  const started = await transitionVideoTask(input.taskId, before, 'submitting');
  if (!started.changed) return { state: 'unknown', error: new Error('AUD_VIDEO_DISPATCH_CONFLICT') };
  let value: T | undefined;
  let sent = false;
  try {
    sent = true;
    value = await input.send();
    if (!value || typeof value.provider_task_id !== 'string' || !value.provider_task_id.trim()) throw new Error('AUD_VIDEO_INVALID_PROVIDER_RESPONSE');
    const accepted = await transitionVideoTask(input.taskId, 'submitting', 'submitted', {
      ...input.acceptedPatch?.(value), provider_task_id: value.provider_task_id,
    });
    if (!accepted.changed) throw new Error('AUD_VIDEO_ACCEPTANCE_NOT_PERSISTED');
    return { state: 'accepted', value };
  } catch (error) {
    const state = sent && !value && isExplicitProviderRejection(error) ? 'rejected' : 'unknown';
    await transitionVideoTask(input.taskId, 'submitting', state === 'rejected' ? 'failed' : 'unknown', {
      ...(value?.provider_task_id ? { provider_task_id: value.provider_task_id } : {}),
      error_code: state === 'unknown' ? 'SUBMISSION_UNCONFIRMED' : 'PROVIDER_CREATE_REJECTED',
      error_message: state === 'unknown' ? '提交待确认，请勿重复提交' : '供应商明确拒绝本次请求',
    }).catch(() => {}); // A crash here leaves submitting, which reconciliation also scans.
    return { state, error, value };
  }
}
export function acceptedSubmission<T>(result: SubmissionResult<T>): T {
  if (result.state !== 'accepted') throw new ProviderSubmissionError(result.state, result.error, (result.value as { provider_task_id?: string } | undefined)?.provider_task_id);
  return result.value;
}

// Auxiliary records cannot revoke acceptance or refund an upstream charge.
export async function recordSubmissionSideEffect(taskId: string, write: () => Promise<unknown>) {
  try { await write(); }
  catch { console.warn('[VideoSubmission] auxiliary record deferred', { taskId });
    await prisma.videoTask.updateMany({ where: { id: taskId, error_code: null },
      data: { error_code: 'SUBMISSION_AUXILIARY_PENDING', error_message: '任务已受理，附属记录待核对' } }).catch(() => {});
  }
}
