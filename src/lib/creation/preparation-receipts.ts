import { prisma } from '@/lib/prisma';
import type { SessionUser } from '@/lib/auth/session';
import { pricingFingerprint } from '@/lib/pricing/catalog';
import { CreationError, creationIdentity } from './contract';
import { readCreationOperation, writeCreationOperation } from './receipts';
import type { CreationDb } from './context';
const target = 'video-intent-prepare';
function business(body: Record<string, unknown>) {
  const { pricing_quote_token: _token, expected_revision: _revision, ...input } = body;
  return { hash: pricingFingerprint(input) };
}
export async function originalPreparationRejection(db: CreationDb, userId: string, requestId: string) {
  return readCreationOperation(db, userId, target, requestId);
}
export async function assertNoPreparationRejection(db: CreationDb, userId: string, requestId: string, body: Record<string, unknown>) {
  const receipt = await readCreationOperation(db, userId, target, requestId, business(body));
  if (receipt) throw new CreationError('原准备请求在任务受理前已明确拒绝，请主动发起新的准备；输入保留', 409, 'creation_preparation_rejected', 'request_id', 'query_original');
}
/** Only a proven pre-intent 4xx is sealed. Unknown/timeout/race never becomes a rejection. */
export async function recordPreparationRejection(user: SessionUser, body: Record<string, unknown>, status: number, code?: string) {
  if (![400, 403, 404, 422, 426].includes(status)) return;
  let requestId: string;
  try { requestId = creationIdentity(body.request_id, 'request_id')!; } catch { return; }
  await prisma.$transaction(async db => {
    if (await db.videoCreationIntent.findUnique({ where: { owner_id_request_id: { owner_id: user.id, request_id: requestId } }, select: { id: true } })) return;
    await writeCreationOperation(db, user.id, target, requestId, business(body), 'rejected', {
      code: code || 'creation_prepare_invalid', http_status: status, message: '本次准备在任务受理前已明确拒绝，未生成、未扣点；当前输入保留',
    });
  });
}
