import fs from 'node:fs/promises';
import path from 'node:path';
import type { VideoTask } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { createVideoTask, getProviderConfig } from '@/lib/provider/jimeng';
import { createH3VideoJob, H3RequestError, type H3GeneratePayload } from '@/lib/provider/h3';
import { getH3ApiSettings } from '@/lib/integrations/h3';
import { writePrivatePrompt, readPrivatePrompt, type PrivateOrigin } from '@/lib/security/private-prompts.server';
import { beginRetry, markRetrySent, acceptRetry, planRetry, finishRetry, readRetry, retryHash, advanceRetry, mutateRetry } from './store';
import { retryFailure, RETRY_TASK_PREFIX, type RetryFailure } from './contracts';
import { createProviderApiRequest, markProviderApiRequestAccepted, markProviderApiRequestFailed } from '@/lib/costs/ledger';
import type { SessionUser } from '@/lib/auth/session';

type SeedanceInput = Parameters<typeof createVideoTask>[0];
export type FrozenVideoRetryInput = { provider: 'seedance' | 'h3'; input: SeedanceInput | H3GeneratePayload;
  privateOrigins: PrivateOrigin[]; sensitiveRecipe: boolean; credentialHash: string; baseUrl: string };
export class SafeVideoPending extends Error {
  constructor(public state: 'retry_wait' | 'submission_unknown') { super(state); }
}
const payloadPath = (id: string) => {
  if (!/^[A-Za-z0-9-]{1,120}$/.test(id)) throw new Error('retry_invalid_identity');
  return path.join(process.cwd(), 'storage', 'generation-retry', id, 'video-input.json');
};
const binding = (id: string, origins: PrivateOrigin[], part: number) => origins.length
  ? { kind: 'video-task', id, field: `retry-input-${part}`, origins } : null;

export async function freezeVideoRetry(task: VideoTask, input: Omit<FrozenVideoRetryInput, 'credentialHash' | 'baseUrl'>) {
  const h3 = input.provider === 'h3' ? await getH3ApiSettings() : null;
  const baseUrl = h3?.base_url || getProviderConfig().baseUrl;
  const credentialHash = retryHash(`${baseUrl}\n${h3?.api_token || process.env.SEEDANCE_API_KEY || ''}`);
  const frozen: FrozenVideoRetryInput = { ...input, baseUrl, credentialHash };
  const serialized = JSON.stringify(frozen), chunks: string[] = [];
  for (let start = 0; start < serialized.length; start += 500000) chunks.push(writePrivatePrompt(serialized.slice(start, start + 500000), binding(task.id, input.privateOrigins, chunks.length)));
  const file = payloadPath(task.id);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const handle = await fs.open(file, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify({ origins: input.privateOrigins, chunks })); await handle.sync(); } finally { await handle.close(); }
  const dir = await fs.open(path.dirname(file), 'r'); try { await dir.sync(); } finally { await dir.close(); }
  await prisma.$transaction(async tx => {
    await beginRetry({ kind: 'video', taskId: task.id, ownerId: task.owner_user_id || task.user_id!, inputHash: retryHash(serialized),
      scope: { provider: input.provider, protocol: input.provider, endpoint: input.provider === 'h3' ? 'h3.generate' : 'seedance.createVideoTask',
        model: task.model, channel: input.provider, revision: retryHash(`${baseUrl}\n${task.pricing_snapshot || ''}`), credential: credentialHash } }, tx);
    await tx.videoTask.update({ where: { id: task.id }, data: { local_status: 'retry_submitting' } });
  });
  return frozen;
}
async function readFrozen(task: VideoTask) {
  const stored = JSON.parse(await fs.readFile(payloadPath(task.id), 'utf8')) as { origins: PrivateOrigin[]; chunks: string[] };
  const serialized = stored.chunks.map((chunk, i) => readPrivatePrompt(chunk, binding(task.id, stored.origins, i))).join('');
  const record = await readRetry('video', task.id);
  if (!record || retryHash(serialized) !== record.value.inputHash) throw new Error('retry_frozen_input_changed');
  return JSON.parse(serialized) as FrozenVideoRetryInput;
}

