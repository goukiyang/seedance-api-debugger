import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

const PREFIX = 'image_sync_request_v1:';
type Client = Pick<Prisma.TransactionClient, 'platformSetting'>;
export class SynchronousImageAdmissionError extends Error {
  constructor(message: string, public readonly status: number, public readonly requestId?: string) { super(message); }
}
type SyncImageAdmission = {
  schema: 'image.sync-admission.v1';
  ownerId: string;
  requestId: string;
  fingerprint: string;
  count: number;
  model: string;
  scope: string;
  status: 'running' | 'succeeded' | 'failed' | 'accepted_unknown';
  createdAt: string;
  finishedAt: string | null;
};

function parse(value: string): SyncImageAdmission {
  const row = JSON.parse(value) as SyncImageAdmission;
  if (row.schema !== 'image.sync-admission.v1' || typeof row.ownerId !== 'string'
    || typeof row.requestId !== 'string' || !Number.isSafeInteger(row.count) || row.count < 1 || row.count > 8
    || !['running', 'succeeded', 'failed', 'accepted_unknown'].includes(row.status)) throw new Error('同步图片请求记录无法核对，未派发生成');
  return row;
}

/** Execution capacity only: an ended Promise with unknown acceptance isn't running. */
export async function countSynchronousImageAdmissions(tx: Client, ownerId: string): Promise<number> {
  const rows = await tx.platformSetting.findMany({
    where: { key: { startsWith: `${PREFIX}${ownerId}:` }, value_json: { contains: '"status":"running"' } }, select: { value_json: true },
  });
  return rows.reduce((sum, row) => {
    const record = parse(row.value_json);
    return sum + (record.ownerId === ownerId && record.status === 'running' ? record.count : 0);
  }, 0);
}

/** Must be called in the same transaction as the shared capacity reservation. */
export async function assertNoSynchronousImageAdmission(tx: Client, ownerId: string, requestId: string) {
  const existing = await tx.platformSetting.findUnique({ where: { key: `${PREFIX}${ownerId}:${requestId}` }, select: { value_json: true } });
  if (!existing) return;
  parse(existing.value_json);
  throw new SynchronousImageAdmissionError('此编号已有同步图片请求，请核对原结果；没有重新生成', 409, requestId);
}

export async function createSynchronousImageAdmission(tx: Client & Pick<Prisma.TransactionClient, 'imageStudioTask'>, input: {
  ownerId: string; requestId?: string; fingerprint: string; count: number; model: string; scope: string;
}) {
  const requestId = input.requestId || `sync-${randomUUID()}`;
  if (!/^[a-zA-Z0-9-]{16,100}$/.test(requestId)) throw new SynchronousImageAdmissionError('图片请求编号无效，未派发生成', 400);
  const key = `${PREFIX}${input.ownerId}:${requestId}`;
  const queued = await tx.imageStudioTask.findFirst({ where: { owner_id: input.ownerId,
    batch_id: createHash('sha256').update(`${input.ownerId}:${requestId}`).digest('hex') }, select: { id: true } });
  if (queued) throw new SynchronousImageAdmissionError('此编号已有排队图片请求，请查询原任务；没有重新生成', 409, requestId);
  const existing = await tx.platformSetting.findUnique({ where: { key }, select: { value_json: true } });
  if (existing) {
    const record = parse(existing.value_json);
    // No automatic POST replay, including a previously timed-out HTTP handler.
    throw new SynchronousImageAdmissionError(record.fingerprint === input.fingerprint
      ? '此同步图片请求已有记录，请先核对原结果；没有重新生成'
      : '图片请求编号已用于其他设置，请核对原请求；没有重新生成', 409, requestId);
  }
  const record: SyncImageAdmission = { schema: 'image.sync-admission.v1', ...input, requestId,
    status: 'running', createdAt: new Date().toISOString(), finishedAt: null };
  await tx.platformSetting.create({ data: { key, value_json: JSON.stringify(record), updated_by: input.ownerId } });
  return { key, requestId };
}

/** Called only after the complete server-side generation Promise has settled. */
export async function finishSynchronousImageAdmission(admission: { key: string }, status: SyncImageAdmission['status']) {
  if (status === 'running') throw new Error('不能把未结束请求当作终态');
  await prisma.$transaction(async tx => {
    const saved = await tx.platformSetting.findUnique({ where: { key: admission.key }, select: { value_json: true } });
    if (!saved) throw new Error('同步图片请求记录缺失');
    const record = parse(saved.value_json);
    if (record.status !== 'running') return;
    const updated = await tx.platformSetting.updateMany({ where: { key: admission.key, value_json: saved.value_json },
      data: { value_json: JSON.stringify({ ...record, status, finishedAt: new Date().toISOString() }) } });
    if (updated.count) await tx.operationLog.create({ data: {
      operator_id: record.ownerId, action: 'image_generation_generate_attempt', target_type: 'ImageGeneration', target_id: record.requestId,
      detail: JSON.stringify({ status, request_id: record.requestId, count: record.count, model: record.model,
        billing_scope: record.scope, synchronous_request: true,
        ...(status === 'accepted_unknown' ? { message: '服务端调用已结束；供应商受理与费用待核。没有自动重发，也未据此确认退款。' } : {}) }),
    } });
  });
}
