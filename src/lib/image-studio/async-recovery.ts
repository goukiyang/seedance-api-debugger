import { createHash, randomUUID } from 'node:crypto';
import type { ImageStudioTask, Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { canUseCompanyTemplates } from './access';
import { readStudioAsyncReceipt, readStudioRequestReceipt, type StudioAsyncReceipt } from './delivery';
import { PRICING_ASYNC_PREFIX, publicPricingTaskState, studioTaskState } from './pricing-state';

const PREFIX = 'studio_async_recovery_v1:';
const OBSERVATION_PREFIX = 'studio_async_observation_v1:';
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
};
export class StudioAsyncRecoveryError extends Error {
  constructor(message: string, public readonly status = 409, public readonly code = 'image_async_recheck_unavailable') { super(message); }
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key = (taskId: string) => `${taskId.startsWith('rate-') ? PRICING_ASYNC_PREFIX : PREFIX}${taskId}`;
function channel(task: ImageStudioTask): { channelId: string; configRevision: string } | null {
  if (task.execution_backend === 'local') return null;
  try {
    const value = JSON.parse(task.snapshot_json || '{}').imageChannel;
    return value && typeof value.channelId === 'string' && value.channelId !== 'original' && typeof value.configRevision === 'string'
      ? { channelId: value.channelId, configRevision: value.configRevision } : null;
  } catch { return null; }
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
function matches(record: RecoveryRecord, receipt: StudioAsyncReceipt, requestId: string) {
  return record.providerTaskId === receipt.providerTaskId && record.acceptedAt === receipt.acceptedAt
    && record.expiresAt === receipt.expiresAt && record.requestId === requestId;
}
function view(record: RecoveryRecord, task: ImageStudioTask): StudioAsyncRecoveryView {
  return { binding: record.binding, state: record.manualOnce && record.state === 'stopped' ? 'scheduled' : record.state,
    reason: record.reason, providerStatus: record.providerStatus,
    attempts: record.attempts, maxAttempts: MAX_ATTEMPTS, deadlineAt: record.deadlineAt,
    nextCheckAt: ['scheduled', 'checking'].includes(record.state) ? record.nextCheckAt : null,
    canRequestRecheck: publicPricingTaskState(task.status) === 'uncertain' && !record.manualOnce
      && (record.state === 'scheduled' || record.state === 'stopped' && ['auto_budget', 'deadline'].includes(record.stopCode || ''))
      && record.lastRequestedAt + COOLDOWN <= Date.now() };
}
export async function readStudioAsyncRecovery(task: ImageStudioTask): Promise<StudioAsyncRecoveryView | null> {
  const row = await prisma.platformSetting.findUnique({ where: { key: key(task.id) } });
  const record = row && parse(row.value_json, task);
  if (!record) return null;
  try { const original = await evidence(task); return matches(record, original.receipt, original.requestId) ? view(record, task) : null; }
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
  if (publicPricingTaskState(task.status) !== 'channel_running' || !task.lease_token || receipt.acceptedAt + 24 * 60 * 60_000 >= now
    || !detail || !['async_query_interrupted', 'async_query_unconfirmed'].includes(detail.code)
    || !detail.poll?.summaryNotFound || detail.poll.lastHttpStatus !== 404 || detail.poll.lastAttemptPhase !== 'summary_request') return false;
  const original = await evidence(task);
  if (original.receipt.providerTaskId !== receipt.providerTaskId || original.receipt.acceptedAt !== receipt.acceptedAt) return false;
  const identity = binding(task, { ...receipt, requestId: original.requestId });
  return prisma.$transaction(async tx => {
    const current = await tx.imageStudioTask.findUnique({ where: { id: task.id } });
    if (!current || current.status !== studioTaskState(task, 'channel_running') || current.lease_token !== task.lease_token
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
  if (publicPricingTaskState(task.status) !== 'channel_running' || reason === 'provider_unconfirmed' && !UNCONFIRMED.includes(providerStatus as ProviderStatus)) return false;
  const original = await evidence(task);
  if (original.receipt.state === 'failed' || original.receipt.providerTaskId !== receipt.providerTaskId
    || original.receipt.acceptedAt !== receipt.acceptedAt || original.receipt.expiresAt !== receipt.expiresAt) return false;
  const now = Date.now();
  const record: RecoveryRecord = { schema: 'image.async-recovery.v1', taskId: task.id, ownerId: task.owner_id,
    fingerprint: task.fingerprint, channelId: receipt.channelId, configRevision: receipt.configRevision,
    providerTaskId: receipt.providerTaskId, acceptedAt: receipt.acceptedAt, expiresAt: receipt.expiresAt,
    requestId: original.requestId, binding: '', reason, releasedAt: now, providerStatus: UNCONFIRMED.includes(providerStatus as ProviderStatus) ? providerStatus as ProviderStatus : null,
    state: 'scheduled', attempts: 0, nextCheckAt: now + COOLDOWN,
    deadlineAt: now + 24 * 60 * 60_000,
    lastRequestedAt: now, leaseToken: null, leaseUntil: null, manualOnce: false, manualChecks: 0 };
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
    const changed = await tx.imageStudioTask.updateMany({ where: { id: task.id, owner_id: task.owner_id, status: studioTaskState(task, 'channel_running'),
      fingerprint: task.fingerprint, lease_token: task.lease_token, lease_until: { gt: new Date(now) } },
      data: { status: studioTaskState(task, 'uncertain'), lease_token: null, lease_until: null, finished_at: new Date(now),
        error: reason === 'query_unavailable' ? '原号多次查询暂不可用，已退出执行队列；结果和费用仍待确认，将低频核对原号，未取消或重新生成。'
          : '原供应商状态待核对，已退出执行队列；原任务与费用预留保留，将低频核对同一原号。' } });
    if (!changed.count) return false;
    await tx.platformSetting.create({ data: { key: key(task.id), value_json: JSON.stringify(record), updated_by: task.owner_id } });
    return true;
  });
}

export async function requestStudioAsyncRecheck(ownerId: string, id: string, bindingOrRequestId: string) {
  const task = await prisma.imageStudioTask.findFirst({ where: { id, owner_id: ownerId, execution_backend: 'cloud' } });
  const user = await prisma.user.findUnique({ where: { id: ownerId } });
  if (!task || !user || user.status !== 'active' || !canUseCompanyTemplates(user)) throw new StudioAsyncRecoveryError('原任务不存在或无权核对', 404);
  const original = await evidence(task).catch(() => null);
  return prisma.$transaction(async tx => {
    const current = await tx.imageStudioTask.findUnique({ where: { id } });
    const row = await tx.platformSetting.findUnique({ where: { key: key(id) } });
    const record = current && row && parse(row.value_json, current);
    if (!current || current.owner_id !== ownerId || !row || !record || !original || !matches(record, original.receipt, original.requestId)
      || bindingOrRequestId !== record.binding && bindingOrRequestId !== record.requestId) throw new StudioAsyncRecoveryError('没有可安全核对的原异步请求；未重新生成');
    const projection = view(record, current);
    if (!projection.canRequestRecheck) return { recovery: projection, scheduled: false };
    const next = { ...record, manualOnce: true, nextCheckAt: Date.now(), lastRequestedAt: Date.now() };
    const changed = await tx.platformSetting.updateMany({ where: { id: row.id, value_json: row.value_json }, data: { value_json: JSON.stringify(next) } });
    return { recovery: view(changed.count ? next : record, current), scheduled: Boolean(changed.count) };
  });
}

export type StudioAsyncRecoveryClaim = { task: ImageStudioTask; receipt: StudioAsyncReceipt; deadlineAt: number; manualOnce: boolean; localOnly: boolean };
let sweep: { cursor: string | null; ceiling: string } | null = null;
class ClaimLost extends Error {}
export async function claimStudioAsyncRecovery(): Promise<StudioAsyncRecoveryClaim | null> {
  const eligible: Prisma.PlatformSettingWhereInput = { AND: [{ OR: [{ key: { startsWith: PREFIX } }, { key: { startsWith: PRICING_ASYNC_PREFIX } }] }, { OR: [
    { value_json: { contains: '"state":"scheduled"' } }, { value_json: { contains: '"state":"checking"' } },
    { value_json: { contains: '"manualOnce":true' } },
  ] }] };
  if (!sweep) { const last = await prisma.platformSetting.findFirst({ where: eligible, orderBy: { key: 'desc' }, select: { key: true } });
    if (!last) return null; sweep = { cursor: null, ceiling: last.key }; }
  const bounds = sweep;
  const rows = await prisma.platformSetting.findMany({ where: { ...eligible, key: { lte: bounds.ceiling,
    ...(bounds.cursor ? { gt: bounds.cursor } : {}) } }, orderBy: { key: 'asc' }, take: 32 });
  if (!rows.length) { sweep = null; return null; }
  for (const row of rows.slice(0, 10)) {
    bounds.cursor = row.key;
    const parsed = parse(row.value_json);
    if (!parsed || key(parsed.taskId) !== row.key || parsed.nextCheckAt > Date.now()
      || parsed.state === 'checking' && (parsed.leaseUntil || 0) > Date.now()) continue;
    const task = await prisma.imageStudioTask.findUnique({ where: { id: parsed.taskId } });
    const record = task && parse(row.value_json, task);
    if (!task || !record || publicPricingTaskState(task.status) !== 'uncertain' || task.billing_settled_at || task.actual_credits !== null) continue;
    let original;
    try { original = await evidence(task); } catch {
      await prisma.platformSetting.updateMany({ where: { id: row.id, value_json: row.value_json },
        data: { value_json: JSON.stringify({ ...record, state: 'stopped', stopCode: 'original_evidence_unavailable', manualOnce: false, leaseToken: null, leaseUntil: null }) } });
      continue;
    }
    if (!matches(record, original.receipt, original.requestId)) continue;
    // A crashed manual GET is consumed, not automatically issued again. Its
    // result is unknown; only a later explicit, cooled-down action can ask again.
    if (record.state === 'checking' && record.manualOnce) {
      await prisma.$transaction(async tx => {
        const current = await tx.imageStudioTask.findUnique({ where: { id: task.id } });
        if (!current || !parse(row.value_json, current) || current.status !== studioTaskState(task, 'uncertain')
          || current.lease_token !== record.leaseToken || !current.lease_until || current.lease_until.getTime() > Date.now()) return;
        const stopped = record.attempts >= MAX_ATTEMPTS || record.deadlineAt <= Date.now();
        const saved = await tx.platformSetting.updateMany({ where: { id: row.id, value_json: row.value_json }, data: { value_json: JSON.stringify({
          ...record, state: stopped ? 'stopped' : 'scheduled', manualOnce: false, leaseToken: null, leaseUntil: null,
          nextCheckAt: Math.min(record.deadlineAt, Date.now() + COOLDOWN),
          ...(stopped ? { stopCode: record.attempts >= MAX_ATTEMPTS ? 'auto_budget' : 'deadline' } : {}),
        }) } });
        if (!saved.count) return;
        const cleared = await tx.imageStudioTask.updateMany({ where: { id: current.id, status: studioTaskState(current, 'uncertain'), lease_token: record.leaseToken,
          lease_until: current.lease_until }, data: { lease_token: null, lease_until: null } });
        if (!cleared.count) throw new ClaimLost();
      });
      continue;
    }
    // The twelfth network attempt may have durably finished downloading just
    // before a crash. Reclaim only local completion, never another query.
    const localOnly = record.state === 'checking' && record.attempts === MAX_ATTEMPTS && !record.manualOnce;
    if (record.attempts >= MAX_ATTEMPTS && !record.manualOnce && !localOnly) {
      await prisma.platformSetting.updateMany({ where: { id: row.id, value_json: row.value_json },
        data: { value_json: JSON.stringify({ ...record, state: 'stopped', stopCode: 'auto_budget', leaseToken: null, leaseUntil: null }) } });
      continue;
    }
    const token = randomUUID(), now = Date.now(), leaseUntil = now + LEASE_MS;
    try {
      const claimed = await prisma.$transaction(async tx => {
        const current = await tx.imageStudioTask.findUnique({ where: { id: task.id } });
        if (!current || !parse(row.value_json, current) || current.status !== studioTaskState(task, 'uncertain') || current.billing_settled_at
          || current.actual_credits !== null || current.lease_until && current.lease_until.getTime() > now) throw new ClaimLost();
        const held = { ...record, state: 'checking', attempts: record.manualOnce || localOnly ? record.attempts : record.attempts + 1,
          manualChecks: record.manualChecks + (record.manualOnce ? 1 : 0), lastRequestedAt: now,
          leaseToken: token, leaseUntil, nextCheckAt: leaseUntil };
        const changed = await tx.platformSetting.updateMany({ where: { id: row.id, value_json: row.value_json }, data: { value_json: JSON.stringify(held) } });
        if (!changed.count) throw new ClaimLost();
        const leased = await tx.imageStudioTask.updateMany({ where: { id: current.id, status: studioTaskState(current, 'uncertain'), lease_token: current.lease_token,
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
  return row && record && current && parse(row.value_json, current) && current.status === studioTaskState(task, 'uncertain')
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
  return prisma.$transaction(async tx => {
    const held = await studioAsyncRecoveryLease(tx, task);
    if (!held) return;
    const now = Date.now(), record = held.record;
    const stopped = stop || record.attempts >= MAX_ATTEMPTS || record.deadlineAt <= now;
    const stopCode = stop ? code === 'query_budget' ? 'deadline' : code
      : record.attempts >= MAX_ATTEMPTS ? 'auto_budget' : 'deadline';
    const delay = [5, 15, 30, 60][Math.min(3, record.attempts)] * 60_000;
    const changed = await tx.imageStudioTask.updateMany({ where: { id: task.id, status: studioTaskState(task, 'uncertain'), lease_token: task.lease_token,
      lease_until: { gt: new Date(now) } }, data: { lease_token: null, lease_until: null,
      error: stopped ? '原请求自动核对已停止，结果和费用仍待确认；原记录及预留保留，未重新生成。'
        : '原请求仍待核对，将低频查询同一原号；费用预留保持，未重新生成。' } });
    if (!changed.count) return;
    const saved = await tx.platformSetting.updateMany({ where: { id: held.row.id, value_json: held.row.value_json }, data: { value_json: JSON.stringify({
      ...record, state: stopped ? 'stopped' : 'scheduled', nextCheckAt: Math.min(record.deadlineAt, now + delay),
      leaseToken: null, leaseUntil: null, manualOnce: false, ...(stopped ? { stopCode } : {}),
    }) } });
    if (!saved.count) throw new Error('async_recovery_defer_cas_lost');
  });
}