export async function handleVideoRetryFailure(task: VideoTask, failure: RetryFailure) {
  return prisma.$transaction(async tx => {
    const current = await tx.videoTask.findUnique({ where: { id: task.id } });
    if (!current || current.actual_cost !== null || current.refund_amount !== null
      || current.provider_task_id !== task.provider_task_id || ['succeeded', 'failed', 'cancelled'].includes(current.local_status)) return false;
    const scheduled = await planRetry(tx, 'video', task.id, failure, (current.frozen_cost || 0) >= (current.estimated_cost || 0));
    if (scheduled) await tx.videoTask.update({ where: { id: task.id }, data: { local_status: 'retry_wait',
      error_code: 'SAFE_RETRY_WAIT', error_message: '等待安全自动重试；保留原费用预留。' } });
    return scheduled;
  });
}

export async function dispatchFrozenVideoRetry(task: VideoTask, frozen: FrozenVideoRetryInput,
  onDiagnostic?: Parameters<typeof createVideoTask>[1]) {
  const record = await readRetry('video', task.id);
  if (!record) throw new Error('retry_record_missing');
  const attempt = record.value.attempts.at(-1)!;
  const h3 = frozen.provider === 'h3' ? await getH3ApiSettings() : null;
  const baseUrl = h3?.base_url || getProviderConfig().baseUrl;
  if (retryHash(`${baseUrl}\n${h3?.api_token || process.env.SEEDANCE_API_KEY || ''}`) !== frozen.credentialHash
    || h3 && !h3.enabled) throw new Error('retry_frozen_provider_changed');
  const owner = await prisma.user.findUnique({ where: { id: record.value.ownerId } });
  if (!owner || owner.status !== 'active' || owner.expires_at && owner.expires_at <= new Date()
    || !['admin', 'user'].includes(owner.role) || !['internal', 'external'].includes(owner.account_type)
    || task.retention_status !== 'active') throw new Error('retry_owner_unavailable');
  const actor: SessionUser = { ...owner, role: owner.role as SessionUser['role'], account_type: owner.account_type as SessionUser['account_type'], status: 'active' };
  // Reuse original authorization checks without consuming another approval or reserve.
  if (attempt.ordinal > 0 && task.project_id) {
    const { getProjectForGeneration } = await import('@/lib/projects/permissions');
    await getProjectForGeneration(actor, task.project_id);
    if (task.video_card_id) {
      const { assertCanGenerateInVideoCard } = await import('@/lib/video-cards/permissions');
      await assertCanGenerateInVideoCard(actor, task.project_id, task.video_card_id);
    }
  }
  if (attempt.ordinal > 0) {
    const allocations = JSON.parse(task.credit_freeze_snapshot || '[]') as Array<{ expires_at?: string | null }>;
    if (allocations.some(a => a.expires_at && Date.parse(a.expires_at) <= Date.now())) throw new Error('retry_original_budget_expired');
    const { assertCanUseReferenceImage } = await import('@/lib/reference-albums/permissions');
    for (const id of JSON.parse(task.reference_image_ids || '[]') as string[]) await assertCanUseReferenceImage(actor, id);
  }
  await markRetrySent('video', task.id);
  try {
    const result = frozen.provider === 'h3'
      ? await createH3VideoJob({ ...frozen.input as H3GeneratePayload,
          metadata: { ...(frozen.input as H3GeneratePayload).metadata, external_task_id: attempt.key } },
        { baseUrl: frozen.baseUrl, apiToken: h3?.api_token || undefined, idempotencyKey: attempt.key, privateOrigins: frozen.privateOrigins, signal: AbortSignal.timeout(300000) })
      : await createVideoTask({ ...frozen.input as SeedanceInput, clientRequestId: attempt.key, client_request_id: attempt.key }, onDiagnostic,
        { sensitiveRecipe: frozen.sensitiveRecipe, privateOrigins: frozen.privateOrigins, signal: AbortSignal.timeout(300000) });
    // The provider id and attempt receipt are durable before returning to any
    // HTTP caller. Later diagnostics cannot turn an accepted POST into a resend.
    await acceptRetry('video', task.id, result.provider_task_id);
    await prisma.videoTask.updateMany({ where: { id: task.id, local_status: 'retry_submitting' }, data: {
      provider_task_id: result.provider_task_id, local_status: 'submitted', error_code: null, error_message: null } });
    return result;
  } catch (error) {
    const failure = (error as { retryFailure?: RetryFailure }).retryFailure
      || (error instanceof H3RequestError ? retryFailure(error.raw, error.statusCode || null) : null);
    if (failure && await handleVideoRetryFailure(task, failure)) throw new SafeVideoPending('retry_wait');
    const latest = await readRetry('video', task.id);
    if (latest?.value.attempts.at(-1)?.providerTaskId) {
      const providerTaskId = latest.value.attempts.at(-1)!.providerTaskId!;
      await prisma.videoTask.updateMany({ where: { id: task.id, local_status: { in: ['retry_submitting', 'submitted'] } },
        data: { provider_task_id: providerTaskId, local_status: 'submitted' } });
      throw new SafeVideoPending('submission_unknown');
    }
    if (latest?.value.attempts.at(-1)?.state === 'free_failed') throw error;
    await finishRetry('video', task.id, 'unknown');
    await prisma.videoTask.updateMany({ where: { id: task.id, provider_task_id: task.provider_task_id,
      local_status: { notIn: ['succeeded', 'failed', 'cancelled'] } }, data: { local_status: 'submission_unknown',
      error_code: 'SAFE_RETRY_SUBMISSION_UNKNOWN', error_message: '原提交结果或费用待核对，保留原预留；不会重新发送。' } });
    throw new SafeVideoPending('submission_unknown');
  }
}

