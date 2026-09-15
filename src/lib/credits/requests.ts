import { randomBytes } from 'node:crypto';
import { Prisma, type User } from '@prisma/client';
import { prisma } from '../prisma';
import { getCreditSummary } from './policy';
import { createInAppNotification } from '../notifications';
import { canRequestCredits, CreditRequestError, validGrantAmount } from './request-rules';
import { creditApprovalCard, creditConfirmationCard, creditResultCard } from './request-cards';

const nonce = () => randomBytes(24).toString('hex');
export function creditRequestsConfigured() {
  return process.env.CREDIT_REQUESTS_ENABLED === 'true'
    && Boolean(process.env.CREDIT_REQUEST_APPROVER_ID && process.env.FEISHU_APP_ID
      && process.env.FEISHU_APP_SECRET && process.env.FEISHU_ALLOWED_TENANT_KEY
      && (process.env.CREDIT_CALLBACK_MODE === 'relay-v1'
        || (process.env.FEISHU_CREDIT_ENCRYPT_KEY && process.env.FEISHU_CREDIT_VERIFICATION_TOKEN)));
}

function active(user: User | null): asserts user is User {
  if (!user || user.status !== 'active' || (user.expires_at && user.expires_at <= new Date())) {
    throw new CreditRequestError('账号当前不可用', 403);
  }
}

async function parties(tx: Prisma.TransactionClient, userId: string, approverId: string) {
  const user = await tx.user.findUnique({ where: { id: userId } });
  const approver = await tx.user.findUnique({ where: { id: approverId } });
  active(user); active(approver);
  if (approver.role !== 'admin' || approverId !== process.env.CREDIT_REQUEST_APPROVER_ID) {
    throw new CreditRequestError('审批人配置已变更，请联系管理员', 403);
  }
  const tenant = process.env.FEISHU_ALLOWED_TENANT_KEY;
  if (user.account_type !== 'internal' || !user.feishu_open_id || !approver.feishu_open_id
    || !tenant || user.feishu_tenant_key !== tenant || approver.feishu_tenant_key !== tenant) {
    throw new CreditRequestError('请使用已绑定公司飞书的有效账号', 403);
  }
  return { user, approver };
}

