import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { PRICING_BATCH_PREFIX, PRICING_BATCH_ITEM_PREFIX } from './pricing-state';

export const IMAGE_SUBMIT_RECEIPT_SCHEMA = 'image.submit-receipt.v1' as const;
const PREFIX = 'image_submit_receipt_v1:';
const SYNC_PREFIX = 'image_sync_request_v1:';
const BATCH_PREFIXES = ['studio_batch_v1:', 'studio_channel_batch_v1:', PRICING_BATCH_PREFIX];
const PREPARED_PREFIXES = ['studio_batch_item_v1:', 'studio_channel_batch_item_v1:', PRICING_BATCH_ITEM_PREFIX];
type Client = Pick<Prisma.TransactionClient, 'platformSetting' | 'imageStudioTask' | 'creditLedger' | 'operationLog'>;
type TerminalReceipt = {
  schema: 'image.submit-receipt.v1'; account: string; requestId: string;
  state: 'rejected' | 'closed'; code: string; stage: string; createdAt: string;
};
export type StudioSubmitReceipt = {
  schema: typeof IMAGE_SUBMIT_RECEIPT_SCHEMA;
  requestId: string; state: 'accepted' | 'rejected' | 'unknown' | 'closed';
  code?: string; stage?: string; message?: string; taskIds?: string[]; batchId?: string;
};
export class StudioSubmitReceiptError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 409, public readonly stage = 'request-receipt') { super(message); }
}
export const validStudioSubmitRequestId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9-]{16,100}$/.test(value);
export const studioSubmitReceiptKey = (account: string, requestId: string) => `${PREFIX}${account}:${requestId}`;
const idFor = (account: string, requestId: string) => createHash('sha256').update(`${account}:${requestId}`).digest('hex');
const failures = new WeakMap<object, { code: string; stage: string }>();
export function markStudioSubmitFailure(error: unknown, stage: string, code?: string) {
  if (!error || typeof error !== 'object' || failures.has(error)) return;
  const supplied = 'code' in error && typeof error.code === 'string' && /^[A-Za-z0-9_]{1,100}$/.test(error.code) ? error.code : undefined;
  failures.set(error, { stage, code: code || supplied || 'IMAGE_SUBMIT_REJECTED' });
}
export function studioSubmitFailureDetail(error: unknown, fallbackStage = 'submit-api') {
  const marked = error && typeof error === 'object' ? failures.get(error) : undefined;
  const supplied = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    && /^[A-Za-z0-9_]{1,100}$/.test(error.code) ? error.code : undefined;
  return marked || { code: supplied || 'IMAGE_SUBMIT_REJECTED', stage: fallbackStage };
}
function terminal(json: string, account: string, requestId: string): TerminalReceipt {
  const value = JSON.parse(json) as TerminalReceipt;
  if (!value || value.schema !== 'image.submit-receipt.v1' || value.account !== account || value.requestId !== requestId
    || !['rejected', 'closed'].includes(value.state) || typeof value.code !== 'string' || !/^[A-Za-z0-9_]{1,100}$/.test(value.code)
    || typeof value.stage !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value.stage) || !Number.isFinite(Date.parse(value.createdAt))) {
    throw new StudioSubmitReceiptError('IMAGE_SUBMIT_RECEIPT_UNAVAILABLE', '原提交回执暂时无法核对，请保留原编号', 503);
  }
  return value;
}
function projectReceipt(value: TerminalReceipt): StudioSubmitReceipt {
  return { schema: IMAGE_SUBMIT_RECEIPT_SCHEMA, requestId: value.requestId, state: value.state, code: value.code, stage: value.stage,
    message: value.state === 'closed' ? '本次提交已结束，原编号不会再次生成；输入仍保留。' : '服务器已确认本次提交未受理，原编号不会再次生成；输入仍保留。' };
}
/** Always active, including a compatible guard with new receipt writes disabled. */
export async function assertStudioRequestWritable(tx: Pick<Prisma.TransactionClient, 'platformSetting'>, account: string, requestId: string) {
  const saved = await tx.platformSetting.findUnique({ where: { key: studioSubmitReceiptKey(account, requestId) }, select: { value_json: true } });
  if (!saved) return;
  const receipt = terminal(saved.value_json, account, requestId);
  throw new StudioSubmitReceiptError(receipt.code, receipt.state === 'closed'
    ? '原提交编号已结束，请保留输入并主动开始新的生成。' : '原提交编号已明确拒绝，请保留输入并主动开始新的生成。', 409, receipt.stage);
}
async function evidence(tx: Client, account: string, requestId: string): Promise<StudioSubmitReceipt | null> {
  const batchId = idFor(account, requestId);
  const tasks = await tx.imageStudioTask.findMany({ where: { owner_id: account, batch_id: batchId }, select: { id: true } });
  if (tasks.length) return { schema: IMAGE_SUBMIT_RECEIPT_SCHEMA, requestId, state: 'accepted', stage: 'task-admission', batchId, taskIds: tasks.map(task => task.id), message: '已找到原任务，请继续查询原任务。' };
  const sync = await tx.platformSetting.findUnique({ where: { key: `${SYNC_PREFIX}${account}:${requestId}` }, select: { value_json: true } });
  if (sync) {
    const value = JSON.parse(sync.value_json) as { schema?: unknown; ownerId?: unknown; requestId?: unknown; status?: unknown };
    if (value.schema !== 'image.sync-admission.v1' || value.ownerId !== account || value.requestId !== requestId
      || !['running', 'succeeded', 'failed', 'accepted_unknown'].includes(String(value.status))) {
      throw new StudioSubmitReceiptError('IMAGE_SUBMIT_EVIDENCE_UNAVAILABLE', '原同步受理记录暂时无法核对，请保留原编号', 503);
    }
    return { schema: IMAGE_SUBMIT_RECEIPT_SCHEMA, requestId, state: 'accepted', stage: 'synchronous-admission', taskIds: [], message: '原编号已有同步受理记录，请核对原结果；没有重新生成。' };
  }
  const parents = await tx.platformSetting.findMany({ where: { key: { in: BATCH_PREFIXES.map(prefix => `${prefix}${account}:${batchId}`) } }, select: { value_json: true } });
  if (parents.length) {
    for (const row of parents) {
      const parent = JSON.parse(row.value_json) as { id?: unknown; ownerId?: unknown; requestId?: unknown };
      if (parent.id !== batchId || parent.ownerId !== account || parent.requestId !== requestId) throw new StudioSubmitReceiptError('IMAGE_SUBMIT_EVIDENCE_UNAVAILABLE', '原批次记录暂时无法核对，请保留原编号', 503);
    }
    return { schema: IMAGE_SUBMIT_RECEIPT_SCHEMA, requestId, state: 'accepted', stage: 'batch-admission', batchId, taskIds: [], message: '已找到原批次，请继续查询原批次；未派发项不会因此重新创建。' };
  }
  const prepared = await tx.platformSetting.findFirst({ where: { OR: PREPARED_PREFIXES.map(prefix => ({ key: { startsWith: `${prefix}${batchId}:` } })) }, select: { id: true } });
  const fee = await tx.creditLedger.findFirst({ where: { user_id: account, OR: [
    { related_task_id: { in: [requestId, batchId] } }, { related_task_id: { startsWith: `${batchId}-` } }, { related_task_id: { startsWith: `rate-${batchId}-` } },
    { idempotency_key: { startsWith: `image-studio:freeze:${batchId}-` } }, { idempotency_key: { startsWith: `image-studio:freeze:rate-${batchId}-` } },
  ] }, select: { id: true } });
  const attempt = await tx.operationLog.findFirst({ where: { operator_id: account, action: 'image_generation_generate_attempt', target_type: 'ImageGeneration', target_id: requestId }, select: { id: true } });
  if (prepared || fee || attempt) return { schema: IMAGE_SUBMIT_RECEIPT_SCHEMA, requestId, state: 'unknown', code: 'IMAGE_SUBMIT_EVIDENCE_PENDING', stage: 'acceptance-evidence', message: '原编号已有素材准备、调用或费用证据，仍需核对；不能结束或重复生成。' };
  return null;
}
/** A response without original evidence stays unknown; HTTP status is not acceptance proof. */
export async function readStudioSubmitReceipt(account: string, requestId: string, client: Client = prisma): Promise<StudioSubmitReceipt> {
  if (!validStudioSubmitRequestId(requestId)) throw new StudioSubmitReceiptError('IMAGE_SUBMIT_REQUEST_INVALID', '原提交编号无效', 400);
  const accepted = await evidence(client, account, requestId);
  if (accepted) return accepted;
  const saved = await client.platformSetting.findUnique({ where: { key: studioSubmitReceiptKey(account, requestId) }, select: { value_json: true } });
  return saved ? projectReceipt(terminal(saved.value_json, account, requestId))
    : { schema: IMAGE_SUBMIT_RECEIPT_SCHEMA, requestId, state: 'unknown', stage: 'original-query', message: '尚未找到原受理或明确拒绝回执，请保留输入并核对原编号。' };
}
function writesEnabled() { return false; }
/** The caller supplies only a recognized pre-acceptance failure; no prompt text is stored. */
export async function rejectStudioSubmission(account: string, requestId: unknown, detail: { code: string; stage: string }): Promise<StudioSubmitReceipt | null> {
  if (!validStudioSubmitRequestId(requestId)) return null;
  if (!/^[A-Za-z0-9_]{1,100}$/.test(detail.code) || !/^[A-Za-z0-9_-]{1,80}$/.test(detail.stage)) return null;
  return prisma.$transaction(async tx => {
    const found = await evidence(tx, account, requestId);
    if (found) return null;
    const key = studioSubmitReceiptKey(account, requestId), saved = await tx.platformSetting.findUnique({ where: { key }, select: { value_json: true } });
    if (saved) return projectReceipt(terminal(saved.value_json, account, requestId));
    const receipt: TerminalReceipt = { schema: 'image.submit-receipt.v1', account, requestId, state: 'rejected', ...detail, createdAt: new Date().toISOString() };
    await tx.platformSetting.create({ data: { key, value_json: JSON.stringify(receipt), updated_by: account } });
    return projectReceipt(receipt);
  });
}
export async function closeStudioSubmission(account: string, requestId: string): Promise<StudioSubmitReceipt> {
  if (!validStudioSubmitRequestId(requestId)) throw new StudioSubmitReceiptError('IMAGE_SUBMIT_REQUEST_INVALID', '原提交编号无效', 400);
  if (!writesEnabled()) throw new StudioSubmitReceiptError('IMAGE_SUBMIT_CLOSE_DISABLED', '当前版本暂不能结束原提交，请继续核对原编号', 503);
  return prisma.$transaction(async tx => {
    const found = await evidence(tx, account, requestId);
    if (found) return found;
    const key = studioSubmitReceiptKey(account, requestId), saved = await tx.platformSetting.findUnique({ where: { key }, select: { value_json: true } });
    if (saved) {
      const previous = terminal(saved.value_json, account, requestId);
      if (previous.state === 'closed') return projectReceipt(previous);
      const closed: TerminalReceipt = { ...previous, state: 'closed', code: 'IMAGE_SUBMIT_CLOSED', stage: 'explicit-close', createdAt: new Date().toISOString() };
      await tx.platformSetting.update({ where: { key }, data: { value_json: JSON.stringify(closed), updated_by: account } });
      return projectReceipt(closed);
    }
    const closed: TerminalReceipt = { schema: 'image.submit-receipt.v1', account, requestId, state: 'closed', code: 'IMAGE_SUBMIT_CLOSED', stage: 'explicit-close', createdAt: new Date().toISOString() };
    await tx.platformSetting.create({ data: { key, value_json: JSON.stringify(closed), updated_by: account } });
    return projectReceipt(closed);
  });
}
