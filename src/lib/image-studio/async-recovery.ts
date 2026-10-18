import { createHash, randomUUID } from 'node:crypto';
import type { ImageStudioTask, Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { canUseCompanyTemplates } from './access';
import { readStudioAsyncReceipt, readStudioRequestReceipt, readStudioDelivery, repairStudioCoreReceipt, hasStudioAcceptedRecoveryIdentity, StudioCoreReceiptError, type StudioAsyncReceipt } from './delivery';
import { studioProviderNextCheckAt, studioProviderWaitBlocked } from './provider-wait';

const PREFIX = 'studio_async_recovery_v1:';
const OBSERVATION_PREFIX = 'studio_async_observation_v1:';
const ACTIVE_RECHECK_PREFIX = 'studio_async_active_recheck_v1:';
const COOLDOWN = 5 * 60_000;
const MAX_ATTEMPTS = 12;
const LEASE_MS = 10 * 60_000;
const UNCONFIRMED = ['uncertain', 'client_disconnected', 'paused', 'canceled'] as const;
type ProviderStatus = typeof UNCONFIRMED[number];
type RecordState = 'scheduled' | 'checking' | 'stopped' | 'complete';
type RecoveryRecord = {
  schema: 'image.async-recovery.v1'; taskId: string; ownerId: string; fingerprint: string;
  channelId: string; configRevision: string; providerTaskId: string; acceptedAt: number; expiresAt?: string;
  requestId: string; binding: string; reason: 'provider_unconfirmed' | 'query_unavailable'; releasedAt: number;
  providerStatus: ProviderStatus | null; state: RecordState; attempts: number; nextCheckAt: number;
  deadlineAt: number; lastRequestedAt: number; leaseToken: string | null; leaseUntil: number | null; stopCode?: string;
  manualOnce: boolean; manualChecks: number;
};
export type StudioAsyncRecoveryView = {
  binding: string; state: RecordState; reason: RecoveryRecord['reason']; providerStatus: ProviderStatus | null;
  attempts: number; maxAttempts: number; nextCheckAt: number | null; deadlineAt: number; canRequestRecheck: boolean;
  providerNotBefore?: number;
};
export class StudioAsyncRecoveryError extends Error {
  constructor(message: string, public readonly status = 409, public readonly code = 'image_async_recheck_unavailable') { super(message); }
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key = (taskId: string) => `${PREFIX}${taskId}`;
function channel(task: ImageStudioTask): { channelId: string; configRevision: string } | null {
  try {
    const snapshot = JSON.parse(task.snapshot_json || '{}'), value = snapshot.imageChannel;
    return value && typeof value.channelId === 'string' && (value.channelId !== 'original' || snapshot.ratioContractVersion === 3) && typeof value.configRevision === 'string'
      ? { channelId: value.channelId, configRevision: value.configRevision } : null;
  } catch { return null; }
}
function activeTask(task: ImageStudioTask) {
  return task.status === 'channel_running' || task.status === 'running' && channel(task)?.channelId === 'original';
}
function binding(task: ImageStudioTask, record: Pick<RecoveryRecord, 'providerTaskId' | 'acceptedAt' | 'expiresAt' | 'requestId'>) {
  return digest([task.id, task.owner_id, task.batch_id, task.fingerprint, task.model, task.prompt, task.context,
    task.snapshot_json, task.reference_ids, task.quality, task.aspect_ratio, task.output_size, task.billing_scope,
    task.billing_mode, task.billing_contract_json, task.unit_credits, task.freeze_snapshot,
    record.providerTaskId, record.acceptedAt, record.expiresAt || null, record.requestId]);
}
function parse(value: string, task?: ImageStudioTask): RecoveryRecord | null {
  try {
    const record = JSON.parse(value) as RecoveryRecord;
    if (record.schema !== 'image.async-recovery.v1' || typeof record.taskId !== 'string' || typeof record.ownerId !== 'string'
      || typeof record.fingerprint !== 'string' || typeof record.channelId !== 'string' || typeof record.configRevision !== 'string'
      || typeof record.providerTaskId !== 'string' || !/^[a-zA-Z0-9_-]{1,180}$/.test(record.providerTaskId)
      || typeof record.requestId !== 'string' || !/^[a-f0-9]{64}$/.test(record.binding)
      || !Number.isFinite(record.acceptedAt) || record.acceptedAt <= 0
      || !Number.isFinite(record.releasedAt) || record.releasedAt < record.acceptedAt
      || !Number.isFinite(record.deadlineAt) || !Number.isFinite(record.nextCheckAt) || !Number.isFinite(record.lastRequestedAt)
      || !Number.isSafeInteger(record.attempts) || record.attempts < 0 || record.attempts > MAX_ATTEMPTS
      || typeof record.manualOnce !== 'boolean' || !Number.isSafeInteger(record.manualChecks) || record.manualChecks < 0
      || !['scheduled', 'checking', 'stopped', 'complete'].includes(record.state)
      || !['provider_unconfirmed', 'query_unavailable'].includes(record.reason)
      || record.providerStatus !== null && !UNCONFIRMED.includes(record.providerStatus)
      || record.expiresAt !== undefined && !Number.isFinite(Date.parse(record.expiresAt))
      || record.deadlineAt !== record.releasedAt + 24 * 60 * 60_000
      || record.state === 'checking' && (typeof record.leaseToken !== 'string' || !Number.isFinite(record.leaseUntil))
      || record.state !== 'checking' && (record.leaseToken !== null || record.leaseUntil !== null)) return null;
    if (task) {
      const frozen = channel(task);
      if (!frozen || record.taskId !== task.id || record.ownerId !== task.owner_id || record.fingerprint !== task.fingerprint
        || record.channelId !== frozen.channelId || record.configRevision !== frozen.configRevision || record.binding !== binding(task, record)) return null;
    }
    return record;
  } catch { return null; }
}
async function evidence(task: ImageStudioTask) {
  const receipt = await readStudioAsyncReceipt(task);
  if (!receipt || receipt.acceptedAt <= 0 || !channel(task)) throw new Error('async_recovery_identity_unavailable');
  const request = await readStudioRequestReceipt(task);
  if (request && (request.fingerprint !== task.fingerprint || request.batchId !== task.batch_id
    || request.channelId !== receipt.channelId || request.configRevision !== receipt.configRevision
    || request.dispatchState === 'held' || request.dispatchState === 'prepared')) throw new Error('async_recovery_request_mismatch');
  const snapshot = JSON.parse(task.snapshot_json || '{}');
  const requestId = request?.localRequestId || (typeof snapshot.requestId === 'string' ? snapshot.requestId : task.batch_id);
  return { receipt, requestId };
}
type ActiveRecheck = { schema: 'image.active-recheck.v1'; taskId: string; ownerId: string; binding: string;
  providerTaskId: string; requestId: string; acceptedAt: number; state: 'scheduled' | 'consumed' | 'done';
  requestedAt: number; leaseToken: string | null };
export type StudioActiveProviderCheck = { state: 'waiting' | 'paused' | 'checking'; availableAt: number | null;
  canRequestRecheck: boolean; requestId: string; binding: string; message: string };
const activeKey = (id: string) => `${ACTIVE_RECHECK_PREFIX}${id}`;
function parseActiveRecheck(value: string, task: ImageStudioTask, receipt: StudioAsyncReceipt, requestId: string): ActiveRecheck | null {
  try {
    const record = JSON.parse(value) as ActiveRecheck;
    return record.schema === 'image.active-recheck.v1' && record.taskId === task.id && record.ownerId === task.owner_id
      && record.providerTaskId === receipt.providerTaskId && record.acceptedAt === receipt.acceptedAt && record.requestId === requestId
      && record.binding === binding(task, { ...receipt, requestId }) && Number.isSafeInteger(record.requestedAt) && record.requestedAt > 0 && record.requestedAt <= Date.now()
      && ['scheduled', 'consumed', 'done'].includes(record.state)
      && (record.state === 'consumed' ? typeof record.leaseToken === 'string' : record.leaseToken === null) ? record : null;
  } catch { return null; }
}
export async function readStudioActiveProviderCheck(task: ImageStudioTask): Promise<StudioActiveProviderCheck | null> {
  if (!activeTask(task)) return null;
  let original;
  try { original = await evidence(task); } catch { return null; }
  if (original.receipt.schema !== 'image.async-receipt.v2') return null;
  if (!await hasStudioAcceptedRecoveryIdentity(task, original.receipt)) return null;
  const receipt = original.receipt, now = Date.now();
  const deadlineAt = receipt.acceptedAt + 24 * 60 * 60_000;
  const row = await prisma.platformSetting.findUnique({ where: { key: activeKey(task.id) } });
  const permit = row && parseActiveRecheck(row.value_json, task, receipt, original.requestId);
  const waiting = studioProviderWaitBlocked(receipt, now);
  const checking = permit?.state === 'scheduled' || permit?.state === 'consumed' && task.lease_token === permit.leaseToken
    && Boolean(task.lease_until && task.lease_until.getTime() > now);
  const availableAt = studioProviderNextCheckAt(permit ? permit.requestedAt + COOLDOWN : now, receipt);
  return { state: checking ? 'checking' : waiting || now < deadlineAt ? 'waiting' : 'paused',
    availableAt: receipt.providerWaitSource === 'invalid-conservative' ? null : availableAt,
    canRequestRecheck: now >= deadlineAt && !waiting && !checking && !task.lease_token && availableAt <= now,
    requestId: original.requestId, binding: binding(task, { ...receipt, requestId: original.requestId }),
    message: checking ? '正在核对同一原任务，未重新生成。' : waiting ? '等待供应商允许核对，原任务和费用预留保留。'
      : now >= deadlineAt ? '自动核对已暂停；可核对同一原任务，原预留和执行名额保留。' : '正在按供应商间隔核对原任务。' };
}
export async function readStudioActiveRecheck(task: ImageStudioTask) {
  const original = await evidence(task);
  if (!activeTask(task) || original.receipt.schema !== 'image.async-receipt.v2'
    || studioProviderWaitBlocked(original.receipt)) return false;
  const row = await prisma.platformSetting.findUnique({ where: { key: activeKey(task.id) } });
  return Boolean(row && parseActiveRecheck(row.value_json, task, original.receipt, original.requestId)?.state === 'scheduled');
}
export async function consumeStudioActiveRecheck(task: ImageStudioTask) {
  const original = await evidence(task);
  if (original.receipt.schema !== 'image.async-receipt.v2' || studioProviderWaitBlocked(original.receipt)) return false;
  return prisma.$transaction(async tx => {
    const current = await tx.imageStudioTask.findUnique({ where: { id: task.id } });
    const user = await tx.user.findUnique({ where: { id: task.owner_id } });
    const row = await tx.platformSetting.findUnique({ where: { key: activeKey(task.id) } });
    const permit = row && parseActiveRecheck(row.value_json, task, original.receipt, original.requestId);
    if (!user || user.status !== 'active' || !canUseCompanyTemplates(user) || !current || !activeTask(current) || current.status !== task.status || !current.lease_token || current.lease_token !== task.lease_token
      || !current.lease_until || current.lease_until.getTime() <= Date.now() || !row || !permit || permit.state !== 'scheduled'
      || !parseActiveRecheck(row.value_json, current, original.receipt, original.requestId)) return false;
    const changed = await tx.platformSetting.updateMany({ where: { id: row.id, value_json: row.value_json },
      data: { value_json: JSON.stringify({ ...permit, state: 'consumed', leaseToken: task.lease_token }) } });
    return Boolean(changed.count);
  });
}
export async function completeStudioActiveRecheck(task: ImageStudioTask) {
  const original = await evidence(task);
  const row = await prisma.platformSetting.findUnique({ where: { key: activeKey(task.id) } });
  const permit = row && parseActiveRecheck(row.value_json, task, original.receipt, original.requestId);
  if (!row || !permit || permit.state !== 'consumed' || permit.leaseToken !== task.lease_token) return;
  await prisma.platformSetting.updateMany({ where: { id: row.id, value_json: row.value_json },
    data: { value_json: JSON.stringify({ ...permit, state: 'done', leaseToken: null }) } });
}
async function requestActiveRecheck(task: ImageStudioTask, bindingOrRequestId: string) {
  const original = await evidence(task);
  if (original.receipt.schema !== 'image.async-receipt.v2' || !await hasStudioAcceptedRecoveryIdentity(task, original.receipt)) {
    throw new StudioAsyncRecoveryError('没有可安全核对的原异步请求；未重新生成');
  }
  const identity = binding(task, { ...original.receipt, requestId: original.requestId });
  if (bindingOrRequestId !== identity && bindingOrRequestId !== original.requestId) throw new StudioAsyncRecoveryError('原请求核对身份不一致');
  const projection = await readStudioActiveProviderCheck(task);
  if (!projection?.canRequestRecheck) return { providerCheck: projection, scheduled: false };
  const now = Date.now();
  return prisma.$transaction(async tx => {
    const current = await tx.imageStudioTask.findUnique({ where: { id: task.id } });
    const row = await tx.platformSetting.findUnique({ where: { key: activeKey(task.id) } });
    const previous = row && parseActiveRecheck(row.value_json, task, original.receipt, original.requestId);
    if (!current || current.owner_id !== task.owner_id || !activeTask(current) || current.status !== task.status || current.lease_token
      || binding(current, { ...original.receipt, requestId: original.requestId }) !== identity
      || original.receipt.acceptedAt + 24 * 60 * 60_000 > now || studioProviderWaitBlocked(original.receipt, now)
      || row && (!previous || previous.state === 'scheduled' || previous.requestedAt + COOLDOWN > now)) {
      return { providerCheck: projection, scheduled: false };
    }
    const next: ActiveRecheck = { schema: 'image.active-recheck.v1', taskId: task.id, ownerId: task.owner_id, binding: identity,
      providerTaskId: original.receipt.providerTaskId, requestId: original.requestId, acceptedAt: original.receipt.acceptedAt,
      requestedAt: now, state: 'scheduled', leaseToken: null };
    if (row) {
      const changed = await tx.platformSetting.updateMany({ where: { id: row.id, value_json: row.value_json }, data: { value_json: JSON.stringify(next) } });
      if (!changed.count) return { providerCheck: projection, scheduled: false };
    } else await tx.platformSetting.create({ data: { key: activeKey(task.id), value_json: JSON.stringify(next), updated_by: task.owner_id } });
    const changed = await tx.imageStudioTask.updateMany({ where: { id: task.id, owner_id: task.owner_id, status: task.status,
      lease_token: null, lease_until: current.lease_until, fingerprint: task.fingerprint }, data: { lease_until: new Date(now) } });
    if (!changed.count) throw new ClaimLost();
    return { providerCheck: { ...projection, state: 'checking' as const, canRequestRecheck: false }, scheduled: true };
  });
}
function matches(record: RecoveryRecord, receipt: StudioAsyncReceipt, requestId: string) {
  return record.providerTaskId === receipt.providerTaskId && record.acceptedAt === receipt.acceptedAt
    && record.expiresAt === receipt.expiresAt && record.requestId === requestId;
}
function view(record: RecoveryRecord, task: ImageStudioTask, receipt?: StudioAsyncReceipt): StudioAsyncRecoveryView {
  return { binding: record.binding, state: record.manualOnce && record.state === 'stopped' ? 'scheduled' : record.state,
    reason: record.reason, providerStatus: record.providerStatus,
    attempts: record.attempts, maxAttempts: MAX_ATTEMPTS, deadlineAt: record.deadlineAt,
    nextCheckAt: ['scheduled', 'checking'].includes(record.state) ? studioProviderNextCheckAt(record.nextCheckAt, receipt) : null,
    ...(receipt?.providerNotBefore ? { providerNotBefore: receipt.providerNotBefore } : {}),
    canRequestRecheck: task.status === 'uncertain' && !record.manualOnce
      && (record.state === 'scheduled' || record.state === 'stopped' && ['auto_budget', 'deadline'].includes(record.stopCode || ''))
      && record.lastRequestedAt + COOLDOWN <= Date.now() && !studioProviderWaitBlocked(receipt) };
}
export async function readStudioAsyncRecovery(task: ImageStudioTask): Promise<StudioAsyncRecoveryView | null> {
  const row = await prisma.platformSetting.findUnique({ where: { key: key(task.id) } });
  const record = row && parse(row.value_json, task);
  if (!record) return null;
  try { const original = await evidence(task); return matches(record, original.receipt, original.requestId) ? view(record, task, original.receipt) : null; }
  catch { return null; } // Unreadable or mismatched evidence never grants recovery authority.
}

/** Retention only, never query/settlement authority. Do not make preservation of
 * the only local output depend on a successful read of that output's receipts. */
export async function retainStudioAsyncCheckpoint(task: ImageStudioTask): Promise<boolean> {
  const row = await prisma.platformSetting.findUnique({ where: { key: key(task.id) } });
  if (!row) return false;
  const record = parse(row.value_json, task);
  if (!record) throw new Error('async_recovery_retention_identity_unavailable');
  return record.state === 'scheduled' || record.state === 'checking' || record.manualOnce;
}

/** Only exact upstream JSON statuses release an execution slot. expiresAt is not task-retention evidence. */
export function studioAsyncReleaseReason(receipt: StudioAsyncReceipt, detail?: { code: string; poll?: { lastProviderStatus: unknown; lastHttpStatus: number | null } }) {
  if (!receipt.providerTaskId || !Number.isFinite(receipt.acceptedAt) || receipt.acceptedAt <= 0) return null;
  if (detail?.code === 'async_unconfirmed' && detail.poll?.lastHttpStatus != null
    && detail.poll.lastHttpStatus >= 200 && detail.poll.lastHttpStatus < 300
    && UNCONFIRMED.includes(detail.poll.lastProviderStatus as ProviderStatus)) return 'provider_unconfirmed' as const;
  return null;
}

type UnavailableObservation = { schema: 'image.async-observation.v1'; binding: string; firstSeen: number; lastSeen: number; count: number; window: string };
function observation(value: string): UnavailableObservation | null {
  try { const record = JSON.parse(value) as UnavailableObservation;
    return record.schema === 'image.async-observation.v1' && /^[a-f0-9]{64}$/.test(record.binding)
      && Number.isFinite(record.firstSeen) && Number.isFinite(record.lastSeen) && record.lastSeen >= record.firstSeen
      && Number.isInteger(record.count) && record.count >= 1 && record.count <= 2 && typeof record.window === 'string'
      ? record : null;
  } catch { return null; }
}
/** Two independent original-summary windows, not two GETs within one polling window. */
export async function observeStudioAsyncQueryUnavailable(task: ImageStudioTask, receipt: StudioAsyncReceipt,
  detail?: { code: string; poll?: { summaryNotFound?: true; lastHttpStatus: number | null; lastAttemptPhase: string | null } }) {
  const now = Date.now();
  if (!activeTask(task) || !task.lease_token || receipt.acceptedAt + 24 * 60 * 60_000 >= now
    || !detail || !['async_query_interrupted', 'async_query_unconfirmed'].includes(detail.code)
    || !detail.poll?.summaryNotFound || detail.poll.lastHttpStatus !== 404 || detail.poll.lastAttemptPhase !== 'summary_request') return false;
  const original = await evidence(task);
  if (original.receipt.providerTaskId !== receipt.providerTaskId || original.receipt.acceptedAt !== receipt.acceptedAt) return false;
  const identity = binding(task, { ...receipt, requestId: original.requestId });
  return prisma.$transaction(async tx => {
    const current = await tx.imageStudioTask.findUnique({ where: { id: task.id } });
    if (!current || !activeTask(current) || current.status !== task.status || current.lease_token !== task.lease_token
      || !current.lease_until || current.lease_until.getTime() <= now
      || binding(current, { ...receipt, requestId: original.requestId }) !== identity) return false;
    const row = await tx.platformSetting.findUnique({ where: { key: `${OBSERVATION_PREFIX}${task.id}` } });
    const prior = row && observation(row.value_json);
    if (row && (!prior || prior.binding !== identity)) return false;
    if (prior && (prior.window === digest(task.lease_token) || prior.lastSeen + 30_000 > now)) return prior.count >= 2;
    const next: UnavailableObservation = { schema: 'image.async-observation.v1', binding: identity,
      firstSeen: prior?.firstSeen || now, lastSeen: now, count: Math.min(2, (prior?.count || 0) + 1), window: digest(task.lease_token) };
    if (row) { const saved = await tx.platformSetting.updateMany({ where: { id: row.id, value_json: row.value_json }, data: { value_json: JSON.stringify(next) } });
      if (!saved.count) return false;
    } else await tx.platformSetting.create({ data: { key: `${OBSERVATION_PREFIX}${task.id}`, value_json: JSON.stringify(next), updated_by: task.owner_id } });
    return next.count >= 2 && next.lastSeen - next.firstSeen >= 30_000;
  });
}

/** Task CAS and durable recovery intent are committed together. No refund or upstream request. */
export async function releaseStudioAsyncSlot(task: ImageStudioTask, receipt: StudioAsyncReceipt,
  reason: RecoveryRecord['reason'], providerStatus: unknown = null) {
  if (!activeTask(task) || reason === 'provider_unconfirmed' && !UNCONFIRMED.includes(providerStatus as ProviderStatus)) return false;
  const original = await evidence(task);
  if (original.receipt.state === 'failed' || original.receipt.providerTaskId !== receipt.providerTaskId
    || original.receipt.acceptedAt !== receipt.acceptedAt || original.receipt.expiresAt !== receipt.expiresAt) return false;
  const now = Date.now();
  const record: RecoveryRecord = { schema: 'image.async-recovery.v1', taskId: task.id, ownerId: task.owner_id,
    fingerprint: task.fingerprint, channelId: receipt.channelId, configRevision: receipt.configRevision,
    providerTaskId: receipt.providerTaskId, acceptedAt: receipt.acceptedAt, expiresAt: receipt.expiresAt,
    requestId: original.requestId, binding: '', reason, releasedAt: now, providerStatus: UNCONFIRMED.includes(providerStatus as ProviderStatus) ? providerStatus as ProviderStatus : null,
    state: 'scheduled', attempts: 0, nextCheckAt: studioProviderNextCheckAt(now + COOLDOWN, receipt),
    deadlineAt: now + 24 * 60 * 60_000,
    lastRequestedAt: now, leaseToken: null, leaseUntil: null, manualOnce: false, manualChecks: 0 };
  if (receipt.schema === 'image.async-receipt.v2' && receipt.acceptedAt + 24 * 60 * 60_000 <= now) {
    record.state = 'stopped'; record.stopCode = 'deadline'; // A manual late observation never starts a fresh automatic budget.
  }
  record.binding = binding(task, record);
  return prisma.$transaction(async tx => {
    const current = await tx.imageStudioTask.findUnique({ where: { id: task.id } });
    if (!current || !parse(JSON.stringify(record), current) || current.billing_settled_at || current.actual_credits !== null) return false;
    const previous = await tx.platformSetting.findUnique({ where: { key: key(task.id) } });
    if (previous) return false; // Never reset a prior recovery's identity, deadline or attempt budget.
    if (reason === 'query_unavailable') {
      const row = await tx.platformSetting.findUnique({ where: { key: `${OBSERVATION_PREFIX}${task.id}` } });
      const observed = row && observation(row.value_json);
      if (!observed || observed.binding !== record.binding || observed.count !== 2 || observed.window !== digest(task.lease_token)
        || observed.lastSeen - observed.firstSeen < 30_000 || receipt.acceptedAt + 24 * 60 * 60_000 >= now) return false;
    }
    const changed = await tx.imageStudioTask.updateMany({ where: { id: task.id, owner_id: task.owner_id, status: task.status,
      fingerprint: task.fingerprint, lease_token: task.lease_token, lease_until: { gt: new Date(now) } },
      data: { status: 'uncertain', lease_token: null, lease_until: null, finished_at: new Date(now),
        error: reason === 'query_unavailable' ? '原号多次查询暂不可用，已退出执行队列；结果和费用仍待确认，将低频核对原号，未取消或重新生成。'
          : '原供应商状态待核对，已退出执行队列；原任务与费用预留保留，将低频核对同一原号。' } });
    if (!changed.count) return false;
    await tx.platformSetting.create({ data: { key: key(task.id), value_json: JSON.stringify(record), updated_by: task.owner_id } });
    return true;
  });
}

export async function requestStudioAsyncRecheck(ownerId: string, id: string, bindingOrRequestId: string) {
  const task = await prisma.imageStudioTask.findFirst({ where: { id, owner_id: ownerId } });
  const user = await prisma.user.findUnique({ where: { id: ownerId } });
  if (!task || !user || user.status !== 'active' || !canUseCompanyTemplates(user)) throw new StudioAsyncRecoveryError('原任务不存在或无权核对', 404);
  if (activeTask(task)) return requestActiveRecheck(task, bindingOrRequestId);
  const original = await evidence(task).catch(() => null);
  return prisma.$transaction(async tx => {
    const current = await tx.imageStudioTask.findUnique({ where: { id } });
    const row = await tx.platformSetting.findUnique({ where: { key: key(id) } });
    const record = current && row && parse(row.value_json, current);
    if (!current || current.owner_id !== ownerId || !row || !record || !original || !matches(record, original.receipt, original.requestId)
      || bindingOrRequestId !== record.binding && bindingOrRequestId !== record.requestId) throw new StudioAsyncRecoveryError('没有可安全核对的原异步请求；未重新生成');
    const projection = view(record, current, original.receipt);
    if (!projection.canRequestRecheck) return { recovery: projection, scheduled: false };
    const next = { ...record, manualOnce: true, nextCheckAt: studioProviderNextCheckAt(Date.now(), original.receipt), lastRequestedAt: Date.now() };
    const changed = await tx.platformSetting.updateMany({ where: { id: row.id, value_json: row.value_json }, data: { value_json: JSON.stringify(next) } });
    return { recovery: view(changed.count ? next : record, current, original.receipt), scheduled: Boolean(changed.count) };
  });
}

export type StudioAsyncRecoveryClaim = { task: ImageStudioTask; receipt: StudioAsyncReceipt; deadlineAt: number; manualOnce: boolean; localOnly: boolean };
let sweep: { cursor: string | null; ceiling: string } | null = null;
class ClaimLost extends Error {}
export async function claimStudioAsyncRecovery(options: { acceptedOnly?: boolean } = {}): Promise<StudioAsyncRecoveryClaim | null> {
  const eligible: Prisma.PlatformSettingWhereInput = { key: { startsWith: PREFIX }, OR: [
    { value_json: { contains: '"state":"scheduled"' } }, { value_json: { contains: '"state":"checking"' } },
    { value_json: { contains: '"manualOnce":true' } },
  ] };
  if (!sweep) { const last = await prisma.platformSetting.findFirst({ where: eligible, orderBy: { key: 'desc' }, select: { key: true } });
    if (!last) return null; sweep = { cursor: null, ceiling: last.key }; }
  const bounds = sweep;
  const rows = await prisma.platformSetting.findMany({ where: { ...eligible, key: { startsWith: PREFIX, lte: bounds.ceiling,
    ...(bounds.cursor ? { gt: bounds.cursor } : {}) } }, orderBy: { key: 'asc' }, take: 32 });
  if (!rows.length) { sweep = null; return null; }
  for (const row of rows.slice(0, 10)) {
    bounds.cursor = row.key;
    const parsed = parse(row.value_json);
    if (!parsed || key(parsed.taskId) !== row.key || parsed.nextCheckAt > Date.now() && parsed.deadlineAt > Date.now()
      || parsed.state === 'checking' && (parsed.leaseUntil || 0) > Date.now()) continue;
    const task = await prisma.imageStudioTask.findUnique({ where: { id: parsed.taskId } });
    const record = task && parse(row.value_json, task);
    if (!task || !record || task.status !== 'uncertain' || task.billing_settled_at || task.actual_credits !== null) continue;
    let original;
    try { await repairStudioCoreReceipt(task); original = await evidence(task); } catch (error) {
      if (error instanceof StudioCoreReceiptError && error.code === 'core_receipt_pending') {
        await prisma.platformSetting.updateMany({ where: { id: row.id, value_json: row.value_json },
          data: { value_json: JSON.stringify({ ...record, state: 'scheduled', nextCheckAt: Date.now() + COOLDOWN,
            leaseToken: null, leaseUntil: null }) } });
        continue;
      }
      await prisma.platformSetting.updateMany({ where: { id: row.id, value_json: row.value_json },
        data: { value_json: JSON.stringify({ ...record, state: 'stopped', stopCode: 'original_evidence_unavailable', manualOnce: false, leaseToken: null, leaseUntil: null }) } });
      continue;
    }
    if (!matches(record, original.receipt, original.requestId)) continue;
    if (options.acceptedOnly && !await hasStudioAcceptedRecoveryIdentity(task, original.receipt)) continue;
    const localCompletion = await readStudioDelivery(task).then(value => Boolean(value?.complete)).catch(() => false);
    // Waiting is checked before claim, so it cannot consume an automatic/manual network attempt.
    if (!record.manualOnce && record.deadlineAt <= Date.now() && !localCompletion) {
      await prisma.platformSetting.updateMany({ where: { id: row.id, value_json: row.value_json },
        data: { value_json: JSON.stringify({ ...record, state: 'stopped', stopCode: 'deadline', manualOnce: false, leaseToken: null, leaseUntil: null }) } });
      continue;
    }
    if (studioProviderWaitBlocked(original.receipt) && !localCompletion) {
      await prisma.platformSetting.updateMany({ where: { id: row.id, value_json: row.value_json },
        data: { value_json: JSON.stringify({ ...record, state: 'scheduled', nextCheckAt: studioProviderNextCheckAt(record.nextCheckAt, original.receipt), leaseToken: null, leaseUntil: null }) } });
      continue;
    }
    // A crashed manual GET is consumed, not automatically issued again. Its
    // result is unknown; only a later explicit, cooled-down action can ask again.
    if (record.state === 'checking' && record.manualOnce) {
      await prisma.$transaction(async tx => {
        const current = await tx.imageStudioTask.findUnique({ where: { id: task.id } });
        if (!current || !parse(row.value_json, current) || current.status !== 'uncertain'
          || current.lease_token !== record.leaseToken || !current.lease_until || current.lease_until.getTime() > Date.now()) return;
        const stopped = record.attempts >= MAX_ATTEMPTS || record.deadlineAt <= Date.now();
        const saved = await tx.platformSetting.updateMany({ where: { id: row.id, value_json: row.value_json }, data: { value_json: JSON.stringify({
          ...record, state: stopped ? 'stopped' : 'scheduled', manualOnce: false, leaseToken: null, leaseUntil: null,
          nextCheckAt: Math.min(record.deadlineAt, Date.now() + COOLDOWN),
          ...(stopped ? { stopCode: record.attempts >= MAX_ATTEMPTS ? 'auto_budget' : 'deadline' } : {}),
        }) } });
        if (!saved.count) return;
        const cleared = await tx.imageStudioTask.updateMany({ where: { id: current.id, status: 'uncertain', lease_token: record.leaseToken,
          lease_until: current.lease_until }, data: { lease_token: null, lease_until: null } });
        if (!cleared.count) throw new ClaimLost();
      });
      continue;
    }
    // The twelfth network attempt may have durably finished downloading just
    // before a crash. Reclaim only local completion, never another query.
    const localOnly = localCompletion || record.state === 'checking' && record.attempts === MAX_ATTEMPTS && !record.manualOnce;
    if (record.attempts >= MAX_ATTEMPTS && !record.manualOnce && !localOnly) {
      await prisma.platformSetting.updateMany({ where: { id: row.id, value_json: row.value_json },
        data: { value_json: JSON.stringify({ ...record, state: 'stopped', stopCode: 'auto_budget', leaseToken: null, leaseUntil: null }) } });
      continue;
    }
    const token = randomUUID(), now = Date.now(), leaseUntil = now + LEASE_MS;
    try {
      const claimed = await prisma.$transaction(async tx => {
        const current = await tx.imageStudioTask.findUnique({ where: { id: task.id } });
        if (!current || !parse(row.value_json, current) || current.status !== 'uncertain' || current.billing_settled_at
          || current.actual_credits !== null || current.lease_until && current.lease_until.getTime() > now) throw new ClaimLost();
        const held = { ...record, state: 'checking', attempts: record.manualOnce || localOnly ? record.attempts : record.attempts + 1,
          manualChecks: record.manualChecks + (record.manualOnce ? 1 : 0), lastRequestedAt: now,
          leaseToken: token, leaseUntil, nextCheckAt: leaseUntil };
        const changed = await tx.platformSetting.updateMany({ where: { id: row.id, value_json: row.value_json }, data: { value_json: JSON.stringify(held) } });
        if (!changed.count) throw new ClaimLost();
        const leased = await tx.imageStudioTask.updateMany({ where: { id: current.id, status: 'uncertain', lease_token: current.lease_token,
          lease_until: current.lease_until, fingerprint: current.fingerprint }, data: { lease_token: token, lease_until: new Date(leaseUntil) } });
        if (!leased.count) throw new ClaimLost();
        return { ...current, lease_token: token, lease_until: new Date(leaseUntil) };
      });
      return { task: claimed, receipt: original.receipt, deadlineAt: record.deadlineAt, manualOnce: record.manualOnce, localOnly };
    } catch (error) { if (!(error instanceof ClaimLost)) throw error; }
  }
  if (rows.length <= 10) sweep = null;
  return null;
}

/** Used only by finishStudioTask's original transaction; arbitrary legacy uncertain is not accepted. */
export async function studioAsyncRecoveryLease(tx: Prisma.TransactionClient, task: ImageStudioTask) {
  const row = await tx.platformSetting.findUnique({ where: { key: key(task.id) } });
  const current = await tx.imageStudioTask.findUnique({ where: { id: task.id } });
  const record = row && parse(row.value_json, task);
  return row && record && current && parse(row.value_json, current) && current.status === 'uncertain'
    && current.lease_token === task.lease_token && current.lease_until && current.lease_until.getTime() > Date.now()
    && !current.billing_settled_at && current.actual_credits === null && record.state === 'checking' && record.leaseToken === task.lease_token
    && (record.leaseUntil || 0) > Date.now() && !task.billing_settled_at && task.actual_credits === null ? { row, record } : null;
}
export async function completeStudioAsyncRecovery(tx: Prisma.TransactionClient, task: ImageStudioTask) {
  const held = await studioAsyncRecoveryLease(tx, task);
  if (!held) throw new Error('async_recovery_finish_identity_lost');
  const changed = await tx.platformSetting.updateMany({ where: { id: held.row.id, value_json: held.row.value_json },
    data: { value_json: JSON.stringify({ ...held.record, state: 'complete', manualOnce: false, leaseToken: null, leaseUntil: null }) } });
  if (!changed.count) throw new Error('async_recovery_finish_cas_lost');
}
/** Finally-path also covers unexpected return/throw. Crashes retain an expiring durable lease. */
export async function deferStudioAsyncRecovery(task: ImageStudioTask, code: string, stop = false) {
  const receipt = await readStudioAsyncReceipt(task);
  return prisma.$transaction(async tx => {
    const held = await studioAsyncRecoveryLease(tx, task);
    if (!held) return;
    const now = Date.now(), record = held.record;
    const stopped = stop || record.attempts >= MAX_ATTEMPTS || record.deadlineAt <= now;
    const stopCode = stop ? code === 'query_budget' ? 'deadline' : code
      : record.attempts >= MAX_ATTEMPTS ? 'auto_budget' : 'deadline';
    const delay = [5, 15, 30, 60][Math.min(3, record.attempts)] * 60_000;
    const changed = await tx.imageStudioTask.updateMany({ where: { id: task.id, status: 'uncertain', lease_token: task.lease_token,
      lease_until: { gt: new Date(now) } }, data: { lease_token: null, lease_until: null,
      error: stopped ? '原请求自动核对已停止，结果和费用仍待确认；原记录及预留保留，未重新生成。'
        : '原请求仍待核对，将低频查询同一原号；费用预留保持，未重新生成。' } });
    if (!changed.count) return;
    const saved = await tx.platformSetting.updateMany({ where: { id: held.row.id, value_json: held.row.value_json }, data: { value_json: JSON.stringify({
      ...record, state: stopped ? 'stopped' : 'scheduled', nextCheckAt: studioProviderNextCheckAt(now + delay, receipt),
      leaseToken: null, leaseUntil: null, manualOnce: false, ...(stopped ? { stopCode } : {}),
    }) } });
    if (!saved.count) throw new Error('async_recovery_defer_cas_lost');
  });
}
