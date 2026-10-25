import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { creditRequestsConfigured, parties } from '../credits/requests';
import { CreditRequestError, MULTIVIEW_1080P_KIND, MULTIVIEW_1080P_TTL_MS } from '../credits/request-rules';
import { multiview1080pApprovalCard } from '../credits/request-cards';
import { createInAppNotification } from '../notifications';

export const MULTIVIEW_1080P_APPROVAL_REQUIRED = 'MULTIVIEW_1080P_APPROVAL_REQUIRED';
export const MULTIVIEW_1080P_REQUIRED_MESSAGE = '3D多视图 1080p 每次都需要管理员在飞书同意，请先申请；没有提交，没有扣点。';
type Db = Prisma.TransactionClient | typeof prisma;

/** Only the configured approver (the person who pays) generates 1080p without asking. */
export function multiview1080pExempt(userId: string) {
  return Boolean(process.env.CREDIT_REQUEST_APPROVER_ID) && userId === process.env.CREDIT_REQUEST_APPROVER_ID;
}
const pendingKey = (userId: string) => `${MULTIVIEW_1080P_KIND}:${userId}`;
const usable = (userId: string, now: Date) => ({ user_id: userId, kind: MULTIVIEW_1080P_KIND, status: 'approved', used_at: null, expires_at: { gt: now } });

export async function readMultiview1080pState(userId: string) {
  if (multiview1080pExempt(userId)) return { exempt: true, state: 'approved' as const };
  const now = new Date();
  const approved = await prisma.creditRequest.findFirst({ where: usable(userId, now), orderBy: { decided_at: 'asc' }, select: { id: true, expires_at: true } });
  if (approved) return { exempt: false, state: 'approved' as const, requestId: approved.id, expiresAt: approved.expires_at };
  const pending = await prisma.creditRequest.findUnique({ where: { pending_key: pendingKey(userId) }, select: { id: true, created_at: true } });
  if (pending && pending.created_at.getTime() + MULTIVIEW_1080P_TTL_MS > now.getTime()) {
    return { exempt: false, state: 'pending' as const, requestId: pending.id, expiresAt: new Date(pending.created_at.getTime() + MULTIVIEW_1080P_TTL_MS) };
  }
  const last = await prisma.creditRequest.findFirst({ where: { user_id: userId, kind: MULTIVIEW_1080P_KIND }, orderBy: { created_at: 'desc' },
    select: { status: true, decision_reason: true, expires_at: true, used_at: true } });
  const lastState = !last ? null : last.status === 'rejected' ? 'rejected' : last.status === 'used' ? 'used'
    : last.status === 'approved' || last.status === 'expired' || last.status === 'pending' ? 'expired' : null;
  return { exempt: false, state: 'none' as const, enabled: creditRequestsConfigured(), lastState,
    ...(lastState === 'rejected' && last?.decision_reason ? { reason: last.decision_reason } : {}) };
}

export async function submitMultiview1080pRequest(userId: string, purpose: unknown) {
  if (multiview1080pExempt(userId)) throw new CreditRequestError('你可以直接使用 1080p，无需申请', 409);
  if (!creditRequestsConfigured()) throw new CreditRequestError('1080p 申请暂未开放，请联系管理员', 503);
  if (typeof purpose !== 'string' || !purpose.trim() || purpose.trim().length > 200) throw new CreditRequestError('请填写 1 至 200 字的用途');
  return prisma.$transaction(async (tx) => {
    const now = new Date();
    const { user, approver } = await parties(tx, userId, process.env.CREDIT_REQUEST_APPROVER_ID!);
    if (await tx.creditRequest.findFirst({ where: usable(userId, now), select: { id: true } })) throw new CreditRequestError('已有一次可用的 1080p，请直接生成', 409);
    const existing = await tx.creditRequest.findUnique({ where: { pending_key: pendingKey(userId) } });
    if (existing && existing.created_at.getTime() + MULTIVIEW_1080P_TTL_MS > now.getTime()) return existing;
    if (existing) await tx.creditRequest.updateMany({ where: { id: existing.id, status: 'pending' }, data: { status: 'expired', pending_key: null, decided_at: now } });
    const recent = await tx.creditRequest.findFirst({ where: { user_id: userId, kind: MULTIVIEW_1080P_KIND, created_at: { gte: new Date(now.getTime() - 60_000) } } });
    if (recent) throw new CreditRequestError('提交过于频繁，请一分钟后重试', 429);
    const request = await tx.creditRequest.create({ data: {
      kind: MULTIVIEW_1080P_KIND, user_id: userId, approver_id: approver.id, pending_key: pendingKey(userId), purpose: purpose.trim(),
      available_at_submit: 0, nonce: randomBytes(24).toString('hex'), applicant_open_id: user.feishu_open_id!,
      approver_open_id: approver.feishu_open_id!, tenant_key: user.feishu_tenant_key!, app_id: process.env.FEISHU_APP_ID!,
    } });
    const card = multiview1080pApprovalCard({ id: request.id, nonce: request.nonce, name: user.name, purpose: request.purpose });
    await tx.creditRequestDelivery.create({ data: { request_id: request.id, kind: 'approval',
      payload_json: JSON.stringify({ receive_id: request.approver_open_id, msg_type: 'interactive', content: JSON.stringify(card) }) } });
    await createInAppNotification(tx, { targetUserId: approver.id, actorUserId: userId, type: 'credit_request',
      title: '收到 3D多视图 1080p 申请', body: request.purpose, metadata: { request_id: request.id, href: '/multiview' } });
    await tx.operationLog.create({ data: { operator_id: userId, action: 'multiview_1080p_request_submit', target_type: 'CreditRequest', target_id: request.id } });
    return request;
  });
}

/** True when this user may submit a 1080p multiview generation now (read-only pre-check). */
export async function hasMultiview1080pApproval(userId: string, db: Db = prisma) {
  return multiview1080pExempt(userId) || Boolean(await db.creditRequest.findFirst({ where: usable(userId, new Date()), select: { id: true } }));
}

/** Uses one approval inside the task-creation transaction; a rolled-back creation keeps it unused. */
export async function consumeMultiview1080pApproval(tx: Prisma.TransactionClient, userId: string, requestKey: string | null) {
  if (multiview1080pExempt(userId)) return null;
  const now = new Date();
  const approval = await tx.creditRequest.findFirst({ where: usable(userId, now), orderBy: { decided_at: 'asc' }, select: { id: true } });
  const claimed = approval ? await tx.creditRequest.updateMany({ where: { id: approval.id, status: 'approved', used_at: null },
    data: { status: 'used', used_at: now, used_request_key: requestKey } }) : { count: 0 };
  return claimed.count === 1 ? approval!.id : false;
}
