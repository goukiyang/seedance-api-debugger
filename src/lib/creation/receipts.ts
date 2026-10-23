import type { Prisma } from '@prisma/client';
import { pricingFingerprint } from '@/lib/pricing/catalog';
import { CreationError, creationIdentity } from './contract';

type ReceiptState = 'accepted' | 'rejected' | 'closed';
export type CreationOperationReceipt = { version: 1; ownerId: string; targetId: string; requestId: string;
  hash: string; state: ReceiptState; result: Record<string, unknown>; observedAt: string };
export const creationOperationKey = (owner: string, target: string, request: string) =>
  'video-creation-operation:v1:' + pricingFingerprint([owner, target, request]);
export async function readCreationOperation(tx: Prisma.TransactionClient, ownerId: string, targetId: string, requestId: string, input?: unknown) {
  creationIdentity(requestId, 'request_id');
  const row = await tx.platformSetting.findUnique({ where: { key: creationOperationKey(ownerId, targetId, requestId) } });
  if (!row) return null;
  const value = JSON.parse(row.value_json) as CreationOperationReceipt;
  if (value.version !== 1 || value.ownerId !== ownerId || value.targetId !== targetId || value.requestId !== requestId
    || !['accepted', 'rejected', 'closed'].includes(value.state)) throw new CreationError('原操作回执无法确认，请保留原请求号', 503, 'creation_receipt_invalid', 'request_id', 'query_original');
  if (input !== undefined && value.hash !== pricingFingerprint(input)) throw new CreationError('此原操作号已绑定不同内容，请核对原结果', 409, 'creation_operation_conflict', 'request_id', 'query_original');
  return value;
}
export async function writeCreationOperation(tx: Prisma.TransactionClient, ownerId: string, targetId: string, requestId: string,
  input: unknown, state: ReceiptState, result: Record<string, unknown>) {
  const previous = await readCreationOperation(tx, ownerId, targetId, requestId, input);
  if (previous) return previous;
  const value: CreationOperationReceipt = { version: 1, ownerId, targetId, requestId, hash: pricingFingerprint(input), state, result, observedAt: new Date().toISOString() };
  await tx.platformSetting.create({ data: { key: creationOperationKey(ownerId, targetId, requestId), value_json: JSON.stringify(value), updated_by: ownerId } });
  return value;
}
