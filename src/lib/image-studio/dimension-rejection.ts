import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ImageStudioTask, Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { finishStudioTask, safeImageChannelSnapshot } from './tasks';
import { readStudioRequestReceipt, readStudioAsyncReceipt } from './delivery';
import { validateGeneratedStudioImage, StudioImageDeliveryError } from './media';
import type { CreditFreezeAllocation } from '@/lib/credits/policy';

const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
export function studioTaskBeforeHash(task: ImageStudioTask) {
  return hash(JSON.stringify(task, Object.keys(task).sort()));
}

export type StudioDimensionRepairExpectation = {
  taskBeforeSha256: string;
  accountBeforeSha256: string;
  originalSha256: string;
  ownerId: string;
  fingerprint: string;
  providerTaskId: string;
  providerRequestId: string;
};

async function requireOriginalReservation(tx: Prisma.TransactionClient, task: ImageStudioTask) {
  const freezes = await tx.creditLedger.findMany({ where: { related_task_id: task.id, type: 'task_freeze' } });
  const settled = await tx.creditLedger.findMany({ where: { related_task_id: task.id, type: { not: 'task_freeze' } } });
  if (settled.length || task.actual_credits !== null || task.billing_settled_at !== null) throw Error('dimension_rejection_already_settled');
  if (task.unit_credits === 0) return;
  const freeze = freezes[0];
  if (freezes.length !== 1 || !freeze || freeze.user_id !== task.owner_id || freeze.related_task_id !== task.id
    || freeze.idempotency_key !== `image-studio:freeze:${task.id}`
    || freeze.type !== 'task_freeze' || freeze.amount !== -task.unit_credits || !task.freeze_snapshot) {
    throw Error('dimension_rejection_freeze_identity_mismatch');
  }
  const allocations = JSON.parse(task.freeze_snapshot) as CreditFreezeAllocation[];
  const ledgerAllocations = JSON.parse(freeze.metadata_json || '{}').allocations;
  if (!Array.isArray(allocations) || !allocations.length || JSON.stringify(allocations) !== JSON.stringify(ledgerAllocations)
    || allocations.some(value => !value || !['balance', 'daily_quota'].includes(value.source_type)
      || !Number.isFinite(value.amount) || value.amount <= 0)
    || Math.abs(allocations.reduce((total, value) => total + value.amount, 0) - task.unit_credits) > 0.00001) {
    throw Error('dimension_rejection_freeze_snapshot_mismatch');
  }
  const account = await tx.creditAccount.findUnique({ where: { user_id: task.owner_id } });
  const longAmount = allocations.filter(value => value.source_type === 'balance').reduce((total, value) => total + value.amount, 0);
  if (!account || account.frozen_credits + 0.00001 < longAmount) throw Error('dimension_rejection_reservation_missing');
  const buckets = new Map<string, number>();
  for (const allocation of allocations.filter(value => value.source_type === 'daily_quota')) {
    if (!allocation.bucket_id) throw Error('dimension_rejection_bucket_missing');
    buckets.set(allocation.bucket_id, (buckets.get(allocation.bucket_id) || 0) + allocation.amount);
  }
  for (const [id, amount] of Array.from(buckets)) {
    const bucket = await tx.creditBucket.findUnique({ where: { id } });
    if (!bucket || bucket.user_id !== task.owner_id || bucket.frozen_amount + 0.00001 < amount) {
      throw Error('dimension_rejection_bucket_reservation_missing');
    }
  }
}