export async function processVideoRetries(shouldStop: () => boolean = () => false) {
  await (await import('./control')).closeDisabledRetryWaits();
  const ready: VideoTask[] = [];
  const abandoned = await prisma.videoTask.findMany({ where: { local_status: 'retry_submitting', updated_at: { lt: new Date(Date.now() - 10 * 60_000) } }, take: 20 });
  for (const task of abandoned) {
    const record = await readRetry('video', task.id);
    if (!record) continue;
    const attempt = record.value.attempts.at(-1)!;
    if (attempt.providerTaskId) {
      await prisma.videoTask.updateMany({ where: { id: task.id, local_status: 'retry_submitting' }, data: { provider_task_id: attempt.providerTaskId, local_status: 'submitted' } });
    } else if (attempt.state === 'prepared') {
      const claimed = await prisma.videoTask.updateMany({ where: { id: task.id, local_status: 'retry_submitting', updated_at: task.updated_at }, data: { updated_at: new Date() } });
      if (claimed.count) ready.push(task);
    } else if (attempt.state === 'free_failed') {
      await (await import('./control')).stopTaskRetries('video', task.id, record.value.ownerId);
    } else {
      await finishRetry('video', task.id, 'unknown');
      await prisma.videoTask.updateMany({ where: { id: task.id, local_status: 'retry_submitting' }, data: {
        local_status: 'submission_unknown', error_code: 'SAFE_RETRY_SUBMISSION_UNKNOWN', error_message: '发送过程已中断，原尝试待核对；未重新发送。' } });
    }
  }
  const rows = await prisma.platformSetting.findMany({ where: { key: { startsWith: `${RETRY_TASK_PREFIX}video:` },
    value_json: { contains: '"state":"wait"' } }, orderBy: { updated_at: 'asc' }, take: 20 });
  for (const row of rows) {
    const taskId = row.key.slice(`${RETRY_TASK_PREFIX}video:`.length);
    const task = await prisma.$transaction(async tx => {
      const current = await tx.videoTask.findUnique({ where: { id: taskId } });
      if (!current || current.local_status !== 'retry_wait') return null;
      if (!await advanceRetry(tx, 'video', taskId)) return null;
      return tx.videoTask.update({ where: { id: taskId }, data: { local_status: 'retry_submitting', provider_task_id: null,
        provider_status: null, raw_create_response: null, raw_status_response: null, provider_client_request_id: null } });
    });
    if (task) ready.push(task);
  }
  for (const task of ready) {
    if (shouldStop()) break;
    const taskId = task.id;
    let requestId: string | null = null;
    try {
      const frozen = await readFrozen(task);
      const state = (await readRetry('video', taskId))!.value;
      const request = await createProviderApiRequest({ task, endpoint: state.scope.endpoint, method: 'POST',
        idempotencyKey: state.attempts.at(-1)!.key, requestPayload: { safe_retry: true, ordinal: state.attempts.length - 1 } });
      requestId = request.id;
      const result = await dispatchFrozenVideoRetry(task, frozen);
      await prisma.videoTask.updateMany({ where: { id: taskId, local_status: 'retry_submitting' }, data: {
        provider_task_id: result.provider_task_id, raw_create_response: JSON.stringify({ accepted: true }), local_status: 'submitted', error_code: null, error_message: null } });
      await markProviderApiRequestAccepted({ requestId, task, providerTaskId: result.provider_task_id }).catch(() => {
        console.error('[safe-retry] accepted diagnostic deferred; original provider id retained');
      });
    } catch (error) {
      if (requestId) await markProviderApiRequestFailed({ requestId, errorCode: 'SAFE_RETRY_DISPATCH', errorMessage: 'Retry dispatch did not return an accepted receipt' }).catch(() => {
        console.error('[safe-retry] failure diagnostic deferred; original retry state retained');
      });
      if (!(error instanceof SafeVideoPending)) {
        const record = await readRetry('video', taskId);
        if (record && record.value.state !== 'unknown' && (record.value.attempts.at(-1)?.state === 'free_failed'
          || record.value.attempts.at(-1)?.state === 'prepared')) {
          await (await import('./control')).stopTaskRetries('video', taskId, record.value.ownerId);
        } else {
          await finishRetry('video', taskId, 'unknown');
          await prisma.videoTask.updateMany({ where: { id: taskId, local_status: 'retry_submitting' }, data: {
            local_status: 'submission_unknown', error_code: 'SAFE_RETRY_SUBMISSION_UNKNOWN', error_message: '原尝试待核对，未重新发送。' } });
        }
      }
    }
  }
  const accepted = await prisma.platformSetting.findMany({ where: { key: { startsWith: `${RETRY_TASK_PREFIX}video:` },
    OR: [{ value_json: { contains: '"state":"active"' } }, { value_json: { contains: '"state":"unknown"' } }] }, orderBy: { updated_at: 'asc' }, take: 20 });
  for (const row of accepted) {
    if (shouldStop()) break;
    const value = JSON.parse(row.value_json) as import('./store').RetryRecord;
    if (value.attempts.at(-1)?.state !== 'accepted') continue;
    await (await import('@/lib/video/task-finalizer')).finalizeVideoTaskStatus(value.taskId,
      { cacheOnSuccess: false, generateThumbnail: false, providerSignal: AbortSignal.timeout(30000) });
    await prisma.platformSetting.updateMany({ where: { key: row.key, value_json: row.value_json }, data: { updated_at: new Date() } });
  }
}

