import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ImageStudioTask, Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { finishStudioTask, safeImageChannelSnapshot } from './tasks';
import { readStudioRequestReceipt, readStudioAsyncReceipt } from './delivery';
import { validateGeneratedStudioImage, StudioImageDeliveryError, StudioImageDownloadError } from './media';
import type { CreditFreezeAllocation } from '@/lib/credits/policy';
import { prepareStudioOutput } from './output';
import { studioDimensionMismatch, studioDimensionMismatchNotice, studioOutputFormat } from './dimension-mismatch';
import { publicPricingTaskState } from './pricing-state';
import { registerCommittedStudioHd } from '@/lib/media/hd-registration';

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

async function preserveOriginal(task: ImageStudioTask, original: Buffer, digest: string, extension = 'png') {
  if (!/^[a-zA-Z0-9-]{1,120}$/.test(task.id)) throw Error('invalid_rejection_task_identity');
  const root = path.join(process.cwd(), 'storage', 'studio-billing');
  const directory = path.join(root, task.id);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(root, 0o700);
  await fs.chmod(directory, 0o700);
  const file = path.join(directory, `rejected-dimensions-${digest}.${extension}`);
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

const retainedIdentity = (task: ImageStudioTask) => hash(JSON.stringify([task.id, task.owner_id, task.batch_id,
  task.fingerprint, task.snapshot_json, task.output_size, task.reference_ids, task.billing_contract_json, task.freeze_snapshot]));
async function preserveLocalResume(task: ImageStudioTask, digest: string, bytes: number, extension = 'png') {
  const file = path.join(process.cwd(), 'storage', 'studio-billing', task.id, 'dimension-retention.json');
  const content = JSON.stringify({ schema: 1, identity: retainedIdentity(task), digest, bytes, extension });
  try { await fs.writeFile(file, content, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await fs.readFile(file, 'utf8') !== content) throw error;
  }
  const handle = await fs.open(file, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

// Written only after full decoding and original-request identity validation.
// Publication failures resume locally, never at the provider.
export async function readRetainedStudioDimensionOriginal(task: ImageStudioTask) {
  if (!/^[a-zA-Z0-9-]{1,120}$/.test(task.id)) throw new StudioImageDownloadError('dimension_retention_checkpoint_invalid');
  const file = path.join(process.cwd(), 'storage', 'studio-billing', task.id, 'dimension-retention.json');
  let marker;
  try {
    marker = JSON.parse(await fs.readFile(file, 'utf8'));
    if (marker?.schema !== 1 || marker.identity !== retainedIdentity(task)) throw Error('dimension_retention_identity_changed');
    return await readPreservedOriginal(task.id, marker.digest, marker.bytes, marker.extension || 'png');
  } catch (error) {
    if (!marker && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new StudioImageDownloadError('dimension_retention_checkpoint_invalid');
  }
}

// Only a fully decoded original with a proven size mismatch reaches settlement.
// This path cannot submit, poll or reinterpret unknown failures.
export async function finishRejectedStudioDimensions(task: ImageStudioTask, original: Buffer,
  repair?: StudioDimensionRepairExpectation) {
  const status = publicPricingTaskState(task.status);
  if (!['running', 'channel_running', 'uncertain'].includes(status) || task.asset_id
    || status !== 'uncertain' && task.finished_at || repair && status !== 'channel_running'
    || !task.output_size || !/^\d+x\d+$/.test(task.output_size)) throw Error('dimension_rejection_task_not_eligible');
  const requestedSize = task.output_size;
  const validations: Array<Parameters<NonNullable<Parameters<typeof validateGeneratedStudioImage>[2]>>[0]> = [];
  let mismatchCode: 'generated_dimensions_mismatch' | 'generated_format_mismatch';
  try {
    await validateGeneratedStudioImage(original, { size: requestedSize, format: 'png' }, async value => { validations.push(value); });
    throw Error('dimension_rejection_not_proven');
  } catch (error) {
    if (!(error instanceof StudioImageDeliveryError) || !['generated_dimensions_mismatch', 'generated_format_mismatch'].includes(error.code)) throw error;
    mismatchCode = error.code as typeof mismatchCode;
  }
  const validation = validations.at(-1);
  const format = validation && studioOutputFormat(validation.originalFormat);
  if (!validation || !format) throw Error('dimension_rejection_validation_missing');
  validation.storedFormat = validation.originalFormat;
  const request = await readStudioRequestReceipt(task);
  const asyncReceipt = status === 'running' ? null : await readStudioAsyncReceipt(task);
  const channel = safeImageChannelSnapshot(JSON.parse(task.snapshot_json || '{}').imageChannel);
  if (!request || request.fingerprint !== task.fingerprint || request.batchId !== task.batch_id
    || status !== 'running' && (request.dispatchState !== 'attempted' || !channel || request.channelId !== channel.channelId
      || request.configRevision !== channel.configRevision)) throw Error('dimension_rejection_request_mismatch');
  const digest = hash(original);
  if (repair && (!/^[a-f0-9]{64}$/.test(repair.taskBeforeSha256) || digest !== repair.originalSha256
    || task.owner_id !== repair.ownerId || task.fingerprint !== repair.fingerprint
    || request.upstreamRequestId !== repair.providerRequestId || asyncReceipt?.providerTaskId !== repair.providerTaskId)) {
    throw Error('dimension_rejection_repair_identity_mismatch');
  }
  // A private, immutable copy survives ordinary checkpoint cleanup. No source is deleted.
  await preserveOriginal(task, original, digest, format.extension);
  await preserveLocalResume(task, digest, original.length, format.extension);
  const assertPublicationScope = async () => {
    const current = await prisma.imageStudioTask.findUnique({ where: { id: task.id } });
    if (!current || current.asset_id || current.status !== task.status || retainedIdentity(current) !== retainedIdentity(task)
      || publicPricingTaskState(current.status) !== 'uncertain' && current.finished_at) throw Error('dimension_rejection_publication_scope_lost');
    if (repair ? studioTaskBeforeHash(current) !== repair.taskBeforeSha256
      : current.lease_token !== task.lease_token
        || !current.lease_until || current.lease_until <= new Date()) throw Error('dimension_rejection_publication_scope_lost');
  };
  const retainedAsset = await prepareStudioOutput(original, task, validation, assertPublicationScope, validation.originalFormat);
  retainedAsset.metadata_json = JSON.stringify({ ...JSON.parse(String(retainedAsset.metadata_json || '{}')),
    deliveryDisposition: mismatchCode, requestedSize });
  const rejection = { code: mismatchCode, originalSha256: digest, originalBytes: original.length,
    validation, requestId: request.localRequestId, upstreamRequestId: request.upstreamRequestId,
    providerTaskId: asyncReceipt?.providerTaskId, responseStatus: request.status, returnedAt: request.returnedAt,
    ...(repair ? { repairExpectedBefore: repair.taskBeforeSha256 } : {}) };
  const finished = await prisma.$transaction(async tx => {
    let current = await tx.imageStudioTask.findUnique({ where: { id: task.id } });
    if (!current || current.status !== task.status || current.owner_id !== task.owner_id
      || current.fingerprint !== task.fingerprint || current.snapshot_json !== task.snapshot_json
      || current.billing_contract_json !== task.billing_contract_json || current.freeze_snapshot !== task.freeze_snapshot
      || current.unit_credits !== task.unit_credits || current.output_size !== task.output_size || current.asset_id
      || publicPricingTaskState(current.status) !== 'uncertain' && current.finished_at) {
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
    const finished = await finishStudioTask(current, status === 'channel_running' && mismatchCode === 'generated_dimensions_mismatch' ? 'failed' : 'uncertain', {
      retainedAsset,
      error: studioDimensionMismatchNotice({ ...validation, requestedSize }),
      usage: { ...previousUsage, studioDelivery: { ...previousUsage.studioDelivery, ...rejection } },
    }, tx);
    if (!finished) throw Error('dimension_rejection_settlement_lease_lost');
    return true;
  }, { timeout: 15000 });
  // finishStudioTask above participates in this outer transaction. Await its
  // commit before querying the retained failed/uncertain output for HD.
  if (finished) await registerCommittedStudioHd(task.id);
  return finished;
}

async function readPreservedOriginal(taskId: string, digest: string, expectedBytes: number, extension = 'png') {
  if (!/^[a-zA-Z0-9-]{1,120}$/.test(taskId) || !/^[a-f0-9]{64}$/.test(digest)
    || !['png', 'jpg', 'webp', 'avif', 'tiff'].includes(extension)
    || !Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) throw Error('dimension_retention_identity_invalid');
  const root = await fs.realpath(path.join(process.cwd(), 'storage', 'studio-billing'));
  const file = path.join(root, taskId, `rejected-dimensions-${digest}.${extension}`);
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o7777) !== 0o600
    || before.size !== expectedBytes || await fs.realpath(file) !== file) throw Error('dimension_retention_checkpoint_invalid');
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length !== expectedBytes || hash(bytes) !== digest || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw Error('dimension_retention_checkpoint_changed');
    return bytes;
  } finally { await handle.close(); }
}

// Explicit maintenance only: expose one already-refunded mismatch without
// changing its task status, billing, request identity, or original checkpoint.
export async function retainSettledStudioDimensionMismatch(taskId: string, expectedSha256: string,
  options: { restoreExpectedDeletedAtMs?: number } = {}) {
  const task = await prisma.imageStudioTask.findUnique({ where: { id: taskId } });
  const mismatch = task && studioDimensionMismatch(task);
  if (!task || !mismatch || !task.finished_at || !task.billing_settled_at
    || task.actual_credits !== 0 || mismatch.originalSha256 !== expectedSha256
    || task.output_size !== mismatch.validation.requestedSize) throw Error('dimension_retention_task_not_eligible');
  const restore = options.restoreExpectedDeletedAtMs !== undefined;
  if (restore && (!Number.isSafeInteger(options.restoreExpectedDeletedAtMs)
    || !task.deleted_at || task.deleted_at.getTime() !== options.restoreExpectedDeletedAtMs)) throw Error('dimension_retention_deleted_at_changed');
  const ledgers = await prisma.creditLedger.findMany({ where: { related_task_id: task.id }, orderBy: { created_at: 'asc' } });
  if (ledgers.length !== 2 || ledgers[0].type !== 'task_freeze' || ledgers[1].type !== 'task_failed_refund'
    || ledgers[0].user_id !== task.owner_id || ledgers[1].user_id !== task.owner_id
    || ledgers[0].idempotency_key !== `image-studio:freeze:${task.id}`
    || ledgers[1].idempotency_key !== `image-studio:settle:${task.id}`) throw Error('dimension_retention_settlement_invalid');
  const beforeSha256 = studioTaskBeforeHash(task);
  const original = await readPreservedOriginal(task.id, mismatch.originalSha256, mismatch.originalBytes);
  const result = (assetId: string, replayed = false) => ({ taskId: task.id, assetId, sha256: mismatch.originalSha256,
    bytes: mismatch.originalBytes, width: mismatch.validation.width, height: mismatch.validation.height,
    requestedSize: task.output_size, replayed });
  if (task.asset_id) {
    const existing = await prisma.asset.findUnique({ where: { id: task.asset_id } });
    if (!existing || existing.owner_id !== task.owner_id || existing.status !== 'active' || existing.type !== 'image'
      || existing.hash !== expectedSha256 || existing.mime_type !== 'image/png'
      || existing.original_url !== `/uploads/assets/${expectedSha256}.png` || !existing.thumbnail_url
      || existing.file_size !== mismatch.originalBytes || existing.width !== mismatch.validation.width
      || existing.height !== mismatch.validation.height) throw Error('dimension_retention_asset_invalid');
    const { localMediaPath } = await import('@/lib/media/storage-roots');
    if (!original.equals(await fs.readFile(localMediaPath(existing.original_url)))) throw Error('dimension_retention_published_file_changed');
    await fs.access(localMediaPath(existing.thumbnail_url));
    if (restore) {
      const changed = await prisma.imageStudioTask.updateMany({ where: { id: task.id, asset_id: existing.id,
        deleted_at: task.deleted_at, updated_at: task.updated_at }, data: { deleted_at: null } });
      if (changed.count !== 1) throw Error('dimension_retention_visibility_changed');
    }
    return result(existing.id, true);
  }
  const validations: Array<Parameters<NonNullable<Parameters<typeof validateGeneratedStudioImage>[2]>>[0]> = [];
  try {
    await validateGeneratedStudioImage(original, { size: task.output_size!, format: 'png' }, async value => { validations.push(value); });
    throw Error('dimension_retention_not_mismatched');
  } catch (error) {
    if (!(error instanceof StudioImageDeliveryError) || error.code !== 'generated_dimensions_mismatch') throw error;
  }
  const validation = validations.at(-1);
  if (!validation || validation.width !== mismatch.validation.width || validation.height !== mismatch.validation.height
    || validation.requestedSize !== mismatch.validation.requestedSize) throw Error('dimension_retention_validation_changed');
  const assertUnchanged = async () => {
    const current = await prisma.imageStudioTask.findUnique({ where: { id: task.id } });
    if (!current || current.asset_id || studioTaskBeforeHash(current) !== beforeSha256) throw Error('dimension_retention_task_changed');
  };
  const prepared = await prepareStudioOutput(original, task, validation, assertUnchanged);
  prepared.metadata_json = JSON.stringify({ ...JSON.parse(String(prepared.metadata_json || '{}')),
    deliveryDisposition: 'generated_dimensions_mismatch', requestedSize: task.output_size });
  return prisma.$transaction(async tx => {
    const current = await tx.imageStudioTask.findUnique({ where: { id: task.id } });
    if (!current || current.asset_id || studioTaskBeforeHash(current) !== beforeSha256
      || !studioDimensionMismatch(current)) throw Error('dimension_retention_task_changed');
    const asset = await tx.asset.upsert({ where: { owner_id_hash: { owner_id: task.owner_id, hash: prepared.hash! } },
      create: prepared, update: { thumbnail_url: prepared.thumbnail_url, width: prepared.width, height: prepared.height } });
    if (asset.owner_id !== task.owner_id || asset.status !== 'active' || asset.mime_type !== 'image/png'
      || asset.original_url !== prepared.original_url || !asset.thumbnail_url
      || asset.width !== validation.width || asset.height !== validation.height) throw Error('dimension_retention_asset_invalid');
    const linked = await tx.imageStudioTask.updateMany({ where: { id: task.id, asset_id: null, status: task.status,
      updated_at: task.updated_at, deleted_at: task.deleted_at },
      data: { asset_id: asset.id, ...(restore ? { deleted_at: null } : {}) } });
    if (linked.count !== 1) throw Error('dimension_retention_link_lost');
    return result(asset.id);
  }, { timeout: 15000 });
}