async function preserveOriginal(task: ImageStudioTask, original: Buffer, digest: string) {
  if (!/^[a-zA-Z0-9-]{1,120}$/.test(task.id)) throw Error('invalid_rejection_task_identity');
  const root = path.join(process.cwd(), 'storage', 'studio-billing');
  const directory = path.join(root, task.id);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(root, 0o700);
  await fs.chmod(directory, 0o700);
  const file = path.join(directory, `rejected-dimensions-${digest}.png`);
  const temporary = path.join(directory, `${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(original); await handle.sync(); } finally { await handle.close(); }
    try { await fs.link(temporary, file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || hash(await fs.readFile(file)) !== digest) throw error;
    }
    const folder = await fs.open(directory, 'r');
    try { await folder.sync(); } finally { await folder.close(); }
  } finally { await fs.unlink(temporary).catch(() => {}); }
}

// Only a fully decoded original with a proven size mismatch reaches settlement.
// This path cannot submit, poll, create an asset, or reinterpret unknown failures.
export async function finishRejectedStudioDimensions(task: ImageStudioTask, original: Buffer,
  repair?: StudioDimensionRepairExpectation) {
  if (task.status !== 'channel_running' || task.asset_id || task.finished_at
    || !task.output_size || !/^\d+x\d+$/.test(task.output_size)) throw Error('dimension_rejection_task_not_eligible');
  const validations: Array<Parameters<NonNullable<Parameters<typeof validateGeneratedStudioImage>[2]>>[0]> = [];
  try {
    await validateGeneratedStudioImage(original, { size: task.output_size, format: 'png' }, async value => { validations.push(value); });
    throw Error('dimension_rejection_not_proven');
  } catch (error) {
    if (!(error instanceof StudioImageDeliveryError) || error.code !== 'generated_dimensions_mismatch') throw error;
  }
  const validation = validations.at(-1);
  if (!validation || validation.originalFormat !== 'png') throw Error('dimension_rejection_validation_missing');
  const request = await readStudioRequestReceipt(task);
  const asyncReceipt = await readStudioAsyncReceipt(task);
  const channel = safeImageChannelSnapshot(JSON.parse(task.snapshot_json || '{}').imageChannel);
  if (!request || request.fingerprint !== task.fingerprint || request.batchId !== task.batch_id
    || request.dispatchState !== 'attempted' || !channel || request.channelId !== channel.channelId
    || request.configRevision !== channel.configRevision) throw Error('dimension_rejection_request_mismatch');
  const digest = hash(original);
  if (repair && (!/^[a-f0-9]{64}$/.test(repair.taskBeforeSha256) || digest !== repair.originalSha256
    || task.owner_id !== repair.ownerId || task.fingerprint !== repair.fingerprint
    || request.upstreamRequestId !== repair.providerRequestId || asyncReceipt?.providerTaskId !== repair.providerTaskId)) {
    throw Error('dimension_rejection_repair_identity_mismatch');
  }
  // A private, immutable copy survives ordinary checkpoint cleanup. No source is deleted.
  await preserveOriginal(task, original, digest);
  const rejection = { code: 'generated_dimensions_mismatch', originalSha256: digest, originalBytes: original.length,
    validation, requestId: request.localRequestId, upstreamRequestId: request.upstreamRequestId,
    providerTaskId: asyncReceipt?.providerTaskId, responseStatus: request.status, returnedAt: request.returnedAt,
    ...(repair ? { repairExpectedBefore: repair.taskBeforeSha256 } : {}) };
  return prisma.$transaction(async tx => {
    let current = await tx.imageStudioTask.findUnique({ where: { id: task.id } });
    if (!current || current.status !== 'channel_running' || current.owner_id !== task.owner_id
      || current.fingerprint !== task.fingerprint || current.snapshot_json !== task.snapshot_json
      || current.billing_contract_json !== task.billing_contract_json || current.freeze_snapshot !== task.freeze_snapshot
      || current.unit_credits !== task.unit_credits || current.output_size !== task.output_size || current.asset_id || current.finished_at) {
      throw Error('dimension_rejection_current_task_changed');
    }
    if (repair) {
      if (studioTaskBeforeHash(current) !== repair.taskBeforeSha256) throw Error('dimension_rejection_expected_before_changed');
      const account = await tx.creditAccount.findUniqueOrThrow({ where: { user_id: current.owner_id } });
      if (hash(JSON.stringify(account, Object.keys(account).sort())) !== repair.accountBeforeSha256) {
        throw Error('dimension_rejection_account_before_changed');
      }
      const token = randomUUID();
      const claimed = await tx.imageStudioTask.updateMany({ where: { id: current.id, status: current.status,
        owner_id: current.owner_id, fingerprint: current.fingerprint, lease_token: current.lease_token,
        lease_until: current.lease_until, updated_at: current.updated_at },
        data: { lease_token: token, lease_until: new Date(Date.now() + 60_000) } });
      if (claimed.count !== 1) throw Error('dimension_rejection_repair_claim_lost');
      current = { ...current, lease_token: token, lease_until: new Date(Date.now() + 60_000) };
    } else if (current.lease_token !== task.lease_token || !current.lease_until || current.lease_until <= new Date()) {
      return false;
    }
    await requireOriginalReservation(tx, current);
    const previousUsage = current.usage_json ? JSON.parse(current.usage_json) : {};
    if (!previousUsage || typeof previousUsage !== 'object' || Array.isArray(previousUsage)) throw Error('dimension_rejection_usage_not_object');
    const finished = await finishStudioTask(current, 'failed', {
      error: '原图尺寸与请求不符，未交付资产；本站冻结积分已释放。原图与请求记录已保留，不会自动重新生成；供应商实际费用仍待核对。',
      usage: { ...previousUsage, studioDelivery: { ...previousUsage.studioDelivery, ...rejection } },
    }, tx);
    if (!finished) throw Error('dimension_rejection_settlement_lease_lost');
    return true;
  }, { timeout: 15000 });
}