export async function observeRetryCallback(task: VideoTask, providerTaskId: string | null) {
  if (!providerTaskId) return false;
  const record = await readRetry('video', task.id);
  if (!record) return false;
  const prior = record.value.attempts.find(attempt => attempt.providerTaskId === providerTaskId);
  if (providerTaskId === task.provider_task_id && prior?.state !== 'free_failed') return false;
  if (!prior) return true;
  const { getProviderTaskStatus } = await import('@/lib/provider/video-task-status');
  const status = await getProviderTaskStatus({ ...task, provider_task_id: providerTaskId }, { signal: AbortSignal.timeout(30000) });
  const charge = Number(status.actual_cost);
  if (status.local_status !== 'succeeded' && !(Number.isFinite(charge) && charge > 0)) return true;
  const frozen = await readFrozen(task), serialized = JSON.stringify(status), chunks: string[] = [];
  for (let i = 0; i < serialized.length; i += 500000) chunks.push(writePrivatePrompt(serialized.slice(i, i + 500000), binding(task.id, frozen.privateOrigins, chunks.length)));
  const file = path.join(path.dirname(payloadPath(task.id)), `late-attempt-${prior.ordinal}.json`);
  await fs.writeFile(file, JSON.stringify({ origins: frozen.privateOrigins, chunks }), { mode: 0o600 });
  await mutateRetry('video', task.id, async (value, db) => {
    value.stopped = true; value.state = 'unknown';
    await db.videoTask.updateMany({ where: { id: task.id, local_status: 'retry_wait' }, data: {
      local_status: 'submission_unknown', error_code: 'SAFE_RETRY_LATE_RESULT',
      error_message: '原尝试出现迟到结果或费用矛盾，结果证据已保留；后续新发已停止，请管理员核对原号。' } });
  });
  return true;
}
