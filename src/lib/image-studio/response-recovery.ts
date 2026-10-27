import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { ImageStudioTask, OperationLog, Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { transformPrivateImageTask } from './private-storage.server';
import { resolveImageGenerationChannelSnapshot } from '@/lib/integrations/image-generation';
import { isPrivateNetworkHost } from '@/lib/media/public-url';
import { readStudioResponseEvidence } from './response-evidence';
import type { StudioDelivery, StudioReceipt } from './delivery';
import { MAX_STUDIO_GENERATED_BYTES } from './limits';
import { parseImageBillingContract } from './billing-contract';
import { imageBillingScope } from './billing-scope';
import { assertFrozenSharedStudioTask } from './tasks';
import { publicPricingBillingState, publicPricingTaskState, studioTaskState } from './pricing-state';
import { creditCents } from '@/lib/credits/precision';

type Input = { taskId: string; requestId: string; actorId: string; mutationId: string; responseSha256: string };
type RecoveryReceipt = { taskId: string; requestId: string; mutationId: string; operationId: string;
  responseSha256: string; checkpointSha256: string; status: 'accepted' };
type Tx = Prisma.TransactionClient;
const HASH = /^[a-f0-9]{64}$/;
const ACTION = 'image_studio_response_recovery_requested';
const SCHEMA = 'studio.response-recovery.v1';
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const fail = (code: 'invalid' | 'forbidden' | 'conflict' | 'checkpoint' | 'billing') => new Error(`studio_response_recovery_${code}`);
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function json(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!object(parsed)) throw fail('invalid');
  return parsed;
}
function safeUrl(value: string) {
  if (!value.length || value.length > 16384 || value !== value.trim() || /[\u0000-\u0020\u007f\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return url.protocol === 'https:' && !url.username && !url.password && host.includes('.')
      && !isPrivateNetworkHost(host) && host !== '::' && !host.startsWith('::ffff:')
      && !host.endsWith('.localhost') && !host.endsWith('.internal') && !host.endsWith('.lan')
      && !/^(0\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|192\.0\.0\.|198\.(1[89])\.|2(2[4-9]|[3-5]\d)\.)/.test(host);
  } catch { return false; }
}
function inputDigest(input: Input) { return sha(JSON.stringify([input.taskId, input.requestId, input.actorId, input.mutationId, input.responseSha256])); }
function operationId(input: Input) { return `studio-response-recovery-${sha(JSON.stringify([input.actorId, input.mutationId]))}`; }
function receiptFrom(log: OperationLog, input: Input): RecoveryReceipt {
  const detail = json(log.detail || '{}');
  if (log.id !== operationId(input) || log.operator_id !== input.actorId || log.action !== ACTION
    || log.target_type !== 'image_studio_task' || log.target_id !== input.taskId || detail.schema !== SCHEMA
    || detail.inputSha256 !== inputDigest(input) || detail.requestId !== input.requestId
    || detail.responseSha256 !== input.responseSha256 || typeof detail.checkpointSha256 !== 'string'
    || !HASH.test(detail.checkpointSha256) || detail.fromStatus !== 'uncertain' || detail.toStatus !== 'channel_running') throw fail('conflict');
  return { taskId: input.taskId, requestId: input.requestId, mutationId: input.mutationId,
    operationId: log.id, responseSha256: input.responseSha256, checkpointSha256: detail.checkpointSha256, status: 'accepted' };
}
async function owner(tx: Tx, input: Input) {
  const actor = await tx.user.findUnique({ where: { id: input.actorId }, select: { role: true, status: true, expires_at: true } });
  const task = await tx.imageStudioTask.findUnique({ where: { id: input.taskId } });
  if (!actor || actor.role !== 'admin' || actor.status !== 'active' || actor.expires_at && actor.expires_at.getTime() <= Date.now()
    || !task || task.owner_id !== input.actorId) throw fail('forbidden');
  return task;
}

async function directory(dir: string) {
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o7777) !== 0o700 || await fs.realpath(dir) !== dir) throw fail('checkpoint');
}
async function privateFile(dir: string, name: string, maximum: number) {
  await directory(dir);
  const file = path.join(dir, name);
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o7777) !== 0o600
    || before.size <= 0 || before.size > maximum || await fs.realpath(file) !== file) throw fail('checkpoint');
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.mode !== before.mode) throw fail('checkpoint');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const next = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!next.bytesRead) throw fail('checkpoint');
      offset += next.bytesRead;
    }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, offset);
    const after = await handle.stat();
    if (extra.bytesRead || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw fail('checkpoint');
    return bytes;
  } finally { await handle.close(); }
}