export async function submitCreditRequest(userId: string, purpose: unknown) {
  if (!creditRequestsConfigured()) throw new CreditRequestError('积分申请暂未开放，请联系管理员', 503);
  if (typeof purpose !== 'string' || !purpose.trim() || purpose.trim().length > 300) {
    throw new CreditRequestError('请填写 1 至 300 字的用途');
  }
  try {
    return await prisma.$transaction(async (tx) => {
      const { user, approver } = await parties(tx, userId, process.env.CREDIT_REQUEST_APPROVER_ID!);
      const existing = await tx.creditRequest.findUnique({ where: { pending_key: userId } });
      if (existing) return existing;
      const summary = await getCreditSummary(tx, user);
      if (!canRequestCredits(summary.available)) throw new CreditRequestError('可用积分少于 500 点时才可申请', 409);
      const recent = await tx.creditRequest.findFirst({ where: { user_id: userId, created_at: { gte: new Date(Date.now() - 60_000) } } });
      if (recent) throw new CreditRequestError('提交过于频繁，请一分钟后重试', 429);
      const request = await tx.creditRequest.create({ data: {
        user_id: userId, approver_id: approver.id, pending_key: userId, purpose: purpose.trim(),
        available_at_submit: summary.available, nonce: nonce(), applicant_open_id: user.feishu_open_id!,
        approver_open_id: approver.feishu_open_id!, tenant_key: user.feishu_tenant_key!, app_id: process.env.FEISHU_APP_ID!,
      } });
      const card = creditApprovalCard({ id: request.id, nonce: request.nonce, name: user.name, purpose: request.purpose, available: summary.available });
      await tx.creditRequestDelivery.create({ data: {
        request_id: request.id, kind: 'approval',
        payload_json: JSON.stringify({ receive_id: request.approver_open_id, msg_type: 'interactive', content: JSON.stringify(card) }),
      } });
      await createInAppNotification(tx, { targetUserId: approver.id, actorUserId: userId, type: 'credit_request',
        title: '收到积分申请', body: request.purpose, metadata: { request_id: request.id, href: '/points' } });
      await tx.operationLog.create({ data: { operator_id: userId, action: 'credit_request_submit', target_type: 'CreditRequest', target_id: request.id } });
      return request;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const existing = await prisma.creditRequest.findUnique({ where: { pending_key: userId } });
      if (existing) return existing;
    }
    throw error;
  }
}

export async function handleCreditDecision(input: {
  requestId: string; actorId?: string; openId?: string; nonce?: string;
  action: 'prepare' | 'confirm' | 'back' | 'reject' | 'withdraw';
  amount?: unknown; confirmationNonce?: string; reason?: string;
}) {
  if (input.action !== 'withdraw' && !creditRequestsConfigured()) throw new CreditRequestError('积分审批暂不可用', 503);
  return prisma.$transaction(async (tx) => {
    const request = await tx.creditRequest.findUnique({ where: { id: input.requestId } });
    if (!request) throw new CreditRequestError('申请不存在', 404);
    const withdrawing = input.action === 'withdraw';
    if (withdrawing) {
      if (input.actorId !== request.user_id) throw new CreditRequestError('无权撤回这条申请', 403);
    } else {
      if (input.actorId ? input.actorId !== request.approver_id : !input.openId || input.openId !== request.approver_open_id || input.nonce !== request.nonce) {
        throw new CreditRequestError('无权审批这条申请', 403);
      }
    }
    if (request.status !== 'pending') return { message: '申请已经处理，无需重复操作', card: creditResultCard('申请已经处理，无需重复操作') };
    if (withdrawing) {
      const user = await tx.user.findUnique({ where: { id: input.actorId } });
      active(user);
      const claimed = await tx.creditRequest.updateMany({ where: { id: request.id, status: 'pending' }, data: {
        status: 'withdrawn', pending_key: null, decided_at: new Date(), confirmation_nonce: null, confirmation_until: null,
      } });
      if (claimed.count !== 1) throw new CreditRequestError('申请已经处理，请刷新', 409);
      await tx.creditRequestDelivery.updateMany({ where: { request_id: request.id, kind: 'approval', status: { in: ['pending', 'retry'] } },
        data: { status: 'cancelled', lease_until: null, lease_token: null } });
      await tx.operationLog.create({ data: { operator_id: user.id, action: 'credit_request_withdrawn', target_type: 'CreditRequest', target_id: request.id } });
      return { message: '申请已撤回', card: creditResultCard('申请已撤回') };
    }
    const { user, approver } = await parties(tx, request.user_id, request.approver_id);
    if (request.app_id !== process.env.FEISHU_APP_ID || user.feishu_open_id !== request.applicant_open_id
      || approver.feishu_open_id !== request.approver_open_id || user.feishu_tenant_key !== request.tenant_key) {
      throw new CreditRequestError('飞书身份发生变更，请联系管理员', 409);
    }
    const summary = await getCreditSummary(tx, user);
    if (input.action === 'prepare') {
      if (!validGrantAmount(input.amount)) throw new CreditRequestError('请选择有效的发放额度');
      const confirmationNonce = nonce();
      await tx.creditRequest.update({ where: { id: request.id }, data: {
        proposed_amount: input.amount, confirmation_nonce: confirmationNonce, confirmation_until: new Date(Date.now() + 300_000),
      } });
      return { message: '请确认发放额度', confirmationNonce, amount: input.amount, available: summary.available,
        card: creditConfirmationCard({ id: request.id, nonce: request.nonce, confirmationNonce, amount: input.amount, name: user.name, available: summary.available }) };
    }
    if (input.action === 'back') {
      await tx.creditRequest.update({ where: { id: request.id }, data: { confirmation_nonce: null, confirmation_until: null, proposed_amount: null } });
      return { message: '请选择发放额度', card: creditApprovalCard({ id: request.id, nonce: request.nonce, purpose: request.purpose, name: user.name, available: request.available_at_submit }) };
    }
    if (!['confirm', 'reject', 'withdraw'].includes(input.action)) throw new CreditRequestError('不支持此操作');
    if (input.action === 'confirm' && (!validGrantAmount(request.proposed_amount)
      || !input.confirmationNonce || request.confirmation_nonce !== input.confirmationNonce
      || !request.confirmation_until || request.confirmation_until <= new Date())) {
      throw new CreditRequestError('确认已过期，请重新选择额度', 409);
    }
    const status = withdrawing ? 'withdrawn' : input.action === 'reject' ? 'rejected' : 'approved';
    const amount = status === 'approved' ? request.proposed_amount! : null;
    const reason = (typeof input.reason === 'string' && input.reason.trim() ? input.reason : '暂不发放，请联系管理员了解详情').trim().slice(0, 300);
    // A single conditional transition owns the grant. The balance, ledger and outbox commit together.
    const claimed = await tx.creditRequest.updateMany({ where: { id: request.id, status: 'pending' }, data: {
      status, amount, pending_key: null, decided_at: new Date(), confirmation_nonce: null, confirmation_until: null,
      decision_reason: status === 'rejected' ? reason : null,
    } });
    if (claimed.count !== 1) throw new CreditRequestError('申请已经处理，请刷新', 409);
    if (amount !== null) {
      const account = await tx.creditAccount.update({ where: { user_id: user.id }, data: { balance: { increment: amount } } });
      await tx.creditLedger.create({ data: {
        user_id: user.id, type: 'admin_grant', amount, balance_before: account.balance - amount, balance_after: account.balance,
        frozen_before: account.frozen_credits, frozen_after: account.frozen_credits, operator_id: approver.id,
        reason: `积分申请：${request.purpose}`, idempotency_key: `credit_request:${request.id}`,
        metadata_json: JSON.stringify({ request_id: request.id, scope: 'long_term_balance' }),
      } });
    }
    const message = status === 'approved' ? `已到账 ${amount} 点；到账时可用 ${summary.available + amount!} 点`
      : status === 'rejected' ? `申请未通过：${reason}` : '申请已撤回';
    await tx.operationLog.create({ data: { operator_id: withdrawing ? user.id : approver.id,
      action: `credit_request_${status}`, target_type: 'CreditRequest', target_id: request.id,
      detail: JSON.stringify({ amount, reason: status === 'rejected' ? reason : null }) } });
    await createInAppNotification(tx, { targetUserId: user.id, actorUserId: withdrawing ? user.id : approver.id,
      type: 'credit_request_result', title: '积分申请结果', body: message, metadata: { request_id: request.id } });
    await tx.creditRequestDelivery.create({ data: { request_id: request.id, kind: 'result',
      payload_json: JSON.stringify({ receive_id: request.applicant_open_id, msg_type: 'text', content: JSON.stringify({ text: `SD2 积分申请\n${message}` }) }) } });
    return { message, card: creditResultCard(message) };
  }, { timeout: 2500 });
}

export async function listCreditRequests(userId: string, cursor?: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  active(user);
  const canApprove = user.role === 'admin' && user.id === process.env.CREDIT_REQUEST_APPROVER_ID;
  const select = { id: true, user_id: true, approver_id: true, status: true, purpose: true, available_at_submit: true,
    amount: true, decision_reason: true, created_at: true, decided_at: true,
    requester: { select: { name: true, avatar_url: true } },
    deliveries: { select: { kind: true, status: true, error_code: true } } } satisfies Prisma.CreditRequestSelect;
  const requests = await prisma.creditRequest.findMany({
    where: canApprove ? { OR: [{ user_id: userId }, { approver_id: userId }] } : { user_id: userId },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: 31,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), select,
  });
  const pendingRequest = await prisma.creditRequest.findUnique({ where: { pending_key: userId }, select });
  const pendingCount = canApprove ? await prisma.creditRequest.count({ where: { approver_id: userId, status: 'pending' } }) : (pendingRequest ? 1 : 0);
  const page = requests.slice(0, 30);
  return { enabled: creditRequestsConfigured(), canApprove, requests: page, pendingRequest, pendingCount,
    nextCursor: requests.length > 30 ? page[page.length - 1].id : null };
}