// Local files only: never invoke the delivery downloader or any provider API.
async function checkpoint(task: ImageStudioTask, input: Input, decode: boolean) {
  try {
    const storage = await fs.realpath(path.join(process.cwd(), 'storage'));
    if (process.env.NODE_ENV === 'production' && !storage.startsWith('/data/')) throw fail('checkpoint');
    const deliveryRoot = path.join(storage, 'studio-delivery');
    const evidenceRoot = path.join(storage, 'studio-response-evidence');
    await directory(deliveryRoot); await directory(evidenceRoot);
    const deliveryDir = path.join(deliveryRoot, task.id);
    const requestBytes = await privateFile(deliveryDir, 'request.json', 128 * 1024);
    const receipt: StudioReceipt = JSON.parse(requestBytes.toString('utf8'));
    if (receipt.status !== 200 || receipt.dispatchState !== 'attempted' || receipt.billingScope !== task.billing_scope
      || receipt.localRequestId !== input.requestId || typeof receipt.returnedAt !== 'number'
      || receipt.returnedAt > Date.now() || (receipt.gatewayRequestId || null) !== task.gateway_request_id
      || publicPricingBillingState(task.billing_status) !== (receipt.gatewayRequestId ? 'channel_pending' : 'channel_unmatched')) throw fail('checkpoint');
    const evidence = await readStudioResponseEvidence(task, receipt);
    if (!evidence || evidence.responseSha256 !== input.responseSha256 || evidence.candidates.length !== 1 || evidence.rejected.length !== 0
      || evidence.diagnostic.observation.httpStatus !== 200 || !evidence.diagnostic.observation.bodyComplete
      || evidence.diagnostic.observation.parseOutcome !== 'valid_json') throw fail('checkpoint');
    const candidate = evidence.candidates[0];
    if (candidate.kind !== 'url' || candidate.storageKind !== 'url'
      || !['data_url', 'candidate_content_part_fileData', 'candidate_content_part_file_data'].includes(candidate.location)) throw fail('checkpoint');
    const evidenceDir = path.join(evidenceRoot, sha(task.id));
    const seal = (await privateFile(evidenceDir, 'manifest.sha256', 64)).toString('ascii');
    const manifestBytes = await privateFile(evidenceDir, 'manifest.json', 128 * 1024);
    if (!HASH.test(seal) || sha(manifestBytes) !== seal) throw fail('checkpoint');
    const manifest = json(manifestBytes.toString('utf8'));
    const identity = manifest.identity;
    const candidates = manifest.candidates;
    if (manifest.schema !== 'studio.response-evidence.v1' || manifest.responseSha256 !== input.responseSha256
      || manifest.createdAt !== evidence.createdAt || manifest.expiresAt !== evidence.expiresAt
      || !object(identity) || identity.taskId !== task.id || identity.ownerId !== task.owner_id
      || identity.batchId !== task.batch_id || identity.fingerprint !== task.fingerprint || identity.model !== task.model
      || identity.localRequestId !== input.requestId || identity.channelId !== receipt.channelId
      || identity.configRevision !== receipt.configRevision || identity.submittedAt !== receipt.submittedAt
      || identity.returnedAt !== receipt.returnedAt || identity.status !== 200 || !Array.isArray(candidates) || candidates.length !== 1) throw fail('checkpoint');
    const original: unknown = candidates[0];
    if (!object(original) || original.kind !== 'url' || original.storageKind !== 'url' || original.unconfirmed !== true
      || original.location !== candidate.location || original.ordinal !== candidate.ordinal
      || JSON.stringify(original.wrapperPath) !== JSON.stringify(candidate.wrapperPath)
      || typeof original.url !== 'string' || !safeUrl(original.url) || original.url.length !== candidate.urlLength
      || original.urlSha256 !== sha(original.url)) throw fail('checkpoint');
    const sourceBytes = await privateFile(deliveryDir, 'source.json', 128 * 1024);
    const delivery: StudioDelivery = JSON.parse(sourceBytes.toString('utf8'));
    if (delivery.taskId !== task.id || delivery.ownerId !== task.owner_id || delivery.kind !== 'url' || delivery.complete !== true
      || delivery.url !== original.url || typeof delivery.outputHash !== 'string' || !HASH.test(delivery.outputHash)
      || !Number.isSafeInteger(delivery.expectedBytes) || Number(delivery.expectedBytes) <= 0
      || delivery.expectedBytes !== delivery.receivedBytes || Number(delivery.expectedBytes) > MAX_STUDIO_GENERATED_BYTES) throw fail('checkpoint');
    const bytes = await privateFile(deliveryDir, 'image.part', MAX_STUDIO_GENERATED_BYTES);
    if (bytes.length !== delivery.expectedBytes || sha(bytes) !== delivery.outputHash
      || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw fail('checkpoint');
    if (decode) {
      const options = { animated: false, limitInputPixels: 40_000_000, failOn: 'warning' as const };
      const metadata = await sharp(bytes, options).metadata();
      if (metadata.format !== 'png' || (metadata.pages || 1) !== 1 || !Number.isSafeInteger(metadata.width)
        || !Number.isSafeInteger(metadata.height) || !metadata.width || !metadata.height
        || metadata.width > 16384 || metadata.height > 16384 || metadata.width * metadata.height > 40_000_000) throw fail('checkpoint');
      await sharp(bytes, options).timeout({ seconds: 45 }).stats();
    }
    return { checkpointSha256: delivery.outputHash, checkpointBytes: bytes.length, requestSha256: sha(requestBytes),
      sourceSha256: sha(sourceBytes), manifestSha256: seal };
  } catch { throw fail('checkpoint'); }
}

async function eligibility(tx: Tx, task: ImageStudioTask, input: Input) {
  const now = Date.now();
  const model = task.model;
  const contract = parseImageBillingContract(task.billing_contract_json);
  if (model !== 'gemini-nano-banana-2.1' && model !== 'gemini-3-pro-image-preview') throw fail('invalid');
  if (publicPricingTaskState(task.status) !== 'uncertain' || task.deleted_at || task.asset_id || task.lease_until && task.lease_until.getTime() > now
    || task.actual_credits !== null || task.actual_amount_micros !== null || task.billing_settled_at
    || task.billing_mode !== 'fixed' || !['channel_pending', 'channel_unmatched'].includes(publicPricingBillingState(task.billing_status))
    || !contract?.pricing && task.unit_credits !== (model === 'gemini-nano-banana-2.1' ? 5 : 10)) throw fail('conflict');
  const snapshot = json(task.snapshot_json || '{}');
  const channel = snapshot.imageChannel;
  if (snapshot.model !== model || snapshot.requestId !== input.requestId || snapshot.batchId !== task.batch_id
    || snapshot.quality !== task.quality || snapshot.unitCredits !== task.unit_credits || !object(channel)
    || typeof channel.channelId !== 'string' || typeof channel.configRevision !== 'string'
    || !contract || contract.mode !== 'fixed' || contract.model !== model || contract.scope !== task.billing_scope
    || contract.authorizedCredits !== task.unit_credits || contract.estimateSource !== 'legacy_fixed'
    || JSON.stringify(snapshot.billingContract) !== task.billing_contract_json) throw fail('billing');
  assertFrozenSharedStudioTask(transformPrivateImageTask(task, false));
  const settings = await resolveImageGenerationChannelSnapshot({ channelId: channel.channelId, configRevision: channel.configRevision }, tx, false, model);
  const capability = settings.modelCapabilities[model];
  if (!settings.enabled || !settings.api_key || settings.channelId !== channel.channelId || settings.configRevision !== channel.configRevision
    || !capability?.enabled || capability.protocol !== 'gemini_native' || capability.billingMode !== 'fixed'
    || !contract.pricing && capability.fixedPoints !== task.unit_credits || imageBillingScope(settings) !== task.billing_scope) throw fail('billing');
  const ledgers = await tx.creditLedger.findMany({ where: { related_task_id: task.id } });
  const freeze = ledgers[0];
  if (ledgers.length !== 1 || !freeze || freeze.type !== 'task_freeze' || freeze.user_id !== task.owner_id
    || freeze.idempotency_key !== `image-studio:freeze:${task.id}` || freeze.amount !== -task.unit_credits
    || freeze.frozen_before === null || freeze.frozen_after === null
    || creditCents(freeze.frozen_after) - creditCents(freeze.frozen_before) !== creditCents(task.unit_credits)) throw fail('billing');
  const allocations: unknown = JSON.parse(task.freeze_snapshot || 'null');
  const ledgerMetadata = json(freeze.metadata_json || '{}');
  if (!Array.isArray(allocations) || !allocations.length || allocations.length > 128
    || JSON.stringify(ledgerMetadata.allocations) !== JSON.stringify(allocations)) throw fail('billing');
  let total = 0; let balance = 0;
  const seen = new Set<string>();
  for (const allocation of allocations) {
    if (!object(allocation) || typeof allocation.amount !== 'number' || !Number.isFinite(allocation.amount) || allocation.amount <= 0) throw fail('billing');
    total += allocation.amount;
    if (allocation.source_type === 'balance') { if (balance) throw fail('billing'); balance = allocation.amount; }
    else if (allocation.source_type === 'daily_quota' && typeof allocation.bucket_id === 'string' && !seen.has(allocation.bucket_id)) {
      seen.add(allocation.bucket_id);
      const bucket = await tx.creditBucket.findUnique({ where: { id: allocation.bucket_id } });
      if (!bucket || bucket.user_id !== task.owner_id || bucket.source_type !== 'daily_quota'
        || bucket.frozen_amount + 0.00001 < allocation.amount || bucket.policy_key !== allocation.policy_key
        || bucket.quota_date !== allocation.quota_date || (bucket.expires_at?.toISOString() || null) !== allocation.expires_at) throw fail('billing');
    } else throw fail('billing');
  }
  const account = await tx.creditAccount.findUnique({ where: { user_id: task.owner_id } });
  if (Math.abs(total - task.unit_credits) > 0.00001 || !account || account.frozen_credits + 0.00001 < balance
    || account.balance + 0.00001 < balance || await tx.costLedger.count({ where: { image_task_id: task.id,
      event_type: { notIn: ['estimate', 'provider_request_submitted'] } } })
    || await tx.costAllocation.count({ where: { image_task_id: task.id } })) throw fail('billing');
  return { freezeId: freeze.id, freezeSha256: sha(JSON.stringify(freeze)) };
}

/** Explicit maintenance authorization only; schedules original local delivery, never generates or downloads. */
export async function requestStudioResponseRecovery(input: Input): Promise<RecoveryReceipt> {
  if (typeof window !== 'undefined') throw fail('forbidden');
  if (!input || !/^[a-zA-Z0-9-]{1,120}$/.test(input.taskId) || !/^[a-zA-Z0-9-]{16,80}$/.test(input.requestId)
    || !/^[a-zA-Z0-9_-]{1,180}$/.test(input.actorId) || !/^[a-zA-Z0-9_-]{16,120}$/.test(input.mutationId)
    || !HASH.test(input.responseSha256)) throw fail('invalid');
  try {
    const initial = await prisma.$transaction(async tx => {
      const task = await owner(tx, input);
      const previous = await tx.operationLog.findUnique({ where: { id: operationId(input) } });
      if (previous) return { receipt: receiptFrom(previous, input) };
      const freeze = await eligibility(tx, task, input);
      return { task, freeze };
    }, { timeout: 15000 });
    if ('receipt' in initial && initial.receipt) return initial.receipt;
    if (!('task' in initial) || !initial.task) throw fail('conflict');
    const task = initial.task;
    const verified = await checkpoint(task, input, true);
    return await prisma.$transaction(async tx => {
      const current = await owner(tx, input);
      const previous = await tx.operationLog.findUnique({ where: { id: operationId(input) } });
      if (previous) return receiptFrom(previous, input);
      // This also protects frozen input, error, billing fields, timestamps and lease from intervening changes.
      if (JSON.stringify(current) !== JSON.stringify(task)) throw fail('conflict');
      const freeze = await eligibility(tx, current, input);
      if (JSON.stringify(freeze) !== JSON.stringify(initial.freeze)) throw fail('billing');
      const fresh = await checkpoint(current, input, false);
      if (JSON.stringify(fresh) !== JSON.stringify(verified)) throw fail('checkpoint');
      const changed = await tx.imageStudioTask.updateMany({ where: { id: task.id, owner_id: input.actorId,
        status: task.status, updated_at: task.updated_at, snapshot_json: task.snapshot_json, fingerprint: task.fingerprint,
        billing_contract_json: task.billing_contract_json, freeze_snapshot: task.freeze_snapshot,
        billing_mode: task.billing_mode, billing_status: task.billing_status, billing_scope: task.billing_scope,
        unit_credits: task.unit_credits, model: task.model, asset_id: null, deleted_at: null,
        lease_token: task.lease_token, lease_until: task.lease_until, actual_credits: null,
        actual_amount_micros: null, billing_settled_at: null, finished_at: task.finished_at, error: task.error },
      data: { status: studioTaskState(task, 'channel_running'), lease_token: null, lease_until: new Date(0), finished_at: null } });
      if (changed.count !== 1) throw fail('conflict');
      const log = await tx.operationLog.create({ data: { id: operationId(input), operator_id: input.actorId,
        action: ACTION, target_type: 'image_studio_task', target_id: task.id, detail: JSON.stringify({
          schema: SCHEMA, inputSha256: inputDigest(input), requestId: input.requestId, mutationId: input.mutationId,
          execution: 'Codex代执行BN21/G3P02/BN21-T；授权来源=本轮用户请求；执行方式=服务器维护；既有任务所属账号为授权主体；未声称网页登录',
          responseSha256: input.responseSha256, ...verified, ...freeze, originalErrorSha256: sha(task.error || ''),
          fromStatus: 'uncertain', toStatus: 'channel_running', originalFixedCredits: task.unit_credits,
        }) } });
      return receiptFrom(log, input);
    }, { timeout: 15000 });
  } catch (cause) {
    // A simultaneous identical mutation may have committed while this transaction lost its race.
    const previous = await prisma.$transaction(async tx => {
      await owner(tx, input);
      return tx.operationLog.findUnique({ where: { id: operationId(input) } });
    }, { timeout: 15000 }).catch(() => null);
    if (previous) return receiptFrom(previous, input);
    if (cause instanceof Error && /^studio_response_recovery_(invalid|forbidden|conflict|checkpoint|billing)$/.test(cause.message)) throw cause;
    throw fail('conflict');
  }
}
